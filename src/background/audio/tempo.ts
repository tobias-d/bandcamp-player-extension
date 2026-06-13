import type { BeatTypeAuto, TempoGridRefinement } from '@/shared/types';
import { ANALYSIS_SAMPLE_RATE } from '@/shared/constants';
import { initEssentiaRuntime } from '@/background/audio/essentia-runtime';
import { getWorkerPool } from '@/background/audio/worker-pool';

const ANALYSIS_SKIP_SECONDS = 8;
const ANALYSIS_MAX_SECONDS = 90;
const INTERACTIVE_ANALYSIS_MAX_SECONDS = 32;
const INTERACTIVE_ANALYSIS_MIN_SECONDS = 16;
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

export type ResampleQuality = 'fast' | 'precise';
export type SignalScope = 'analysis-window' | 'interactive-window' | 'full-track';

interface PreprocessedSignalCacheEntry {
  values: Map<string, Float32Array>;
  promises: Map<string, Promise<Float32Array>>;
}

interface RhythmEvidenceCacheEntry {
  values: Map<string, RhythmEvidenceResult>;
  promises: Map<string, Promise<RhythmEvidenceResult>>;
}

const preprocessedSignalCache = new WeakMap<AudioBuffer, PreprocessedSignalCacheEntry>();
const analysisWindowCache = new WeakMap<AudioBuffer, { startSample: number; endSample: number }>();
const interactiveAnalysisWindowCache = new WeakMap<AudioBuffer, { startSample: number; endSample: number }>();
const rhythmEvidenceCache = new WeakMap<AudioBuffer, RhythmEvidenceCacheEntry>();

function getCacheKey(targetSampleRate: number, quality: ResampleQuality, scope: SignalScope): string {
  return `${targetSampleRate}:${quality}:${scope}`;
}

function getDefaultAnalysisWindow(audioBuffer: AudioBuffer): { startSample: number; endSample: number } {
  const sampleRate = audioBuffer.sampleRate;
  const startSample = Math.min(audioBuffer.length, Math.floor(sampleRate * ANALYSIS_SKIP_SECONDS));
  const maxWindowSamples = Math.max(0, Math.floor(sampleRate * ANALYSIS_MAX_SECONDS));
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

  let sourceIndex = startSample;
  for (let i = 0; i < bucketCount; i += 1) {
    const bucketEnd = Math.min(endSample, sourceIndex + safeBucketSize);
    let peak = 0;
    for (let j = sourceIndex; j < bucketEnd; j += 1) {
      const sample = Math.abs(channel[j] || 0);
      if (sample > peak) {
        peak = sample;
      }
    }
    envelope[i] = peak;
    sourceIndex = bucketEnd;
  }

  return envelope;
}

function buildPositiveFlux(envelope: Float32Array): Float32Array {
  const flux = new Float32Array(envelope.length);
  if (!envelope.length) {
    return flux;
  }

  let previous = envelope[0];
  for (let i = 1; i < envelope.length; i += 1) {
    const current = envelope[i];
    const delta = current - previous;
    flux[i] = delta > 0 ? delta : 0;
    previous = current;
  }
  return flux;
}

function buildPrefixSum(values: Float32Array): Float64Array {
  const prefix = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i += 1) {
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
  if (end - start <= maxLag + 2) {
    return 0;
  }

  let energy = 0;
  for (let i = start; i < end; i += 1) {
    const value = flux[i];
    energy += value * value;
  }
  if (energy <= 1e-12) {
    return 0;
  }

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let correlation = 0;
    for (let i = start + lag; i < end; i += 1) {
      correlation += flux[i] * flux[i - lag];
    }
    const normalized = correlation / energy;
    if (normalized > best) {
      best = normalized;
    }
  }

  return best;
}

