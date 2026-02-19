/**
 * Essentia.js-based BPM detector
 * Uses PercivalBpmEstimator for fast, accurate tempo detection
 *
 * IMPORTANT (Firefox compatibility):
 * We intentionally import the WASM bundle directly instead of importing the
 * aggregate `essentia.js` package. In Firefox extension contexts, accessing
 * some aggregate export getters can throw due to strict-mode `this` behavior.
 */

let essentia: any = null;
let essentiaModule: any = null;
const preprocessedSignalCache = new WeakMap<AudioBuffer, Float32Array>();
const ANALYSIS_SKIP_SECONDS = 8;
const ANALYSIS_MAX_SECONDS = 90;
const ESSENTIA_TARGET_SAMPLE_RATE = 16000;
const ANALYSIS_SEARCH_MAX_SECONDS = 240;
const ANALYSIS_SCAN_PREVIEW_RATE = 200;
const ANALYSIS_SCAN_CHUNK_SECONDS = 12;
const ANALYSIS_SCAN_HOP_SECONDS = 4;
const ANALYSIS_PREROLL_SECONDS = 4;
const ANALYSIS_EARLY_ACCEPT_RATIO = 0.8;
const ANALYSIS_MIN_MEAN_ENVELOPE = 1e-3;
const ANALYSIS_MIN_MEAN_FLUX = 2e-4;
const ANALYSIS_MIN_ADAPTIVE_SCORE = 3e-4;
const ANALYSIS_MIN_ADAPTIVE_WINDOW_SECONDS = 20;

async function resolveEssentiaWasmModule(): Promise<any> {
  // Avoid aggregated `essentia.js` exports in Firefox because some getters
  // in sibling bundles can throw during property access.
  const raw: any = require('essentia.js/dist/essentia-wasm.umd.js');
  const candidate = raw?.default ?? raw;
  const unwrapped = candidate?.EssentiaWASM ?? candidate;

  if (typeof unwrapped === 'function') {
    return await unwrapped();
  }

  if (unwrapped && typeof unwrapped.ready?.then === 'function') {
    return await unwrapped.ready;
  }

  if (unwrapped && typeof unwrapped.then === 'function') {
    return await unwrapped;
  }

  if (unwrapped && typeof unwrapped.EssentiaJS === 'function' && typeof unwrapped.arrayToVector === 'function') {
    return unwrapped;
  }

  let keys = '[unreadable]';
  try {
    keys = Object.keys(unwrapped || {}).slice(0, 30).join(',');
  } catch {
    // Ignore.
  }
  throw new TypeError(`Essentia WASM module unavailable from direct import. keys: ${keys}`);
}

/**
 * Initialize Essentia WASM module (call once at extension startup)
 */
export async function initEssentia(): Promise<void> {
  if (essentia) return; // Already initialized
  
  try {
    essentiaModule = await resolveEssentiaWasmModule();
    essentia = new essentiaModule.EssentiaJS(false);
    console.log('[Essentia] WASM module initialized successfully');
  } catch (error) {
    console.error('[Essentia] Failed to initialize WASM:', error);
    throw error;
  }
}

function getDefaultAnalysisWindow(audioBuffer: AudioBuffer): { startSample: number; endSample: number } {
  const sr = audioBuffer.sampleRate;
  const startSample = Math.min(audioBuffer.length, Math.floor(sr * ANALYSIS_SKIP_SECONDS));
  const maxWindowSamples = Math.max(0, Math.floor(sr * ANALYSIS_MAX_SECONDS));
  const endSample = Math.min(audioBuffer.length, startSample + maxWindowSamples);
  return { startSample, endSample };
}

