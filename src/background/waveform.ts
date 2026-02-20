/**
 * Generates and caches 3-band waveform envelopes (low/mid/high) for the UI.
 * Uses OfflineAudioContext band filtering with a fallback path when unavailable.
 */


import { decodeAudio } from './audio';


// ============================================================================
// CONFIGURATION
// ============================================================================


const WAVEFORM_VERSION = 'waveform-v2.5';
const WAVEFORM_BUCKETS = 300; // Reduced for speed
const LOW_CUTOFF_HZ = 200;
const HIGH_CUTOFF_HZ = 2000;

// Perceptual weights (highs boosted for visibility)
const LOW_WEIGHT = 1.0;
const MID_WEIGHT = 1.05;
const HIGH_WEIGHT = 3.20; // This makes highs more visible


// ============================================================================
// TYPE DEFINITIONS
// ============================================================================


export interface WaveformBands {
  peaksLow: number[];
  peaksMid: number[];
  peaksHigh: number[];
  duration: number;
  buckets: number;
}


interface CachedWaveform extends WaveformBands {
  ts: number;
}


interface Rendered3Band {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  duration: number;
}


// ============================================================================
// CACHING
// ============================================================================


const waveformCache = new Map<string, CachedWaveform>();
const waveformInFlight = new Map<string, Promise<CachedWaveform>>();


function waveformCacheKey(url: string, cacheIdentity?: string | null): string {
  const identity = String(cacheIdentity || '').trim() || String(url || '').trim();
  return `${identity}|${WAVEFORM_VERSION}|${WAVEFORM_BUCKETS}`;
}

function isFreshWaveform(cached: CachedWaveform | undefined): cached is CachedWaveform {
  return Boolean(cached && (Date.now() - cached.ts) < 24 * 60 * 60 * 1000);
}


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================


function clamp01(v: number | null | undefined): number {
  const x = Number(v || 0);
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}


/**
 * Shared normalization keeps relative visibility across low/mid/high bands.
 */
function sharedNormalize(
  low: Float32Array,
  mid: Float32Array,
  high: Float32Array
): { outLow: number[]; outMid: number[]; outHigh: number[] } {
  const n = Math.max(low.length, mid.length, high.length);
  let maxSum = 1e-9;

  // Find the maximum combined value across all bands
  for (let i = 0; i < n; i++) {
    const s = (low[i] || 0) + (mid[i] || 0) + (high[i] || 0);
    if (s > maxSum) maxSum = s;
  }

  const inv = 1 / maxSum;
  const outLow = new Array(n);
  const outMid = new Array(n);
  const outHigh = new Array(n);

  // Normalize all bands together (this preserves the weight relationships)
  for (let i = 0; i < n; i++) {
    outLow[i] = clamp01((low[i] || 0) * inv);
    outMid[i] = clamp01((mid[i] || 0) * inv);
    outHigh[i] = clamp01((high[i] || 0) * inv);
  }

  return { outLow, outMid, outHigh };
}


/**
 * Compute RMS values for buckets
 */
