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

/**
 * Convert stereo AudioBuffer to mono Float32Array
 */
function convertToMono(audioBuffer: AudioBuffer): Float32Array {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);

  if (numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  // Mix down to mono by averaging channels
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      sum += audioBuffer.getChannelData(ch)[i];
    }
    mono[i] = sum / numberOfChannels;
  }

  return mono;
}

/**
 * Downsample audio to target sample rate
 */
function downsample(
  audio: Float32Array,
  originalSampleRate: number,
  targetSampleRate: number
): Float32Array {
  if (originalSampleRate === targetSampleRate) {
    return audio;
  }

  const ratio = originalSampleRate / targetSampleRate;
  const newLength = Math.floor(audio.length / ratio);
  const downsampled = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    downsampled[i] = audio[srcIndex];
  }

  return downsampled;
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

export interface EssentiaTempoResult {
  bpm: number;
  confidence: number;
  beatTypeAuto: string;
  method: 'essentia-percival' | 'essentia-rhythm2013';
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
  options: {
    method?: 'percival' | 'rhythm2013';
    minBpm?: number;
    maxBpm?: number;
    targetMinBpm?: number;
    targetMaxBpm?: number;
    preferFasterAmbiguous?: boolean;
  } = {}
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
  } = options;

  console.log(`[Essentia] Starting tempo analysis (method: ${method})`);
  const startTime = performance.now();

  // Preprocess: convert to mono and downsample to 16kHz (Essentia's default)
  const mono = convertToMono(audioBuffer);
  const downsampled = downsample(mono, audioBuffer.sampleRate, 16000);

  // Convert to Essentia vector
  const vectorSignal = essentiaModule.arrayToVector(downsampled);

  let bpm: number;

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
    } else {
      // RhythmExtractor2013: more accurate, slightly slower
      const result = essentia.RhythmExtractor2013(
        vectorSignal,
        maxBpm,
        'multifeature',  // or 'degara'
        minBpm
      );
      bpm = result.bpm;
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

  // Essentia doesn't provide confidence score, use a heuristic
  const confidence = bpm > 0 ? 85 : 0;

  return {
    bpm: Math.round(normalizedBpm),
    confidence,
    beatTypeAuto: classifyBeatType(normalizedBpm),
    method: method === 'percival' ? 'essentia-percival' : 'essentia-rhythm2013'
  };
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