export function findAdaptiveAnalysisStartSample(audioBuffer: AudioBuffer): number | null {
  const sampleRate = audioBuffer.sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || audioBuffer.length <= 0 || audioBuffer.numberOfChannels <= 0) {
    return null;
  }

  const searchEndSample = Math.min(audioBuffer.length, Math.floor(sampleRate * ANALYSIS_SEARCH_MAX_SECONDS));
  if (searchEndSample <= 0) {
    return null;
  }

  const bucketSize = Math.max(1, Math.floor(sampleRate / ANALYSIS_SCAN_PREVIEW_RATE));
  const previewRate = sampleRate / bucketSize;
  const channel0 = audioBuffer.getChannelData(0);
  const envelope = buildPreviewEnvelope(channel0, 0, searchEndSample, bucketSize);
  if (envelope.length < 8) {
    return null;
  }

  const flux = buildPositiveFlux(envelope);
  const envelopePrefix = buildPrefixSum(envelope);
  const fluxPrefix = buildPrefixSum(flux);
  const chunkSize = Math.max(1, Math.floor(ANALYSIS_SCAN_CHUNK_SECONDS * previewRate));
  const hopSize = Math.max(1, Math.floor(ANALYSIS_SCAN_HOP_SECONDS * previewRate));
  if (chunkSize >= envelope.length) {
    return null;
  }

  const minLag = Math.max(1, Math.floor((60 * previewRate) / 170));
  const maxLag = Math.min(
    Math.max(minLag + 1, Math.floor((60 * previewRate) / 70)),
    Math.max(minLag + 1, chunkSize - 2)
  );
  if (maxLag <= minLag) {
    return null;
  }

  type Candidate = {
    start: number;
    meanEnvelope: number;
    meanFlux: number;
    periodicity: number;
    score: number;
  };

  const candidates: Candidate[] = [];
  let best: Candidate | null = null;

  for (let start = 0; start + chunkSize <= envelope.length; start += hopSize) {
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
    if (candidate.score < scoreGate || candidate.meanFlux < fluxGate || candidate.periodicity < periodicityGate) {
      continue;
    }
    selected = candidate;
    break;
  }

  const startSeconds = Math.max(0, selected.start / previewRate - ANALYSIS_PREROLL_SECONDS);
  return Math.floor(startSeconds * sampleRate);
}

function getAnalysisWindow(audioBuffer: AudioBuffer): { startSample: number; endSample: number } {
  const cached = analysisWindowCache.get(audioBuffer);
  if (cached) {
    return cached;
  }

  const fallback = getDefaultAnalysisWindow(audioBuffer);
  const adaptiveStart = findAdaptiveAnalysisStartSample(audioBuffer);
  if (adaptiveStart === null) {
    analysisWindowCache.set(audioBuffer, fallback);
    return fallback;
  }

  const sampleRate = audioBuffer.sampleRate;
  const maxWindowSamples = Math.max(0, Math.floor(sampleRate * ANALYSIS_MAX_SECONDS));
  const safeStart = Math.min(Math.max(0, adaptiveStart), Math.max(0, audioBuffer.length - 1));
  const endSample = Math.min(audioBuffer.length, safeStart + maxWindowSamples);
  const adaptiveLength = endSample - safeStart;
  const minAdaptiveLength = Math.floor(sampleRate * ANALYSIS_MIN_ADAPTIVE_WINDOW_SECONDS);
  if (adaptiveLength < Math.min(minAdaptiveLength, fallback.endSample - fallback.startSample)) {
    analysisWindowCache.set(audioBuffer, fallback);
    return fallback;
  }

  const resolved = { startSample: safeStart, endSample };
  analysisWindowCache.set(audioBuffer, resolved);
  return resolved;
}

function getInteractiveAnalysisWindow(audioBuffer: AudioBuffer): { startSample: number; endSample: number } {
  const cached = interactiveAnalysisWindowCache.get(audioBuffer);
  if (cached) {
    return cached;
  }

  const sampleRate = audioBuffer.sampleRate;
  const fallback = getDefaultAnalysisWindow(audioBuffer);
  const fallbackEnd = Math.min(
    fallback.endSample,
    fallback.startSample + Math.floor(sampleRate * INTERACTIVE_ANALYSIS_MAX_SECONDS)
  );
  const fallbackWindow = {
    startSample: fallback.startSample,
    endSample: fallbackEnd
  };

  const adaptiveStart = findAdaptiveAnalysisStartSample(audioBuffer);
  const safeStart = adaptiveStart === null
    ? fallbackWindow.startSample
    : Math.min(Math.max(0, adaptiveStart), Math.max(0, audioBuffer.length - 1));
  const interactiveWindowSamples = Math.max(1, Math.floor(sampleRate * INTERACTIVE_ANALYSIS_MAX_SECONDS));
  const minWindowSamples = Math.max(1, Math.floor(sampleRate * INTERACTIVE_ANALYSIS_MIN_SECONDS));
  const endSample = Math.min(audioBuffer.length, safeStart + interactiveWindowSamples);

  const resolved = endSample - safeStart >= minWindowSamples
    ? { startSample: safeStart, endSample }
    : fallbackWindow;
  interactiveAnalysisWindowCache.set(audioBuffer, resolved);
  return resolved;
}

