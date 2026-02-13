import { decodeAudio } from './audio.js';

// v5: true filter-based 3-band waveform (low/mid/high) using OfflineAudioContext.
// Baseline-up UI expects peaksLow/peaksMid/peaksHigh arrays in 0..1.
// This version applies perceptual weighting so highs are more visible.
// computeWaveformBands is async (returns a Promise).

const WAVEFORM_VERSION = '2026-01-30-waveform-v5-true-biquad-3band-highboost-plus';

const WAVEFORM_BUCKETS = 600;

const LOW_CUTOFF_HZ = 200;

const HIGH_CUTOFF_HZ = 2000;

// True bandpass mid; choose center/Q to roughly cover 200..2000 Hz.
const MID_CENTER_HZ = Math.sqrt(LOW_CUTOFF_HZ * HIGH_CUTOFF_HZ);
const MID_Q = MID_CENTER_HZ / (HIGH_CUTOFF_HZ - LOW_CUTOFF_HZ);

// Version A (stronger highs)
const LOW_WEIGHT = 1.0;
const MID_WEIGHT = 1.05;
const HIGH_WEIGHT = 3.20;

const waveformCache = new Map();
const waveformInFlight = new Map();

function waveformCacheKey(url) {
  return `${url}|${WAVEFORM_VERSION}|${WAVEFORM_BUCKETS}|${LOW_CUTOFF_HZ}|${HIGH_CUTOFF_HZ}|${MID_CENTER_HZ.toFixed(2)}|${MID_Q.toFixed(4)}|${LOW_WEIGHT}|${MID_WEIGHT}|${HIGH_WEIGHT}`;
}

function clamp01(v) {
  const x = Number(v || 0);
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function bucketRms(samples, buckets) {
  const total = samples.length;
  const out = new Float32Array(buckets);
  if (!total) return out;

  const win = Math.max(1, Math.floor(total / buckets));
  const stride = Math.max(1, Math.floor(win / 256));

  for (let b = 0; b < buckets; b++) {
    const s0 = b * win;
    const s1 = Math.min(total, s0 + win);
    let sumSq = 0;
    let c = 0;
    for (let i = s0; i < s1; i += stride) {
      const v = samples[i] || 0;
      sumSq += v * v;
      c++;
    }
    out[b] = Math.sqrt(sumSq / Math.max(1, c));
  }

  return out;
}

function sharedNormalize(low, mid, high) {
  const n = Math.max(low.length, mid.length, high.length);
  let maxSum = 1e-9;

  for (let i = 0; i < n; i++) {
    const s = (low[i] || 0) + (mid[i] || 0) + (high[i] || 0);
    if (s > maxSum) maxSum = s;
  }

  const inv = 1 / maxSum;
  const outLow = new Array(n);
  const outMid = new Array(n);
  const outHigh = new Array(n);

  for (let i = 0; i < n; i++) {
    outLow[i] = clamp01((low[i] || 0) * inv);
    outMid[i] = clamp01((mid[i] || 0) * inv);
    outHigh[i] = clamp01((high[i] || 0) * inv);
  }

  return { outLow, outMid, outHigh };
}

async function render3BandOffline(audioBuffer) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext not available');

  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;

  // Render into 3 channels: [low, mid, high]
  const ctx = new Offline(3, total, sr);

  const src = new AudioBufferSourceNode(ctx, { buffer: audioBuffer });

  // Mix to mono
  const chs = Math.max(1, audioBuffer.numberOfChannels);
  const splitter = new ChannelSplitterNode(ctx, { numberOfOutputs: chs });
  const mono = new GainNode(ctx, { gain: 1 });

  src.connect(splitter);
  for (let ch = 0; ch < chs; ch++) {
    const g = new GainNode(ctx, { gain: 1 / chs });
    splitter.connect(g, ch);
    g.connect(mono);
  }

  const lowF = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: LOW_CUTOFF_HZ, Q: 0.707 });
  const midF = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: MID_CENTER_HZ, Q: MID_Q });
  const highF = new BiquadFilterNode(ctx, { type: 'highpass', frequency: HIGH_CUTOFF_HZ, Q: 0.707 });

  mono.connect(lowF);
  mono.connect(midF);
  mono.connect(highF);

  const merger = new ChannelMergerNode(ctx, { numberOfInputs: 3 });
  lowF.connect(merger, 0, 0);
  midF.connect(merger, 0, 1);
  highF.connect(merger, 0, 2);

  merger.connect(ctx.destination);
  src.start(0);

  const rendered = await ctx.startRendering();

  return {
    low: rendered.getChannelData(0),
    mid: rendered.getChannelData(1),
    high: rendered.getChannelData(2),
    duration: Number.isFinite(rendered.duration) ? rendered.duration : (audioBuffer.duration || 0),
  };
}