function buildPreviewEnvelope(
  channel: Float32Array,
  startSample: number,
  endSample: number,
  bucketSize: number
): Float32Array {
  const safeBucketSize = Math.max(1, bucketSize);
  const bucketCount = Math.max(0, Math.floor((endSample - startSample) / safeBucketSize));
  const envelope = new Float32Array(bucketCount);

  let src = startSample;
  for (let i = 0; i < bucketCount; i++) {
    const bucketEnd = Math.min(endSample, src + safeBucketSize);
    let peak = 0;
    for (let j = src; j < bucketEnd; j++) {
      const v = Math.abs(channel[j]);
      if (v > peak) peak = v;
    }
    envelope[i] = peak;
    src = bucketEnd;
  }

  return envelope;
}

function buildPositiveFlux(envelope: Float32Array): Float32Array {
  const flux = new Float32Array(envelope.length);
  if (!envelope.length) return flux;

  let prev = envelope[0];
  for (let i = 1; i < envelope.length; i++) {
    const current = envelope[i];
    const delta = current - prev;
    flux[i] = delta > 0 ? delta : 0;
    prev = current;
  }
  return flux;
}

function buildPrefixSum(values: Float32Array): Float64Array {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    prefix[i + 1] = prefix[i] + values[i];
  }
  return prefix;
}

function sumRange(prefix: Float64Array, start: number, end: number): number {
  return prefix[end] - prefix[start];
}

function estimateRhythmicPeriodicity(
  flux: Float32Array,
  start: number,
  end: number,
  minLag: number,
  maxLag: number
): number {
  if ((end - start) <= (maxLag + 2)) return 0;

  let energy = 0;
  for (let i = start; i < end; i++) {
    const v = flux[i];
    energy += v * v;
  }
  if (energy <= 1e-12) return 0;

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let corr = 0;
    for (let i = start + lag; i < end; i++) {
      corr += flux[i] * flux[i - lag];
    }
    const normalized = corr / energy;
    if (normalized > best) best = normalized;
  }

  return best;
}

function findAdaptiveAnalysisStartSample(audioBuffer: AudioBuffer): number | null {
  const sr = audioBuffer.sampleRate;
  if (!Number.isFinite(sr) || sr <= 0 || audioBuffer.length <= 0 || audioBuffer.numberOfChannels <= 0) {
    return null;
  }

  const searchEndSample = Math.min(audioBuffer.length, Math.floor(sr * ANALYSIS_SEARCH_MAX_SECONDS));
  if (searchEndSample <= 0) return null;

  const bucketSize = Math.max(1, Math.floor(sr / ANALYSIS_SCAN_PREVIEW_RATE));
  const previewRate = sr / bucketSize;

  const channel0 = audioBuffer.getChannelData(0);
  const envelope = buildPreviewEnvelope(channel0, 0, searchEndSample, bucketSize);
  if (envelope.length < 8) return null;

  const flux = buildPositiveFlux(envelope);
  const envelopePrefix = buildPrefixSum(envelope);
  const fluxPrefix = buildPrefixSum(flux);

  const chunkSize = Math.max(1, Math.floor(ANALYSIS_SCAN_CHUNK_SECONDS * previewRate));
  const hopSize = Math.max(1, Math.floor(ANALYSIS_SCAN_HOP_SECONDS * previewRate));
  if (chunkSize >= envelope.length) return null;

  const minLag = Math.max(1, Math.floor((60 * previewRate) / 170));
  const maxLag = Math.min(
    Math.max(minLag + 1, Math.floor((60 * previewRate) / 70)),
    Math.max(minLag + 1, chunkSize - 2)
  );
  if (maxLag <= minLag) return null;

  type Candidate = {
    start: number;
    meanEnvelope: number;
    meanFlux: number;
    periodicity: number;
    score: number;
  };

  const candidates: Candidate[] = [];
  let best: Candidate | null = null;

  for (let start = 0; (start + chunkSize) <= envelope.length; start += hopSize) {
    const end = start + chunkSize;
    const meanEnvelope = sumRange(envelopePrefix, start, end) / chunkSize;
    const meanFlux = sumRange(fluxPrefix, start, end) / chunkSize;
    if (meanEnvelope < ANALYSIS_MIN_MEAN_ENVELOPE && meanFlux < ANALYSIS_MIN_MEAN_FLUX) {
      continue;
    }

    const periodicity = estimateRhythmicPeriodicity(flux, start, end, minLag, maxLag);
    const score = meanFlux * (0.5 + periodicity);

    const candidate: Candidate = { start, meanEnvelope, meanFlux, periodicity, score };
    candidates.push(candidate);
    if (!best || score > best.score) {
      best = candidate;
    }
  }

  if (!best || !Number.isFinite(best.score) || best.score < ANALYSIS_MIN_ADAPTIVE_SCORE) {
    return null;
  }

  const scoreGate = best.score * ANALYSIS_EARLY_ACCEPT_RATIO;
  const fluxGate = Math.max(ANALYSIS_MIN_MEAN_FLUX, best.meanFlux * 0.55);
  const periodicityGate = Math.max(0.05, best.periodicity * 0.5);

  let selected = best;
  for (const candidate of candidates) {
    if (candidate.score < scoreGate) continue;
    if (candidate.meanFlux < fluxGate) continue;
    if (candidate.periodicity < periodicityGate) continue;
    selected = candidate;
    break;
  }

  const startSeconds = Math.max(0, (selected.start / previewRate) - ANALYSIS_PREROLL_SECONDS);
  return Math.floor(startSeconds * sr);
}