function resamplePoint(signal: Float32Array, position: number): number {
  const nearest = Math.floor(position);
  return signal[nearest] || 0;
}

function mixAndResampleWindow(
  audioBuffer: AudioBuffer,
  startSample: number,
  endSample: number,
  targetSampleRate: number
): Float32Array {
  const windowLength = Math.max(0, endSample - startSample);
  const channelCount = audioBuffer.numberOfChannels;
  if (windowLength <= 0 || channelCount <= 0) {
    return new Float32Array(0);
  }

  const sampleRate = audioBuffer.sampleRate;
  const ratio = sampleRate / targetSampleRate;
  const outputLength = sampleRate === targetSampleRate ? windowLength : Math.floor(windowLength / ratio);
  if (outputLength <= 0) {
    return new Float32Array(0);
  }

  const channels: Float32Array[] = [];
  for (let i = 0; i < channelCount; i += 1) {
    channels.push(audioBuffer.getChannelData(i));
  }
  const invChannels = 1 / channelCount;
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = sampleRate === targetSampleRate ? startSample + i : startSample + i * ratio;
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      sum += resamplePoint(channels[channel], sourcePosition);
    }
    output[i] = sum * invChannels;
  }

  return output;
}

async function resamplePreciseWindow(
  audioBuffer: AudioBuffer,
  startSample: number,
  endSample: number,
  targetSampleRate: number
): Promise<Float32Array> {
  const sourceSampleRate = audioBuffer.sampleRate;
  const windowLength = Math.max(0, endSample - startSample);
  if (windowLength <= 0 || sourceSampleRate <= 0) {
    return new Float32Array(0);
  }

  const durationSeconds = windowLength / sourceSampleRate;
  const targetLength = Math.max(1, Math.ceil(durationSeconds * targetSampleRate));
  const OfflineCtx = globalThis.OfflineAudioContext || (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) {
    throw new Error('OfflineAudioContext is unavailable for precise resampling');
  }

  const ctx = new OfflineCtx(1, targetLength, targetSampleRate);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  source.start(0, startSample / sourceSampleRate, durationSeconds);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function confidenceToPercent(confidence: unknown, max: number): number {
  const raw = Number(confidence);
  if (!Number.isFinite(raw) || max <= 0) {
    return 0;
  }
  return Math.round(clamp01(raw / max) * 100);
}

function normalizeBpmForElectronicProfile(
  rawBpm: number,
  options: {
    targetMinBpm: number;
    targetMaxBpm: number;
    preferFasterAmbiguous: boolean;
  }
): number {
  let bpm = Number(rawBpm);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return rawBpm;
  }

  const { targetMinBpm, targetMaxBpm, preferFasterAmbiguous } = options;
  while (bpm < targetMinBpm && bpm * 2 <= targetMaxBpm) {
    bpm *= 2;
  }
  while (bpm > targetMaxBpm && bpm / 2 >= targetMinBpm) {
    bpm /= 2;
  }

  if (preferFasterAmbiguous) {
    const doubled = bpm * 2;
    if (bpm >= 70 && bpm <= 90 && doubled <= targetMaxBpm) {
      bpm = doubled;
    }
  }

  return bpm;
}

export function classifyBeatType(bpm: number): BeatTypeAuto {
  if (bpm >= 120 && bpm <= 190) {
    return 'straight';
  }
  return 'unknown';
}

export interface TempoEstimateOptions {
  method?: 'percival' | 'rhythm2013';
  minBpm?: number;
  maxBpm?: number;
  targetMinBpm?: number;
  targetMaxBpm?: number;
  preferFasterAmbiguous?: boolean;
  includeConfidence?: boolean;
  quality?: ResampleQuality;
  scope?: SignalScope;
}

export interface EssentiaTempoResult {
  bpm: number;
  /**
   * Pre-round normalized BPM (the float `bpm` is `Math.round`-ed from).
   * Instrumentation only — no decision logic reads this. Used to measure the
   * sub-integer offset vs rekordbox ground truth in the BPM prototype panel.
   */
  rawBpm: number;
  confidence: number;
  beatTypeAuto: BeatTypeAuto;
  method: 'essentia-percival' | 'essentia-rhythm2013';
}