export async function computeWaveformBands(audioBuffer, buckets = WAVEFORM_BUCKETS) {
  const total = audioBuffer?.length || 0;

  const peaksLow = new Float32Array(buckets);
  const peaksMid = new Float32Array(buckets);
  const peaksHigh = new Float32Array(buckets);

  if (!total || !Number.isFinite(total) || total <= 0) {
    return {
      peaksLow: Array.from(peaksLow),
      peaksMid: Array.from(peaksMid),
      peaksHigh: Array.from(peaksHigh),
      duration: audioBuffer?.duration || 0,
      buckets,
    };
  }

  try {
    const bands = await render3BandOffline(audioBuffer);

    const eLow = bucketRms(bands.low, buckets);
    const eMid = bucketRms(bands.mid, buckets);
    const eHigh = bucketRms(bands.high, buckets);

    for (let i = 0; i < buckets; i++) {
      eLow[i] *= LOW_WEIGHT;
      eMid[i] *= MID_WEIGHT;
      eHigh[i] *= HIGH_WEIGHT;
    }

    const { outLow, outMid, outHigh } = sharedNormalize(eLow, eMid, eHigh);

    return {
      peaksLow: outLow,
      peaksMid: outMid,
      peaksHigh: outHigh,
      duration: bands.duration,
      buckets,
    };
  } catch (_err) {
    // Fallback: fast split if OfflineAudioContext isn't available.
    const sr = audioBuffer.sampleRate;
    const chs = audioBuffer.numberOfChannels;

    const channels = [];
    for (let ch = 0; ch < chs; ch++) channels.push(audioBuffer.getChannelData(ch));

    const maxPoints = buckets * 256;
    const step = Math.max(1, Math.floor(total / maxPoints));

    const alpha = (cut) => {
      const dt = 1 / sr;
      const rc = 1 / (2 * Math.PI * cut);
      return dt / (rc + dt);
    };

    const aLow = alpha(LOW_CUTOFF_HZ);
    const aMid = alpha(HIGH_CUTOFF_HZ);

    let lpLow = 0;
    let lpMid = 0;

    for (let i = 0; i < total; i += step) {
      let x = 0;
      for (let ch = 0; ch < chs; ch++) x += channels[ch][i] || 0;
      x /= Math.max(1, chs);

      lpLow += aLow * (x - lpLow);
      lpMid += aMid * (x - lpMid);

      const low = lpLow;
      const mid = lpMid - lpLow;
      const high = x - lpMid;

      const b = Math.min(buckets - 1, Math.floor((i / Math.max(1, total - 1)) * buckets));

      const al = Math.abs(low) * LOW_WEIGHT;
      const am = Math.abs(mid) * MID_WEIGHT;
      const ah = Math.abs(high) * HIGH_WEIGHT;

      if (al > peaksLow[b]) peaksLow[b] = al;
      if (am > peaksMid[b]) peaksMid[b] = am;
      if (ah > peaksHigh[b]) peaksHigh[b] = ah;
    }

    const { outLow, outMid, outHigh } = sharedNormalize(peaksLow, peaksMid, peaksHigh);

    return {
      peaksLow: outLow,
      peaksMid: outMid,
      peaksHigh: outHigh,
      duration: Number.isFinite(audioBuffer.duration) ? audioBuffer.duration : 0,
      buckets,
    };
  }
}

export async function getWaveformForUrl(url) {
  const key = waveformCacheKey(url);

  const cached = waveformCache.get(key);
  if (cached && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) return cached;

  if (waveformInFlight.has(key)) return waveformInFlight.get(key);

  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await decodeAudio(arrayBuffer);

    const wf = await computeWaveformBands(audioBuffer, WAVEFORM_BUCKETS);
    const out = { ...wf, ts: Date.now() };

    waveformCache.set(key, out);
    return out;
  })().finally(() => waveformInFlight.delete(key));

  waveformInFlight.set(key, p);
  return p;
}
