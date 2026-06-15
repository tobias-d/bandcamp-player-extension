import { correctTempoByBeatEvidence } from '@/background/audio/tempo-beat-correction';
import { estimateTempo, estimateTempoConfidence, getPreprocessedSignal, extractRhythmEvidence, refineTempoToBeatGrid } from '@/background/audio/tempo';
import { RHYTHM_MIN_BPM, RHYTHM_MAX_BPM } from '@/background/audio/tempo-correction-support';
import type { EssentiaTempoResult, TempoEstimateOptions } from '@/background/audio/tempo';
import { computeWaveformBands } from '@/background/audio/waveform-core';
import { getWorkerPool } from '@/background/audio/worker-pool';
import { analyzeKeyDetailed } from '@/background/key-essentia';
import { getCachedAnalysis, setCachedAnalysis } from '@/background/cache';
import type { AnalysisResult, KeyAnalysisResult, KeyAnalysisStatus } from '@/shared/types';
import { createLogger } from '@/utils/debug';
import {
  isAbortError,
  getDecodedAudioWithTiming
} from './analysis-audio-fetch';
import type { AnalysisTimingBreakdown } from './analysis-audio-fetch';

const logger = createLogger('ANALYZER');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TempoAnalysisMode = 'corrected' | 'base-only';

export interface ResolvedTempoAnalysis {
  bpm: number;
  beatTypeAuto: AnalysisResult['beatTypeAuto'];
  tempoDebugBaseBpm: number;
  /** Pre-round float of the base estimate (instrumentation, not a decision input). */
  tempoDebugBaseRawBpm?: number;
  tempoDebugSummary: string;
  tempoDebugGate: string;
  tempoDecisionConfidence?: number;
  tempoRawConfidence?: number;
  tempoDebugCandidates: Array<{ bpm: number; label: string; score: number }>;
}

export interface AnalysisExecutionOptions {
  enableConfidenceEstimation: boolean;
  usePartialFetch?: boolean;
}