export interface RhythmEvidenceResult {
  bpm: number;
  confidence: number;
  ticks: number[];
  estimates: number[];
  bpmIntervals: number[];
  method: 'multifeature';
  sampleRate: number;
}

function createSignalCacheEntry(): PreprocessedSignalCacheEntry {
  return {
    values: new Map<string, Float32Array>(),
    promises: new Map<string, Promise<Float32Array>>()
  };
}

function createRhythmEvidenceCacheEntry(): RhythmEvidenceCacheEntry {
  return {
    values: new Map<string, RhythmEvidenceResult>(),
    promises: new Map<string, Promise<RhythmEvidenceResult>>()
  };
}

function getSignalCacheEntry(audioBuffer: AudioBuffer): PreprocessedSignalCacheEntry {
  const existing = preprocessedSignalCache.get(audioBuffer);
  if (existing) {
    return existing;
  }
  const created = createSignalCacheEntry();
  preprocessedSignalCache.set(audioBuffer, created);
  return created;
}

function getRhythmEvidenceCacheEntry(audioBuffer: AudioBuffer): RhythmEvidenceCacheEntry {
  const existing = rhythmEvidenceCache.get(audioBuffer);
  if (existing) {
    return existing;
  }
  const created = createRhythmEvidenceCacheEntry();
  rhythmEvidenceCache.set(audioBuffer, created);
  return created;
}

function deleteIfPossible(value: unknown): void {
  if (value && typeof value === 'object' && typeof (value as { delete?: unknown }).delete === 'function') {
    try {
      ((value as { delete: () => void }).delete)();
    } catch {
      // Ignore vector cleanup failures.
    }
  }
}

function vectorToNumbers(
  value: unknown,
  vectorToArrayFns: Array<((input: any) => Float32Array) | undefined>
): number[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => Number(item) || 0).filter(Number.isFinite);
  }

  if (ArrayBuffer.isView(value) && typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return Array.from(value as unknown as Iterable<number>).map((item) => Number(item) || 0).filter(Number.isFinite);
  }

  for (const convert of vectorToArrayFns) {
    if (typeof convert !== 'function') {
      continue;
    }
    try {
      const converted = convert(value);
      if (ArrayBuffer.isView(converted) && typeof (converted as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
        return Array.from(converted as unknown as Iterable<number>).map((item) => Number(item) || 0).filter(Number.isFinite);
      }
    } catch {
      // Try the next conversion path.
    }
  }

  return [];
}

export async function getResampledSignal(
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
  quality: ResampleQuality = 'fast',
  scope: SignalScope = 'analysis-window'
): Promise<Float32Array> {
  const cacheEntry = getSignalCacheEntry(audioBuffer);
  const cacheKey = getCacheKey(targetSampleRate, quality, scope);

  const fromCache = cacheEntry.values.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const fromPromise = cacheEntry.promises.get(cacheKey);
  if (fromPromise) {
    return await fromPromise;
  }

  const range = scope === 'full-track'
    ? { startSample: 0, endSample: audioBuffer.length }
    : scope === 'interactive-window'
      ? getInteractiveAnalysisWindow(audioBuffer)
    : getAnalysisWindow(audioBuffer);

  const compute = quality === 'precise'
    ? resamplePreciseWindow(audioBuffer, range.startSample, range.endSample, targetSampleRate)
    : Promise.resolve(mixAndResampleWindow(audioBuffer, range.startSample, range.endSample, targetSampleRate));

  cacheEntry.promises.set(cacheKey, compute);
  preprocessedSignalCache.set(audioBuffer, cacheEntry);

  try {
    const signal = await compute;
    cacheEntry.values.set(cacheKey, signal);
    cacheEntry.promises.delete(cacheKey);
    preprocessedSignalCache.set(audioBuffer, cacheEntry);
    return signal;
  } catch (error) {
    cacheEntry.promises.delete(cacheKey);
    preprocessedSignalCache.set(audioBuffer, cacheEntry);
    throw error;
  }
}