function getAnalysisWindow(audioBuffer: AudioBuffer): { startSample: number; endSample: number } {
  const fallback = getDefaultAnalysisWindow(audioBuffer);
  const adaptiveStart = findAdaptiveAnalysisStartSample(audioBuffer);
  if (adaptiveStart === null) return fallback;

  const sr = audioBuffer.sampleRate;
  const maxWindowSamples = Math.max(0, Math.floor(sr * ANALYSIS_MAX_SECONDS));
  const safeStart = Math.min(Math.max(0, adaptiveStart), Math.max(0, audioBuffer.length - 1));
  const endSample = Math.min(audioBuffer.length, safeStart + maxWindowSamples);
  const adaptiveLength = endSample - safeStart;
  const minAdaptiveLength = Math.floor(sr * ANALYSIS_MIN_ADAPTIVE_WINDOW_SECONDS);
  if (adaptiveLength < Math.min(minAdaptiveLength, fallback.endSample - fallback.startSample)) {
    return fallback;
  }

  return { startSample: safeStart, endSample };
}

/**
 * Mix to mono and resample in one pass over the selected window.
 * This avoids allocating a full-length mono buffer for long tracks.
 */
function mixAndResampleWindow(
  audioBuffer: AudioBuffer,
  startSample: number,
  endSample: number,
  targetSampleRate: number
): Float32Array {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const windowLength = Math.max(0, endSample - startSample);
  if (windowLength === 0 || numberOfChannels <= 0) return new Float32Array(0);

  const sampleRate = audioBuffer.sampleRate;
  const ratio = sampleRate / targetSampleRate;
  const outputLength = sampleRate === targetSampleRate
    ? windowLength
    : Math.floor(windowLength / ratio);
  if (outputLength <= 0) return new Float32Array(0);

  const ch0 = audioBuffer.getChannelData(0);

  if (numberOfChannels === 1) {
    if (sampleRate === targetSampleRate) {
      return ch0.subarray(startSample, endSample);
    }

    const out = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = startSample + Math.floor(i * ratio);
      out[i] = ch0[srcIndex];
    }
    return out;
  }

  const out = new Float32Array(outputLength);
  const invChannels = 1 / numberOfChannels;

  if (numberOfChannels === 2) {
    const ch1 = audioBuffer.getChannelData(1);

    if (sampleRate === targetSampleRate) {
      for (let i = 0; i < outputLength; i++) {
        const srcIndex = startSample + i;
        out[i] = (ch0[srcIndex] + ch1[srcIndex]) * 0.5;
      }
    } else {
      for (let i = 0; i < outputLength; i++) {
        const srcIndex = startSample + Math.floor(i * ratio);
        out[i] = (ch0[srcIndex] + ch1[srcIndex]) * 0.5;
      }
    }

    return out;
  }

  const channels: Float32Array[] = [ch0];
  for (let ch = 1; ch < numberOfChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  if (sampleRate === targetSampleRate) {
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = startSample + i;
      let sum = 0;
      for (let ch = 0; ch < numberOfChannels; ch++) {
        sum += channels[ch][srcIndex];
      }
      out[i] = sum * invChannels;
    }
  } else {
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = startSample + Math.floor(i * ratio);
      let sum = 0;
      for (let ch = 0; ch < numberOfChannels; ch++) {
        sum += channels[ch][srcIndex];
      }
      out[i] = sum * invChannels;
    }
  }

  return out;
}