function bucketRms(samples: Float32Array, buckets: number): Float32Array {
  const total = samples.length;
  const out = new Float32Array(buckets);
  if (!total) return out;

  const win = Math.max(1, Math.floor(total / buckets));
  const stride = Math.max(1, Math.floor(win / 256)); // Reasonable sampling

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


// ============================================================================
// 3-BAND FILTERING WITH OFFLINEAUDIOCONTEXT (ORIGINAL METHOD)
// ============================================================================


/**
 * Uses OfflineAudioContext + biquad filters for clean frequency separation.
 */
async function render3BandOffline(audioBuffer: AudioBuffer): Promise<Rendered3Band> {
  const Offline = (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  if (!Offline) {
    throw new Error('OfflineAudioContext not available');
  }

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

  // Create 3 frequency band filters (original configuration)
  const lowF = new BiquadFilterNode(ctx, { 
    type: 'lowpass', 
    frequency: LOW_CUTOFF_HZ, 
    Q: 0.707 
  });
  
  const midF = new BiquadFilterNode(ctx, { 
    type: 'bandpass', 
    frequency: Math.sqrt(LOW_CUTOFF_HZ * HIGH_CUTOFF_HZ), // Geometric mean
    Q: Math.sqrt(LOW_CUTOFF_HZ * HIGH_CUTOFF_HZ) / (HIGH_CUTOFF_HZ - LOW_CUTOFF_HZ)
  });
  
  const highF = new BiquadFilterNode(ctx, { 
    type: 'highpass', 
    frequency: HIGH_CUTOFF_HZ, 
    Q: 0.707 
  });

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
// FAST FALLBACK (IF OFFLINEAUDIOCONTEXT UNAVAILABLE)
// ============================================================================


function render3BandFallback(audioBuffer: AudioBuffer): Rendered3Band {
  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;
  const chs = audioBuffer.numberOfChannels;
  
  const low = new Float32Array(total);
  const mid = new Float32Array(total);
  const high = new Float32Array(total);
  
  // Mix to mono first
  const mono = new Float32Array(total);
  for (let ch = 0; ch < chs; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < total; i++) {
      mono[i] += (data[i] || 0) / chs;
    }
  }
  
  // Simple 1-pole filters
  const dt = 1 / sr;
  const rcLow = 1 / (2 * Math.PI * LOW_CUTOFF_HZ);
  const rcHigh = 1 / (2 * Math.PI * HIGH_CUTOFF_HZ);
  const alphaLow = dt / (rcLow + dt);
  const alphaHigh = dt / (rcHigh + dt);
  
  let lpLow = 0;
  let lpHigh = 0;
  
  for (let i = 0; i < total; i++) {
    const x = mono[i];
    
    // Lowpass for low band
    lpLow += alphaLow * (x - lpLow);
    low[i] = lpLow;
    
    // Lowpass for mid/high separation
    lpHigh += alphaHigh * (x - lpHigh);
    
    // Mid = between low and high cutoffs
    mid[i] = lpHigh - lpLow;
    
    // High = everything above high cutoff
    high[i] = x - lpHigh;
  }
  
  return {
    low,
    mid,
    high,
    duration: Number.isFinite(audioBuffer.duration) ? audioBuffer.duration : 0,
  };
}


// ============================================================================
// MAIN WAVEFORM COMPUTATION
// ============================================================================


export async function computeWaveformBands(
  audioBuffer: AudioBuffer,
  buckets: number = WAVEFORM_BUCKETS
): Promise<WaveformBands> {
  const total = audioBuffer?.length || 0;
  
  if (!total || !Number.isFinite(total) || total <= 0) {
    return {
      peaksLow: new Array(buckets).fill(0),
      peaksMid: new Array(buckets).fill(0),
      peaksHigh: new Array(buckets).fill(0),
      duration: audioBuffer?.duration || 0,
      buckets,
    };
  }

  let bands: Rendered3Band;
  
  try {
    // Try OfflineAudioContext first (best quality)
    bands = await render3BandOffline(audioBuffer);
  } catch (err) {
    console.warn('[WAVEFORM] OfflineAudioContext unavailable, using fallback:', err);
    // Fall back to simple filtering
    bands = render3BandFallback(audioBuffer);
  }
  
  // Compute RMS for each band
  const eLow = bucketRms(bands.low, buckets);
  const eMid = bucketRms(bands.mid, buckets);
  const eHigh = bucketRms(bands.high, buckets);
  
  // Apply perceptual weights BEFORE normalization (this is key!)
  for (let i = 0; i < buckets; i++) {
    eLow[i] *= LOW_WEIGHT;
    eMid[i] *= MID_WEIGHT;
    eHigh[i] *= HIGH_WEIGHT; // Boosts highs for visibility
  }
  
  // Shared normalization preserves the weight relationships
  const { outLow, outMid, outHigh } = sharedNormalize(eLow, eMid, eHigh);
  
  return {
    peaksLow: outLow,
    peaksMid: outMid,
    peaksHigh: outHigh,
    duration: bands.duration,
    buckets,
  };
}


// ============================================================================
// PUBLIC API
// ============================================================================


export async function getWaveformForUrl(url: string, cacheIdentity?: string | null): Promise<CachedWaveform> {
  const key = waveformCacheKey(url, cacheIdentity);
  
  // Check cache (24-hour TTL)
  const cached = waveformCache.get(key);
  if (isFreshWaveform(cached)) {
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

export async function computeAndCacheWaveformForUrlFromAudioBuffer(
  url: string,
  audioBuffer: AudioBuffer,
  cacheIdentity?: string | null
): Promise<CachedWaveform> {
  const key = waveformCacheKey(url, cacheIdentity);

  const cached = waveformCache.get(key);
  if (isFreshWaveform(cached)) {
    return cached;
  }

  if (waveformInFlight.has(key)) {
    return waveformInFlight.get(key)!;
  }

  const p = (async (): Promise<CachedWaveform> => {
    const wf = await computeWaveformBands(audioBuffer, WAVEFORM_BUCKETS);
    const out: CachedWaveform = { ...wf, ts: Date.now() };
    waveformCache.set(key, out);
    return out;
  })().finally(() => waveformInFlight.delete(key));

  waveformInFlight.set(key, p);
  return p;
}