export interface KeyAnalysisRuntimeDebug {
  keyDebugSource: string;
  keyDebugDetail: string;
  keyDebugCacheKey: string;
  keyDebugTimingMs: number;
  keyDebugDecodeMs: number;
  keyDebugPreprocessMs: number;
  keyDebugComputeMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ANALYSIS_TEMPO_OPTIONS = {
  method: 'percival' as const,
  minBpm: 70,
  maxBpm: 170,
  targetMinBpm: 70,
  targetMaxBpm: 170,
  preferFasterAmbiguous: true,
  includeConfidence: false,
  quality: 'fast' as const
};

export const ANALYSIS_EXECUTION_OPTIONS: AnalysisExecutionOptions = {
  enableConfidenceEstimation: true,
  // Full audio is required: the analysis path now runs the 'corrected' tempo pass
  // (beat-evidence correction + beat-grid refine) directly on first paint, matching
  // Chrome's one-shot offscreen host. Those passes need the whole track, so the old
  // partial-fetch fast path (which only fed the base-only estimate) is disabled.
  usePartialFetch: false
};

const INLINE_WAVEFORM_BUCKETS = 300;

// ---------------------------------------------------------------------------
// Key status helper (used by analyzeAudioBuffer and analysis.ts)
// ---------------------------------------------------------------------------

export function resolveKeyStatus(result: KeyAnalysisResult | null | undefined): KeyAnalysisStatus {
  if (!result) {
    return 'error';
  }
  return result.topKeys.length > 0 ? 'ready' : 'empty';
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

export function buildWorkerPoolDebug(): string {
  try {
    const pool = getWorkerPool();
    const s = pool.getStatus();
    const ready = pool.isReady();
    return `ready=${ready ? 1 : 0} total=${s.total} idle=${s.ready - s.busy} busy=${s.busy} queued=${s.queued} dispatch=${ready ? 'pool' : 'main'}`;
  } catch {
    return 'unavailable';
  }
}

// The worker pool is an optimization path. The service worker path stays as the
// canonical execution mode so analysis still works when workers are unavailable.
async function estimateTempoWithWorkerPool(
  audioBuffer: AudioBuffer,
  options: TempoEstimateOptions
): Promise<EssentiaTempoResult & { viaPool: boolean }> {
  const pool = getWorkerPool();
  if (pool.isReady()) {
    try {
      const scope = options.scope ?? 'analysis-window';
      const quality = options.quality ?? 'fast';
      const signal16k = await getPreprocessedSignal(audioBuffer, quality, scope);
      // Copy so the original cache entry isn't neutered by transfer
      const copy = new Float32Array(signal16k);
      const output = await pool.estimateTempo({
        signal16k: copy,
        minBpm: options.minBpm,
        maxBpm: options.maxBpm,
        targetMinBpm: options.targetMinBpm,
        targetMaxBpm: options.targetMaxBpm,
        preferFasterAmbiguous: options.preferFasterAmbiguous
      });
      return {
        bpm: output.bpm,
        rawBpm: output.rawBpm,
        confidence: output.confidence,
        beatTypeAuto: output.beatTypeAuto === 'straight' ? 'straight'
          : output.beatTypeAuto === 'breakbeat' ? 'breakbeat' : 'unknown',
        method: output.method === 'essentia-percival' ? 'essentia-percival' : 'essentia-rhythm2013',
        viaPool: true
      };
    } catch (error) {
      logger.warn('Worker pool dispatch failed; continuing on the service worker thread', error);
    }
  }

  const result = await estimateTempo(audioBuffer, options);
  return { ...result, viaPool: false };
}

// ---------------------------------------------------------------------------
// Tempo resolution
// ---------------------------------------------------------------------------

// Cache base BPM estimation per audioBuffer so the deferred correction
// refinement doesn't re-run the worker pool estimation on the same buffer.
const baseTempoByBuffer = new WeakMap<AudioBuffer, EssentiaTempoResult & { viaPool: boolean }>();

export async function resolveTempoForAnalysis(
  audioBuffer: AudioBuffer,
  mode: TempoAnalysisMode = 'corrected'
): Promise<ResolvedTempoAnalysis> {
  const cached = baseTempoByBuffer.get(audioBuffer);
  const baseTempoRaw = cached ?? await estimateTempoWithWorkerPool(audioBuffer, ANALYSIS_TEMPO_OPTIONS);
  if (!cached) {
    baseTempoByBuffer.set(audioBuffer, baseTempoRaw);
  }
  const baseTempo = baseTempoRaw;
  if (mode === 'base-only') {
    const viaLabel = baseTempoRaw.viaPool ? 'worker' : 'main';
    const summary = `tempo-base bpm=${baseTempo.bpm} method=${baseTempo.method} via=${viaLabel} mode=base-only`;
    return {
      bpm: baseTempo.bpm,
      beatTypeAuto: baseTempo.beatTypeAuto,
      tempoDebugBaseBpm: baseTempo.bpm,
      tempoDebugBaseRawBpm: baseTempo.rawBpm,
      tempoDebugSummary: summary,
      tempoDebugGate: 'tempoAnalysisMode=base-only',
      tempoRawConfidence: baseTempo.confidence,
      tempoDecisionConfidence: undefined,
      tempoDebugCandidates: [
        {
          bpm: baseTempo.bpm,
          label: 'base',
          score: 1
        }
      ]
    };
  }
  const correction = await correctTempoByBeatEvidence(audioBuffer, baseTempo, {
    deferSegmentAnalysis: false
  });
  const viaLabel = baseTempoRaw.viaPool ? 'worker' : 'main';

  // Beat-grid precision refinement. Percival's BPM is quantised to a coarse lag
  // grid (7500/n), so true integers round to +/-1. When the octave is unchanged
  // (no correction, or correction kept base), sharpen the value using the
  // beat-counter — but only when the two agree on the same pulse. This runs only
  // on the 'corrected' (deferred) pass; first paint is 'base-only', so the fast
  // first BPM is unaffected. Rhythm evidence reuses the correction path's cache.
  const correctionChangedTempo = correction?.bpm != null && correction.bpm !== baseTempo.bpm;
  let finalBpm = correction?.bpm ?? baseTempo.bpm;
  let precisionSummary = '';
  if (!correctionChangedTempo) {
    const rhythm = await extractRhythmEvidence(audioBuffer, { minBpm: RHYTHM_MIN_BPM, maxBpm: RHYTHM_MAX_BPM, quality: 'fast' });
    const precision = refineTempoToBeatGrid(baseTempo.rawBpm, rhythm.bpm);
    const applied = precision.agreed && Math.round(precision.refinedBpm) !== finalBpm;
    if (applied) {
      finalBpm = Math.round(precision.refinedBpm);
    }
    // Always surface the precision evaluation so the debugger shows what the
    // beat-counter returned and whether the refinement engaged.
    precisionSummary = ` grid-refine fine=${rhythm.bpm.toFixed(2)} agreed=${precision.agreed ? 1 : 0} applied=${applied ? finalBpm : 0}`;
  }

  const summary = (correction
    ? correction.summary
    : `tempo-base bpm=${baseTempo.bpm} method=${baseTempo.method} via=${viaLabel}`) + precisionSummary;
  logger.debug(summary, {
    beatType: baseTempo.beatTypeAuto,
    confidence: baseTempo.confidence
  });

  return {
    bpm: finalBpm,
    beatTypeAuto: correction?.beatTypeAuto ?? baseTempo.beatTypeAuto,
    tempoDebugBaseBpm: baseTempo.bpm,
    tempoDebugBaseRawBpm: baseTempo.rawBpm,
    tempoDebugSummary: summary,
    tempoDebugGate: correction?.gateDebug ?? '-',
    tempoRawConfidence: baseTempo.confidence,
    tempoDecisionConfidence: correction?.decisionConfidence,
    tempoDebugCandidates: correction?.candidates ?? [
      {
        bpm: baseTempo.bpm,
        label: 'base',
        score: 1
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Audio buffer analysis (tempo + optional inline key)
// ---------------------------------------------------------------------------

export async function analyzeAudioBuffer(
  audioBuffer: AudioBuffer,
  normalizedUrl: string,
  enableKeyAnalysis: boolean,
  analysisStartedAt: number,
  timing?: Partial<AnalysisTimingBreakdown>,
  options?: {
    tempoAnalysisMode?: TempoAnalysisMode;
    includeInlineWaveform?: boolean;
  }
): Promise<{ result: AnalysisResult }> {
  const tempoStartedAt = performance.now();
  const tempo = await resolveTempoForAnalysis(
    audioBuffer,
    options?.tempoAnalysisMode ?? 'corrected'
  );
  const rawConfidence = Number.isFinite(tempo.tempoRawConfidence) && Number(tempo.tempoRawConfidence) > 0
    ? Number(tempo.tempoRawConfidence)
    : undefined;
  const displayConfidence = Number.isFinite(rawConfidence)
    ? rawConfidence
    : Number.isFinite(tempo.tempoDecisionConfidence) && Number(tempo.tempoDecisionConfidence) > 0
      ? Number(tempo.tempoDecisionConfidence)
      : undefined;
  const tempoMs = Math.round(performance.now() - tempoStartedAt);
  let waveformFields: Partial<AnalysisResult> = {};
  if (options?.includeInlineWaveform) {
    const waveformStartedAt = performance.now();
    try {
      waveformFields = {
        waveform: computeWaveformBands(audioBuffer, INLINE_WAVEFORM_BUCKETS),
        waveformStatus: '',
        waveformMs: Math.round(performance.now() - waveformStartedAt),
        waveformDebugBackendKey: 'inline-bpm-buffer'
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('inline waveform computation failed', error);
      waveformFields = {
        waveform: null,
        waveformStatus: `Waveform failed: ${message}`,
        waveformMs: Math.round(performance.now() - waveformStartedAt),
        waveformDebugBackendKey: 'inline-bpm-buffer'
      };
    }
  }
  let keyAnalysis: AnalysisResult['keyAnalysis'] = undefined;
  let keyStatus: AnalysisResult['keyStatus'] = enableKeyAnalysis ? 'error' : 'disabled';
  let keyDebugFields: Partial<KeyAnalysisRuntimeDebug> = {};
  if (enableKeyAnalysis) {
    try {
      const { result: resolvedKeyAnalysis, timing: keyTiming } = await analyzeKeyDetailed(
        audioBuffer,
        tempo.bpm ?? tempo.tempoDebugBaseBpm
      );
      keyAnalysis = resolvedKeyAnalysis;
      keyStatus = resolveKeyStatus(keyAnalysis);
      keyDebugFields = {
        keyDebugSource: 'runtime.inline-key',
        keyDebugDetail: `key analysis completed inline with BPM analysis${keyTiming.frameStageDetail ? ` ${keyTiming.frameStageDetail}` : ''}${keyTiming.dispatchDetail ? ` ${keyTiming.dispatchDetail}` : ''}${keyTiming.comparisonDetail ? ` ${keyTiming.comparisonDetail}` : ''}`,
        keyDebugCacheKey: '',
        keyDebugTimingMs: keyTiming.totalMs,
        keyDebugDecodeMs: 0,
        keyDebugPreprocessMs: keyTiming.preprocessMs,
        keyDebugComputeMs: keyTiming.computeMs
      };
    } catch (error) {
      logger.warn('key analysis failed', error);
    }
  }

  return {
    result: {
      bpm: tempo.bpm,
      confidence: displayConfidence,
      tempoRawConfidence: rawConfidence,
      tempoDecisionConfidence: tempo.tempoDecisionConfidence,
      beatTypeAuto: tempo.beatTypeAuto,
      breakbeatScore: undefined,
      keyAnalysis,
      keyStatus,
      ...keyDebugFields,
      ...waveformFields,
      sourceUrl: normalizedUrl,
      analysisStatus: `BPM: ${tempo.bpm}`,
      tempoDebugBaseBpm: tempo.tempoDebugBaseBpm,
      tempoDebugBaseRawBpm: tempo.tempoDebugBaseRawBpm,
      tempoDebugSummary: tempo.tempoDebugSummary,
      tempoDebugGate: tempo.tempoDebugGate,
      tempoDebugCandidates: tempo.tempoDebugCandidates,
      analysisFetchMs: Number.isFinite(timing?.fetchMs) ? Math.round(Number(timing?.fetchMs)) : undefined,
      analysisDecodeMs: Number.isFinite(timing?.decodeMs) ? Math.round(Number(timing?.decodeMs)) : undefined,
      analysisTempoMs: tempoMs,
      workerPoolDebug: buildWorkerPoolDebug(),
      analysisMs: Date.now() - analysisStartedAt,
      ts: Date.now()
    }
  };
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

function combineTempoConfidence(result: AnalysisResult, rawConfidence: number): {
  confidence: number;
  tempoRawConfidence: number;
} {
  const normalizedRaw = Math.max(0, Math.min(100, Math.round(rawConfidence)));
  const decisionConfidence = Number(result.tempoDecisionConfidence);
  if (!Number.isFinite(decisionConfidence)) {
    return {
      confidence: normalizedRaw,
      tempoRawConfidence: normalizedRaw
    };
  }

  return {
    confidence: Math.max(0, Math.min(100, Math.round(Math.min(normalizedRaw, decisionConfidence)))),
    tempoRawConfidence: normalizedRaw
  };
}

export function shouldEstimateConfidence(result: AnalysisResult, options: AnalysisExecutionOptions): boolean {
  return (
    options.enableConfidenceEstimation
    && Number.isFinite(result.bpm)
    && (!Number.isFinite(result.tempoRawConfidence) || Number(result.tempoRawConfidence) <= 0)
    && typeof result.error !== 'string'
  );
}

// ---------------------------------------------------------------------------
// Deferred tempo refinement
// ---------------------------------------------------------------------------

export const inFlightTempoRefinementByCacheKey = new Map<string, Promise<void>>();

export function scheduleTempoRefinement(
  cacheIdentity: string,
  cacheKey: string,
  provisionalResult: AnalysisResult,
  sourceUrl: string,
  fetchUrl: string,
  enableKeyAnalysis: boolean,
  signal: AbortSignal | null | undefined,
  isCurrentEpoch: () => boolean,
  emitUpdate: (update: Partial<AnalysisResult>) => void
): void {
  if (!Number.isFinite(provisionalResult.bpm) || inFlightTempoRefinementByCacheKey.has(cacheKey)) {
    return;
  }

  const refinementPromise = (async (): Promise<void> => {
    try {
      if (signal?.aborted || !isCurrentEpoch()) {
        return;
      }

      const { audioBuffer: fullAudioBuffer, resolvedUrl } = await getDecodedAudioWithTiming(
        cacheIdentity,
        fetchUrl,
        signal,
        { requireFull: true }
      );
      if (signal?.aborted || !isCurrentEpoch()) {
        return;
      }

      const { result: refined } = await analyzeAudioBuffer(
        fullAudioBuffer,
        sourceUrl,
        enableKeyAnalysis,
        Date.now(),
        {},
        {}
      );
      if (signal?.aborted || !isCurrentEpoch()) {
        return;
      }

      const bpmChanged = Number(refined.bpm) !== Number(provisionalResult.bpm);
      const latestCached = await getCachedAnalysis(cacheKey);
      const stabilized: AnalysisResult = {
        ...(latestCached || provisionalResult),
        bpm: refined.bpm,
        confidence: refined.confidence,
        tempoRawConfidence: refined.tempoRawConfidence,
        tempoDecisionConfidence: refined.tempoDecisionConfidence,
        beatTypeAuto: refined.beatTypeAuto,
        breakbeatScore: refined.breakbeatScore,
        analysisStatus: `BPM: ${refined.bpm}`,
        analysisMs: refined.analysisMs,
        analysisFetchMs: provisionalResult.analysisFetchMs,
        analysisDecodeMs: provisionalResult.analysisDecodeMs,
        analysisTempoMs: refined.analysisTempoMs,
        workerPoolDebug: refined.workerPoolDebug,
        sourceUrl,
        error: undefined,
        tempoDebugBaseBpm: refined.tempoDebugBaseBpm,
        tempoDebugSummary: refined.tempoDebugSummary,
        tempoDebugGate: refined.tempoDebugGate,
        tempoDebugCandidates: refined.tempoDebugCandidates,
        analysisAudioCompleteness: 'full',
        resolvedAudioUrl: String(resolvedUrl || '').trim() || provisionalResult.resolvedAudioUrl,
        bpmDebugSource: 'runtime.full-refined',
        bpmDebugDetail: bpmChanged
          ? 'full-audio BPM refinement replaced provisional partial result'
          : 'full-audio BPM refinement confirmed provisional partial result',
        ts: Date.now()
      };
      await setCachedAnalysis(cacheKey, stabilized);
      // Only push to the content script if the BPM actually changed ---
      // the base result was already presented as final.
      if (bpmChanged) {
        emitUpdate(stabilized);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      logger.warn('tempo refinement failed', error);
      if (signal?.aborted || !isCurrentEpoch()) {
        return;
      }

      // Base result was already presented as final, so just update cache
      // silently --- no need to push a fallback to the content script.
      const fallback: AnalysisResult = {
        ...provisionalResult,
        analysisStatus: `BPM: ${provisionalResult.bpm}`,
        bpmDebugSource: 'runtime.partial-final',
        bpmDebugDetail: 'full-audio BPM refinement failed; keeping provisional partial BPM',
        ts: Date.now()
      };
      await setCachedAnalysis(cacheKey, fallback);
    } finally {
      inFlightTempoRefinementByCacheKey.delete(cacheKey);
    }
  })();

  inFlightTempoRefinementByCacheKey.set(cacheKey, refinementPromise);
}

// ---------------------------------------------------------------------------
// Deferred confidence estimation
// ---------------------------------------------------------------------------

const inFlightConfidenceByCacheKey = new Map<string, Promise<void>>();

export function scheduleConfidenceEstimation(
  audioBuffer: AudioBuffer,
  cacheKey: string,
  result: AnalysisResult,
  normalizedUrl: string,
  signal: AbortSignal | null | undefined,
  isCurrentEpoch: () => boolean,
  emitUpdate: (update: Partial<AnalysisResult>) => void
): void {
  if (!Number.isFinite(result.bpm) || inFlightConfidenceByCacheKey.has(cacheKey)) {
    return;
  }

  const confidencePromise = (async (): Promise<void> => {
    if (signal?.aborted || !isCurrentEpoch()) {
      return;
    }

    const confidence = await estimateTempoConfidence(audioBuffer, {
      minBpm: 70,
      maxBpm: 170,
      quality: 'fast'
    });
    const combinedConfidence = combineTempoConfidence(result, confidence);

    if (signal?.aborted || !isCurrentEpoch()) {
      return;
    }

    const refreshed: AnalysisResult = {
      ...result,
      confidence: combinedConfidence.confidence,
      tempoRawConfidence: combinedConfidence.tempoRawConfidence,
      analysisStatus: `BPM: ${result.bpm} (${combinedConfidence.confidence}% confidence)`,
      ts: Date.now()
    };
    await setCachedAnalysis(cacheKey, refreshed);
    emitUpdate({
      sourceUrl: normalizedUrl,
      confidence: refreshed.confidence,
      tempoRawConfidence: refreshed.tempoRawConfidence,
      analysisStatus: refreshed.analysisStatus,
      ts: refreshed.ts
    });
  })()
    .catch((error) => {
      logger.warn('confidence estimation failed', error);
    })
    .finally(() => {
      inFlightConfidenceByCacheKey.delete(cacheKey);
    });

  inFlightConfidenceByCacheKey.set(cacheKey, confidencePromise);
}