/**
 * Classify beat type based on BPM
 */
function classifyBeatType(bpm: number): string {
  if (bpm >= 155 && bpm <= 185) return 'four-on-the-floor-fast';
  if (bpm >= 120 && bpm <= 154) return 'four-on-the-floor';
  if (bpm >= 80 && bpm <= 119) return 'half-time';
  if (bpm >= 50 && bpm <= 79) return 'slow';
  return 'unknown';
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function toNumber(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function confidenceToPercent(confidence: unknown, max: number): number {
  const raw = toNumber(confidence);
  if (!Number.isFinite(raw) || max <= 0) return 0;
  return Math.round(clamp01(raw / max) * 100);
}

function getPreprocessedSignal(audioBuffer: AudioBuffer): Float32Array {
  const cached = preprocessedSignalCache.get(audioBuffer);
  if (cached) return cached;

  const { startSample, endSample } = getAnalysisWindow(audioBuffer);
  const downsampled = mixAndResampleWindow(
    audioBuffer,
    startSample,
    endSample,
    ESSENTIA_TARGET_SAMPLE_RATE
  );
  preprocessedSignalCache.set(audioBuffer, downsampled);
  return downsampled;
}

export interface EssentiaTempoResult {
  bpm: number;
  confidence: number;
  beatTypeAuto: string;
  method: 'essentia-percival' | 'essentia-rhythm2013';
}

export interface TempoEstimateOptions {
  method?: 'percival' | 'rhythm2013';
  minBpm?: number;
  maxBpm?: number;
  targetMinBpm?: number;
  targetMaxBpm?: number;
  preferFasterAmbiguous?: boolean;
  includeConfidence?: boolean;
}

function normalizeBpmForElectronicProfile(
  rawBpm: number,
  opts: {
    targetMinBpm: number;
    targetMaxBpm: number;
    preferFasterAmbiguous: boolean;
  }
): number {
  let bpm = Number(rawBpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return rawBpm;

  const { targetMinBpm, targetMaxBpm, preferFasterAmbiguous } = opts;

  // First, fold obvious out-of-range values into the target window.
  while (bpm < targetMinBpm && bpm * 2 <= targetMaxBpm) {
    bpm *= 2;
  }
  while (bpm > targetMaxBpm && bpm / 2 >= targetMinBpm) {
    bpm /= 2;
  }

  // Then, apply a narrow faster-preference only for classic half-time ambiguity.
  if (preferFasterAmbiguous) {
    const doubled = bpm * 2;
    if (bpm >= 70 && bpm <= 90 && doubled <= targetMaxBpm) {
      bpm = doubled;
    }
  }

  return bpm;
}

/**
 * Estimate tempo using Essentia's PercivalBpmEstimator
 */
export async function estimateTempo(
  audioBuffer: AudioBuffer,
  options: TempoEstimateOptions = {}
): Promise<EssentiaTempoResult> {
  // Ensure Essentia is initialized
  if (!essentia) {
    await initEssentia();
  }

  const {
    method = 'percival',
    minBpm = 50,
    maxBpm = 210,
    targetMinBpm = minBpm,
    targetMaxBpm = maxBpm,
    preferFasterAmbiguous = false,
    includeConfidence = true,
  } = options;

  console.log(`[Essentia] Starting tempo analysis (method: ${method})`);
  const startTime = performance.now();

  // Preprocess: convert to mono and downsample to 16kHz (Essentia's default)
  const downsampled = getPreprocessedSignal(audioBuffer);

  // Convert to Essentia vector
  const vectorSignal = essentiaModule.arrayToVector(downsampled);

  let bpm: number;
  let confidence = 0;

  try {
    if (method === 'percival') {
      // PercivalBpmEstimator: faster, good for most cases
      const result = essentia.PercivalBpmEstimator(
        vectorSignal,
        1024,    // frameSize
        2048,    // hopSize
        128,     // frameSizeOSS (onset detection)
        128,     // hopSizeOSS
        maxBpm,  // maxBPM
        minBpm,  // minBPM
        16000    // sampleRate
      );
      bpm = result.bpm;

      if (includeConfidence) {
        // Use a track-level confidence source. LoopBpmConfidence is intended for
        // constant-tempo loops and tends to report 0 on full songs.
        try {
          const rhythm = essentia.RhythmExtractor2013(
            vectorSignal,
            maxBpm,
            'multifeature',
            minBpm
          );
          confidence = confidenceToPercent(rhythm?.confidence, 5.32);
        } catch {
          // Fallback only if rhythm confidence is unavailable.
          try {
            const confResult = essentia.LoopBpmConfidence(vectorSignal, bpm, 16000);
            confidence = confidenceToPercent(confResult?.confidence, 1);
          } catch {
            confidence = 0;
          }
        }
      }
    } else {
      // RhythmExtractor2013: more accurate, slightly slower
      const result = essentia.RhythmExtractor2013(
        vectorSignal,
        maxBpm,
        'multifeature',  // or 'degara'
        minBpm
      );
      bpm = result.bpm;
      // RhythmExtractor2013 confidence is documented on a [0, 5.32] scale.
      confidence = confidenceToPercent(result?.confidence, 5.32);
    }
  } catch (error) {
    console.error('[Essentia] Analysis failed:', error);
    throw new Error(`Essentia analysis failed: ${error}`);
  } finally {
    // Clean up vector
    vectorSignal.delete();
  }

  const elapsedTime = performance.now() - startTime;
  const normalizedBpm = normalizeBpmForElectronicProfile(bpm, {
    targetMinBpm,
    targetMaxBpm,
    preferFasterAmbiguous,
  });

  if (Math.round(normalizedBpm) !== Math.round(bpm)) {
    console.log(
      `[Essentia] BPM normalized for electronic profile: ${Math.round(bpm)} -> ${Math.round(normalizedBpm)}`
    );
  }
  console.log(`[Essentia] Analysis complete: ${Math.round(normalizedBpm)} BPM (${elapsedTime.toFixed(0)}ms)`);

  return {
    bpm: Math.round(normalizedBpm),
    confidence,
    beatTypeAuto: classifyBeatType(normalizedBpm),
    method: method === 'percival' ? 'essentia-percival' : 'essentia-rhythm2013'
  };
}

/**
 * Compute confidence in a separate pass so BPM can be emitted first.
 */
export async function estimateTempoConfidence(
  audioBuffer: AudioBuffer,
  options: Pick<TempoEstimateOptions, 'minBpm' | 'maxBpm'> = {}
): Promise<number> {
  if (!essentia) {
    await initEssentia();
  }

  const { minBpm = 50, maxBpm = 210 } = options;

  const downsampled = getPreprocessedSignal(audioBuffer);
  const vectorSignal = essentiaModule.arrayToVector(downsampled);

  try {
    const rhythm = essentia.RhythmExtractor2013(
      vectorSignal,
      maxBpm,
      'multifeature',
      minBpm
    );
    return confidenceToPercent(rhythm?.confidence, 5.32);
  } catch {
    return 0;
  } finally {
    vectorSignal.delete();
  }
}

/**
 * Cleanup Essentia resources (call on extension unload)
 */
export function cleanupEssentia(): void {
  if (essentia) {
    essentia.delete();
    essentia = null;
    essentiaModule = null;
    console.log('[Essentia] Resources cleaned up');
  }
}
