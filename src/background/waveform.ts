/**
 * ============================================================================
 * WAVEFORM GENERATION
 * ============================================================================
 * 
 * 3-band waveform generator using OfflineAudioContext for precise filtering.
 * Generates low/mid/high frequency bands with perceptual weighting.
 * 
 * ALGORITHM:
 * - Uses biquad filters (lowpass, bandpass, highpass)
 * - Splits audio into 3 frequency bands: <200Hz, 200-2000Hz, >2000Hz
 * - Applies perceptual weights (highs boosted for visibility)
 * - Falls back to simple filter if OfflineAudioContext unavailable
 * 
 * CACHING:
 * - In-memory cache with 24-hour TTL
 * - Prevents duplicate fetches for same URL
 * 
 * @module background/waveform
 * @version 2026-02-15-typescript
 */

import { decodeAudio } from './audio.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const WAVEFORM_VERSION = '2026-01-30-waveform-v5-true-biquad-3band-highboost-plus';
const WAVEFORM_BUCKETS = 600;
const LOW_CUTOFF_HZ = 200;
const HIGH_CUTOFF_HZ = 2000;

// True bandpass mid; choose center/Q to roughly cover 200..2000 Hz
const MID_CENTER_HZ = Math.sqrt(LOW_CUTOFF_HZ * HIGH_CUTOFF_HZ);
const MID_Q = MID_CENTER_HZ / (HIGH_CUTOFF_HZ - LOW_CUTOFF_HZ);

// Perceptual weights (stronger highs for visibility)
const LOW_WEIGHT = 1.0;
const MID_WEIGHT = 1.05;
const HIGH_WEIGHT = 3.20;

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * 3-band waveform data
 */
export interface WaveformBands {
  peaksLow: number[];
  peaksMid: number[];
  peaksHigh: number[];
  duration: number;
  buckets: number;
}

/**
 * Cached waveform data with timestamp
 */
interface CachedWaveform extends WaveformBands {
  ts: number;
}

/**
 * Rendered 3-band audio data
 */
interface Rendered3Band {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  duration: number;
}

/**
 * Normalized 3-band data
 */
interface Normalized3Band {
  outLow: number[];
  outMid: number[];
  outHigh: number[];
}

// ============================================================================
// CACHING
// ============================================================================

const waveformCache = new Map<string, CachedWaveform>();
const waveformInFlight = new Map<string, Promise<CachedWaveform>>();

/**
 * Generate cache key from URL and configuration
 */
function waveformCacheKey(url: string): string {
  return `${url}|${WAVEFORM_VERSION}|${WAVEFORM_BUCKETS}|${LOW_CUTOFF_HZ}|${HIGH_CUTOFF_HZ}|${MID_CENTER_HZ.toFixed(2)}|${MID_Q.toFixed(4)}|${LOW_WEIGHT}|${MID_WEIGHT}|${HIGH_WEIGHT}`;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Clamp value to [0, 1] range
 */
function clamp01(v: number | null | undefined): number {
  const x = Number(v || 0);
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Compute RMS (root-mean-square) values for buckets
 */
function bucketRms(samples: Float32Array, buckets: number): Float32Array {
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

/**
 * Normalize 3 bands together (shared peak normalization)
 */
function sharedNormalize(
  low: Float32Array,
  mid: Float32Array,
  high: Float32Array
): Normalized3Band {
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

// ============================================================================
// 3-BAND FILTERING
// ============================================================================

/**
 * Render 3-band filtered audio using OfflineAudioContext
 * 
 * Uses Web Audio API biquad filters for precise frequency separation.
 * Outputs 3 channels: low, mid, high frequencies.
 */
async function render3BandOffline(audioBuffer: AudioBuffer): Promise<Rendered3Band> {
  const Offline = (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext not available');

  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;

  // Render into 3 channels: [low, mid, high]
  const ctx: OfflineAudioContext = new Offline(3, total, sr);
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

  // Create 3 frequency band filters
  const lowF = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: LOW_CUTOFF_HZ, Q: 0.707 });
  const midF = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: MID_CENTER_HZ, Q: MID_Q });
  const highF = new BiquadFilterNode(ctx, { type: 'highpass', frequency: HIGH_CUTOFF_HZ, Q: 0.707 });

  mono.connect(lowF);
  mono.connect(midF);
  mono.connect(highF);

  // Merge into 3-channel output
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

// ============================================================================
// WAVEFORM COMPUTATION
// ============================================================================

/**
 * Compute 3-band waveform from audio buffer
 * 
 * @param audioBuffer - Decoded audio buffer
 * @param buckets - Number of time buckets (default: 600)
 * @returns 3-band waveform data normalized to [0, 1]
 */
export async function computeWaveformBands(
  audioBuffer: AudioBuffer,
  buckets: number = WAVEFORM_BUCKETS
): Promise<WaveformBands> {
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
    // Primary method: OfflineAudioContext with biquad filters
    const bands = await render3BandOffline(audioBuffer);
    const eLow = bucketRms(bands.low, buckets);
    const eMid = bucketRms(bands.mid, buckets);
    const eHigh = bucketRms(bands.high, buckets);

    // Apply perceptual weights
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
    // Fallback: simple filter if OfflineAudioContext unavailable
    const sr = audioBuffer.sampleRate;
    const chs = audioBuffer.numberOfChannels;
    const channels: Float32Array[] = [];
    
    for (let ch = 0; ch < chs; ch++) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    const maxPoints = buckets * 256;
    const step = Math.max(1, Math.floor(total / maxPoints));

    // Simple 1-pole filter coefficient
    const alpha = (cut: number): number => {
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
      for (let ch = 0; ch < chs; ch++) {
        x += channels[ch][i] || 0;
      }
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

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get waveform data for audio URL (with caching)
 * 
 * Fetches audio, decodes it, and generates 3-band waveform.
 * Results are cached for 24 hours.
 * 
 * @param url - URL of audio file
 * @returns Promise resolving to cached waveform data
 */
export async function getWaveformForUrl(url: string): Promise<CachedWaveform> {
  const key = waveformCacheKey(url);
  
  // Check cache (24-hour TTL)
  const cached = waveformCache.get(key);
  if (cached && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000) {
    return cached;
  }

  // Check if already processing
  if (waveformInFlight.has(key)) {
    return waveformInFlight.get(key)!;
  }

  // Fetch and process
  const p = (async (): Promise<CachedWaveform> => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const audioBuffer = await decodeAudio(arrayBuffer);
    const wf = await computeWaveformBands(audioBuffer, WAVEFORM_BUCKETS);

    const out: CachedWaveform = { ...wf, ts: Date.now() };
    waveformCache.set(key, out);
    return out;
  })().finally(() => waveformInFlight.delete(key));

  waveformInFlight.set(key, p);
  return p;
}