export async function getPreprocessedSignal(
  audioBuffer: AudioBuffer,
  quality: ResampleQuality = 'fast',
  scope: SignalScope = 'analysis-window'
): Promise<Float32Array> {
  return await getResampledSignal(audioBuffer, ANALYSIS_SAMPLE_RATE, quality, scope);
}

export async function extractRhythmEvidence(
  audioBuffer: AudioBuffer,
  options: Pick<TempoEstimateOptions, 'minBpm' | 'maxBpm' | 'quality'> = {}
): Promise<RhythmEvidenceResult> {
  const minBpm = options.minBpm ?? 50;
  const maxBpm = options.maxBpm ?? 210;
  const quality = options.quality ?? 'fast';
  // Tempo correction depends on the denser rhythm evidence here. Lowering the
  // signal rate caused mid-drift tracks to under-read into half-time families.
  const sampleRate = 44_100;
  const cacheKey = `${minBpm}:${maxBpm}:${quality}:${sampleRate}`;
  const cacheEntry = getRhythmEvidenceCacheEntry(audioBuffer);

  const fromCache = cacheEntry.values.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  const fromPromise = cacheEntry.promises.get(cacheKey);
  if (fromPromise) {
    return await fromPromise;
  }

  const compute = (async (): Promise<RhythmEvidenceResult> => {
    const signal = await getResampledSignal(audioBuffer, sampleRate, quality);

    // Offload RhythmExtractor2013 to the worker pool so the corrected-tempo path
    // (octave correction + beat-grid precision) parallelises across preload
    // tracks instead of serialising on the host main thread — which backed up
    // long playlists past the 15 s preload budget. Falls back to main-thread
    // essentia when no pool is ready (e.g. before warm-up).
    const pool = getWorkerPool();
    if (pool.isReady()) {
      try {
        const transferCopy = new Float32Array(signal);
        const out = await pool.extractRhythm({ signal: transferCopy, minBpm, maxBpm });
        return {
          bpm: out.bpm,
          confidence: out.confidence,
          ticks: out.ticks,
          estimates: out.estimates,
          bpmIntervals: out.bpmIntervals,
          method: 'multifeature',
          sampleRate
        };
      } catch {
        // Fall through to the main-thread path below.
      }
    }

    const runtime = await initEssentiaRuntime();
    const vectorSignal = runtime.module.arrayToVector(signal);
    let ticksValue: unknown = null;
    let estimatesValue: unknown = null;
    let bpmIntervalsValue: unknown = null;

    try {
      const result = runtime.instance.RhythmExtractor2013(vectorSignal, maxBpm, 'multifeature', minBpm);
      ticksValue = result?.ticks;
      estimatesValue = result?.estimates;
      bpmIntervalsValue = result?.bpmIntervals;

      const vectorToArrayFns = [
        runtime.instance.vectorToArray?.bind(runtime.instance),
        runtime.module.vectorToArray.bind(runtime.module)
      ];

      return {
        bpm: Number(result?.bpm) || 0,
        confidence: confidenceToPercent(result?.confidence, 5.32),
        ticks: vectorToNumbers(ticksValue, vectorToArrayFns),
        estimates: vectorToNumbers(estimatesValue, vectorToArrayFns),
        bpmIntervals: vectorToNumbers(bpmIntervalsValue, vectorToArrayFns),
        method: 'multifeature',
        sampleRate
      };
    } finally {
      deleteIfPossible(ticksValue);
      deleteIfPossible(estimatesValue);
      deleteIfPossible(bpmIntervalsValue);
      vectorSignal.delete();
    }
  })();

  cacheEntry.promises.set(cacheKey, compute);
  rhythmEvidenceCache.set(audioBuffer, cacheEntry);

  try {
    const evidence = await compute;
    cacheEntry.values.set(cacheKey, evidence);
    cacheEntry.promises.delete(cacheKey);
    rhythmEvidenceCache.set(audioBuffer, cacheEntry);
    return evidence;
  } catch (error) {
    cacheEntry.promises.delete(cacheKey);
    rhythmEvidenceCache.set(audioBuffer, cacheEntry);
    throw error;
  }
}

export async function estimateTempo(
  audioBuffer: AudioBuffer,
  options: TempoEstimateOptions = {}
): Promise<EssentiaTempoResult> {
  const runtime = await initEssentiaRuntime();
  const {
    method = 'percival',
    minBpm = 50,
    maxBpm = 210,
    targetMinBpm = minBpm,
    targetMaxBpm = maxBpm,
    preferFasterAmbiguous = false,
    includeConfidence = true,
    quality = 'fast',
    scope = 'analysis-window'
  } = options;

  const downsampled = await getPreprocessedSignal(audioBuffer, quality, scope);
  const vectorSignal = runtime.module.arrayToVector(downsampled);

  let bpm = 0;
  let confidence = 0;
  try {
    if (method === 'percival') {
      const result = runtime.instance.PercivalBpmEstimator(
        vectorSignal,
        1024,
        2048,
        128,
        128,
        maxBpm,
        minBpm,
        ANALYSIS_SAMPLE_RATE
      );
      bpm = Number(result.bpm);

      if (includeConfidence) {
        try {
          const rhythm = runtime.instance.RhythmExtractor2013(vectorSignal, maxBpm, 'multifeature', minBpm);
          confidence = confidenceToPercent(rhythm?.confidence, 5.32);
        } catch {
          try {
            const loopConfidence = runtime.instance.LoopBpmConfidence(vectorSignal, bpm, ANALYSIS_SAMPLE_RATE);
            confidence = confidenceToPercent(loopConfidence?.confidence, 1);
          } catch {
            confidence = 0;
          }
        }
      }
    } else {
      const result = runtime.instance.RhythmExtractor2013(vectorSignal, maxBpm, 'multifeature', minBpm);
      bpm = Number(result.bpm);
      confidence = confidenceToPercent(result?.confidence, 5.32);
    }
  } finally {
    vectorSignal.delete();
  }

  const normalizedBpm = normalizeBpmForElectronicProfile(bpm, {
    targetMinBpm,
    targetMaxBpm,
    preferFasterAmbiguous
  });

  return {
    bpm: Math.round(normalizedBpm),
    rawBpm: normalizedBpm,
    confidence,
    beatTypeAuto: classifyBeatType(normalizedBpm),
    method: method === 'percival' ? 'essentia-percival' : 'essentia-rhythm2013'
  };
}

/**
 * Sharpen Percival's coarse-grid BPM using the finer beat-counter tempo
 * (`fineBpm` = RhythmExtractor2013 aggregated bpm), but only when the two agree
 * on the same pulse. This is the cross-check half of the two-algorithm design:
 * live in the `'corrected'` path via `resolveTempoForAnalysis` (`analysis-tempo.ts`)
 * and `analysis.ts`, applied only when the octave is unchanged. Reuses evidence we
 * already extract — no new analysis pass. Pure function. See {@link TempoGridRefinement}
 * and `rules/bpm-analysis-rules.md` §9.
 */
// Half a Percival grid-step (~2.5 BPM near 130-140) — a genuine same-pulse
// refinement is a small nudge within one grid cell. Wider gaps mean the
// beat-counter locked onto a different/noisy pulse, so we reject and keep base.
export const GRID_REFINE_TOLERANCE_BPM = 1.25;

export function refineTempoToBeatGrid(baseBpm: number, fineBpm: number): TempoGridRefinement {
  const valid = Number.isFinite(baseBpm) && baseBpm > 0 && Number.isFinite(fineBpm) && fineBpm > 0;
  const agreed = valid && Math.abs(fineBpm - baseBpm) <= GRID_REFINE_TOLERANCE_BPM;
  return {
    baseBpm,
    fineBpm: valid ? fineBpm : 0,
    refinedBpm: agreed ? fineBpm : baseBpm,
    agreed,
    toleranceBpm: GRID_REFINE_TOLERANCE_BPM
  };
}

export async function estimateTempoConfidence(
  audioBuffer: AudioBuffer,
  options: Pick<TempoEstimateOptions, 'minBpm' | 'maxBpm' | 'quality'> = {}
): Promise<number> {
  const runtime = await initEssentiaRuntime();
  const minBpm = options.minBpm ?? 50;
  const maxBpm = options.maxBpm ?? 210;
  const quality = options.quality ?? 'fast';

  const signal = await getPreprocessedSignal(audioBuffer, quality);
  const vectorSignal = runtime.module.arrayToVector(signal);
  try {
    const result = runtime.instance.RhythmExtractor2013(vectorSignal, maxBpm, 'multifeature', minBpm);
    return confidenceToPercent(result?.confidence, 5.32);
  } catch {
    return 0;
  } finally {
    vectorSignal.delete();
  }
}
