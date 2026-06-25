import type { AnalysisResult, KeyAnalysisResult } from '@/shared/types';
import type { WaveformBands } from '@/shared/types';
import type { KeyAnalysisTraceEntry } from '@/content/debug/key-analysis-trace';
import type { KeyRequestOptions } from '@/content/analysis/key-request';
import { appendKeyAnalysisTrace, clearKeyAnalysisTrace } from '@/content/debug/key-analysis-trace';
import { requestKeyForSource } from '@/content/analysis/key-request';
import { requestTempoForSource } from '@/content/analysis/tempo-request';
import {
  buildBpmDebugFields,
  formatKeyReadySummary,
  formatKeyTraceDebug
} from '@/content/analysis/debug-helpers';
import {
  resolveNextKeyStatusFromPartial,
  shouldRequestKeyAfterBpmPartial,
  summarizeBpmPartial
} from '@/content/analysis/current-session-helpers';
import { normalizeCacheKey } from '@/content/playlist/track-identity';
import { sendMessage } from '@/utils/messaging';

export interface AnalysisRequestCallbacks {
  // Source & staleness
  getCurrentSourceUrl(): string;
  getRequestSeed(): string;
  isStale(capturedSeed: string, sourceUrl: string): boolean;

  // Settings
  isKeyAnalysisEnabled(): boolean;
  isContextReadyForKeyAnalysis(sourceUrl: string): boolean;

  // Cache key resolution
  resolveSourceCacheKey(sourceUrl: string): string;
  resolveFetchUrl?(sourceUrl: string): string;

  // Cache reads
  getCachedBpm(cacheKey: string): number | undefined;
  getCachedConfidence(cacheKey: string): number | undefined;
  getCachedKeyAnalysis(cacheKey: string): KeyAnalysisResult | undefined;
  getCachedWaveform(cacheKey: string): WaveformBands | undefined;

  // Cache writes
  setCachedBpm(cacheKey: string, bpm: number): void;
  setCachedConfidence(cacheKey: string, confidence: number): void;
  setCachedKeyAnalysis(cacheKey: string, keyAnalysis: KeyAnalysisResult): void;
  setCachedWaveform(cacheKey: string, waveform: WaveformBands): void;
  markFailed(cacheKey: string): void;
  clearFailed(cacheKey: string): void;

  // Attempt tracking
  canAttemptAnalysis(cacheKey: string): boolean;
  registerAttempt(cacheKey: string): void;

  // Track analyzing indicator
  setTrackAnalyzing(cacheKey: string, analyzing: boolean): void;

  // Trace
  getTrace(): KeyAnalysisTraceEntry[];

  // Analysis state (the main coordinator-owned result object)
  getAnalysis(): AnalysisResult | null;
  setAnalysis(analysis: AnalysisResult | null): void;
  getAnalysisRunId(): number;
  incrementAnalysisRunId(): number;

  // Key status resolution
  resolveKeyStatus(keyAnalysis: KeyAnalysisResult | null | undefined): AnalysisResult['keyStatus'];

  // BPM cache map (for debug fields)
  getBpmCacheMap(): Map<string, number>;

  // Side effects (these differ between player and discover)
  render(): void;
  syncPreloadQueue(): void;
  applyDecorations(): void;
  onWaveformSettled(): void;

  // Retry
  scheduleTempoRetry(sourceUrl: string, delayMs: number): void;

  // Empty-source reset (coordinator-specific cleanup)
  onEmptySourceReset(): void;
}

export interface AnalysisRequestController {
  requestTempo(): void;
  // Listening mode: paint the waveform without ever requesting BPM analysis.
  requestWaveformOnly(): void;
  requestKey(sourceUrl: string, bpm: number, cacheKey: string | undefined): void;

  cancelTempo(): void;
  cancelKey(): void;
  cancelAll(): void;

  getActiveTempoTrackCacheKey(): string;
  setActiveTempoTrackCacheKey(key: string): void;
  clearActiveTempoTrackAnalyzing(): void;

  resetRequestKeys(): void;
}

interface CachedAnalysisSnapshot {
  bpm?: number;
  confidence?: number;
  keyAnalysis?: KeyAnalysisResult;
  keyStatus: AnalysisResult['keyStatus'];
  waveform?: WaveformBands;
  hasBpm: boolean;
}

interface PartialTempoSummary {
  bpm: number;
  partialIsRefining: boolean;
  settledStatus: boolean;
  bpmTerminal: boolean;
}

interface PartialAnalysisStateInput {
  currentAnalysis: AnalysisResult | null;
  sourceUrl: string;
  sourceCacheKey: string;
  trackCacheKey: string;
  partial: Partial<AnalysisResult>;
  tempoSummary: PartialTempoSummary;
  receivedAt: number;
}

const isCancelledAnalysisStatus = (statusText: string): boolean =>
  /cancel(?:led|ed)/i.test(String(statusText || ''));

const normalizeAnalysisDurationMs = (partial: Partial<AnalysisResult>): number | undefined => {
  const directMs = Number(partial.analysisMs);
  const fetchMs = Number(partial.analysisFetchMs);
  const decodeMs = Number(partial.analysisDecodeMs);
  const tempoMs = Number(partial.analysisTempoMs);
  const baseMs = Number.isFinite(directMs) && directMs >= 0 ? directMs : undefined;
  const splitParts = [fetchMs, decodeMs, tempoMs].filter(
    (value): value is number => Number.isFinite(value) && value >= 0
  );
  if (!splitParts.length) {
    return baseMs;
  }
  const splitMs = splitParts.reduce((sum, value) => sum + value, 0);
  return baseMs !== undefined ? Math.max(baseMs, splitMs) : splitMs;
};

const sanitizeInlineWaveformPartial = (
  partial: Partial<AnalysisResult>
): Partial<AnalysisResult> => {
  if (partial.analysisAudioCompleteness !== 'partial' || !partial.waveform) {
    return partial;
  }

  return {
    ...partial,
    waveform: undefined,
    waveformStatus: 'Computing waveform...',
    waveformMs: undefined,
    waveformDebugBackendKey: undefined,
    waveformDebugContentKey: undefined
  };
};

const isWaveformBands = (value: unknown): value is WaveformBands => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.peaksLow)
    && Array.isArray(record.peaksMid)
    && Array.isArray(record.peaksHigh)
    && Number.isFinite(record.duration)
    && Number.isFinite(record.buckets);
};

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error ?? 'unknown-error');

const getBestPartialTempoConfidence = (partial: Partial<AnalysisResult>): number => {
  const displayConfidence = Number(partial.confidence);
  const decisionConfidence = Number(partial.tempoDecisionConfidence);
  const rawConfidence = Number(partial.tempoRawConfidence);

  if (Number.isFinite(displayConfidence) && displayConfidence > 0) {
    return displayConfidence;
  }
  if (Number.isFinite(decisionConfidence) && decisionConfidence > 0) {
    return decisionConfidence;
  }
  if (Number.isFinite(rawConfidence) && rawConfidence > 0) {
    return rawConfidence;
  }
  return 0;
};

export function createAnalysisRequestController(
  cb: AnalysisRequestCallbacks
): AnalysisRequestController {
  let cancelTempoRequest: (() => void) | null = null;
  let cancelKeyRequest: (() => void) | null = null;
  let lastTempoRequestKey = '';
  let lastKeyRequestKey = '';
  let lastWaveformRequestKey = '';
  let activeWaveformRequestKey = '';
  let tempoCancelRetryKey = '';
  let tempoCancelRetryCount = 0;
  let activeTempoTrackCacheKey = '';
  let bpmSettleLogged = false;

  const clearActiveTempoTrackAnalyzing = (): void => {
    if (!activeTempoTrackCacheKey) {
      return;
    }
    cb.setTrackAnalyzing(activeTempoTrackCacheKey, false);
    activeTempoTrackCacheKey = '';
  };

  const setActiveTempoTrackFromSource = (sourceUrl: string): void => {
    const nextKey = cb.resolveSourceCacheKey(sourceUrl);
    if (!nextKey) {
      clearActiveTempoTrackAnalyzing();
      return;
    }
    if (activeTempoTrackCacheKey && activeTempoTrackCacheKey !== nextKey) {
      cb.setTrackAnalyzing(activeTempoTrackCacheKey, false);
    }
    activeTempoTrackCacheKey = nextKey;
    if (cb.getCachedBpm(nextKey) === undefined) {
      cb.setTrackAnalyzing(nextKey, true);
    }
  };

  const getCurrentAnalysisForSource = (sourceUrl: string): AnalysisResult | null => {
    const analysis = cb.getAnalysis();
    return analysis && String(analysis.sourceUrl || '').trim() === String(sourceUrl || '').trim()
      ? analysis
      : null;
  };

  // Resolve the analysis a settled result should be written to. `getCurrentAnalysisForSource`
  // matches by exact sourceUrl, but the stored analysis.sourceUrl can lag behind
  // state.currentSrc for the *same track* when its stream URL token refreshes. Callers use
  // this only after `!isStale` has already proven the result belongs to the current source +
  // version, so fall back to the live current analysis rather than dropping a computed
  // waveform that would otherwise sit cached-but-unshown until a re-select.
  const getBindableAnalysisAfterStaleCheck = (sourceUrl: string): AnalysisResult | null =>
    getCurrentAnalysisForSource(sourceUrl) ?? cb.getAnalysis();

  const readCachedAnalysisSnapshot = (sourceCacheKey: string): CachedAnalysisSnapshot => {
    const bpm = sourceCacheKey ? cb.getCachedBpm(sourceCacheKey) : undefined;
    const keyAnalysis = sourceCacheKey && cb.isKeyAnalysisEnabled()
      ? cb.getCachedKeyAnalysis(sourceCacheKey)
      : undefined;

    return {
      bpm,
      confidence: sourceCacheKey ? cb.getCachedConfidence(sourceCacheKey) : undefined,
      keyAnalysis,
      keyStatus: cb.resolveKeyStatus(keyAnalysis ?? null),
      waveform: sourceCacheKey ? cb.getCachedWaveform(sourceCacheKey) : undefined,
      hasBpm: Number.isFinite(bpm)
    };
  };

  const buildInitialAnalysisState = (
    sourceUrl: string,
    sourceCacheKey: string,
    cached: CachedAnalysisSnapshot,
    keyStatus: AnalysisResult['keyStatus']
  ): AnalysisResult => ({
    sourceUrl,
    bpm: cached.hasBpm ? cached.bpm : undefined,
    ...buildBpmDebugFields(
      cached.hasBpm ? 'cache.analysis' : 'runtime.request',
      sourceCacheKey || undefined,
      cached.hasBpm
        ? 'requestTempo reused analysis cache'
        : 'requestTempo waiting for analysis',
      cb.getBpmCacheMap(),
      normalizeCacheKey,
      cached.hasBpm ? Number(cached.bpm) : undefined
    ),
    confidence: cached.hasBpm && Number.isFinite(cached.confidence) ? cached.confidence : undefined,
    tempoDecisionConfidence: cached.hasBpm && Number.isFinite(cached.confidence) ? cached.confidence : undefined,
    tempoDebugBaseBpm: cached.hasBpm ? Number(cached.bpm) : undefined,
    tempoDebugSummary: cached.hasBpm ? `tempo-base bpm=${Math.round(Number(cached.bpm))} method=cache via=playlist` : undefined,
    tempoDebugGate: cached.hasBpm ? 'cache-hit' : undefined,
    tempoDebugCandidates: cached.hasBpm
      ? [{ bpm: Math.round(Number(cached.bpm)), label: 'base', score: 1 }]
      : undefined,
    beatTypeAuto: undefined,
    breakbeatScore: undefined,
    keyAnalysis: cached.keyAnalysis,
    keyDebugSource: cached.keyAnalysis ? 'preload-cache' : undefined,
    keyDebugDetail: cached.keyAnalysis ? `key reused from preload cache key=${sourceCacheKey || '-'}` : undefined,
    keyStatus,
    analysisStatus: cached.hasBpm ? `BPM: ${Math.round(Number(cached.bpm))}` : 'Estimating BPM...',
    analysisMs: cached.hasBpm ? 0 : undefined,
    analysisFetchMs: cached.hasBpm ? 0 : undefined,
    analysisDecodeMs: cached.hasBpm ? 0 : undefined,
    analysisTempoMs: cached.hasBpm ? 0 : undefined,
    analysisServedBy: cached.hasBpm ? 'content-preload-cache' : undefined,
    waveform: cached.waveform || null,
    waveformStatus: '',
    waveformMs: cached.waveform ? 0 : undefined,
    waveformDebugContentKey: cached.waveform && sourceCacheKey ? sourceCacheKey : undefined,
    error: undefined,
    ts: Date.now()
  });

  const resolveCachedStartupKeyStatus = (
    cached: CachedAnalysisSnapshot,
    willStartCurrentKeyRequest: boolean
  ): AnalysisResult['keyStatus'] => {
    if (!cb.isKeyAnalysisEnabled()) {
      return 'disabled';
    }
    if (cached.keyStatus) {
      return cached.keyStatus;
    }
    if (!cached.hasBpm) {
      return 'pending-bpm';
    }
    return willStartCurrentKeyRequest ? 'analyzing' : 'empty';
  };

  const recordPartialTrace = (
    trace: KeyAnalysisTraceEntry[],
    partial: Partial<AnalysisResult>,
    tempoSummary: PartialTempoSummary,
    normalizedAnalysisMs: number | undefined,
    receivedAt: number
  ): void => {
    if (typeof partial.analysisStatus === 'string' && partial.analysisStatus.trim()) {
      let lastStatusEntry: KeyAnalysisTraceEntry | undefined;
      for (let i = trace.length - 1; i >= 0; i--) {
        if (trace[i].stage === 'status') {
          lastStatusEntry = trace[i];
          break;
        }
        if (trace[i].stage === 'bpm-settle') {
          break;
        }
      }
      const isDuplicateStatus = lastStatusEntry?.detail === partial.analysisStatus.trim();
      if (!isDuplicateStatus) {
        appendKeyAnalysisTrace(trace, 'status', partial.analysisStatus.trim(), receivedAt);
      }
    }
    if (cb.isKeyAnalysisEnabled() && partial.keyAnalysis) {
      appendKeyAnalysisTrace(
        trace,
        'key-ready',
        formatKeyReadySummary(partial.keyAnalysis),
        receivedAt
      );
    }
    if (typeof partial.error === 'string' && partial.error.trim()) {
      appendKeyAnalysisTrace(trace, 'error', partial.error.trim(), receivedAt);
    }
    if (tempoSummary.bpmTerminal && !bpmSettleLogged) {
      bpmSettleLogged = true;
      appendKeyAnalysisTrace(
        trace,
        'bpm-settle',
        `bpm=${Number.isFinite(tempoSummary.bpm) ? Math.round(tempoSummary.bpm) : '-'} status=${partial.analysisStatus || '-'} error=${partial.error || '-'} elapsedMs=${Number.isFinite(normalizedAnalysisMs) ? Math.round(Number(normalizedAnalysisMs)) : '-'}`,
        receivedAt
      );
    }
  };

  const cachePartialAnalysisResult = (
    trackCacheKey: string,
    partial: Partial<AnalysisResult>,
    tempoSummary: PartialTempoSummary
  ): void => {
    if (!trackCacheKey) {
      return;
    }

    if (Number.isFinite(tempoSummary.bpm) && !tempoSummary.partialIsRefining) {
      cb.setCachedBpm(trackCacheKey, tempoSummary.bpm);
      const bestConfidence = getBestPartialTempoConfidence(partial);
      if (bestConfidence > 0) {
        cb.setCachedConfidence(trackCacheKey, bestConfidence);
      }
      cb.clearFailed(trackCacheKey);
      tempoCancelRetryCount = 0;
    }
    if (cb.isKeyAnalysisEnabled() && partial.keyAnalysis) {
      cb.setCachedKeyAnalysis(trackCacheKey, partial.keyAnalysis);
    }
    if (partial.waveform) {
      cb.setCachedWaveform(trackCacheKey, partial.waveform);
    }
  };

  const settleActiveTempoTrackFromPartial = (
    trackCacheKey: string,
    partial: Partial<AnalysisResult>,
    tempoSummary: PartialTempoSummary
  ): void => {
    if (!trackCacheKey) {
      return;
    }

    const errorText = typeof partial.error === 'string' ? partial.error.trim() : '';
    if (errorText && !Number.isFinite(tempoSummary.bpm)) {
      cb.markFailed(trackCacheKey);
    }
    if (errorText) {
      cb.setTrackAnalyzing(trackCacheKey, false);
      activeTempoTrackCacheKey = '';
      return;
    }
    if (!tempoSummary.partialIsRefining && (Number.isFinite(partial.confidence) || tempoSummary.settledStatus)) {
      cb.setTrackAnalyzing(trackCacheKey, false);
      activeTempoTrackCacheKey = '';
    }
  };

  const buildPartialAnalysisState = ({
    currentAnalysis,
    sourceUrl,
    sourceCacheKey,
    trackCacheKey,
    partial,
    tempoSummary,
    receivedAt
  }: PartialAnalysisStateInput): AnalysisResult => {
    const partialBpm = tempoSummary.bpm;
    const nextKeyStatus = resolveNextKeyStatusFromPartial({
      keyAnalysisEnabled: cb.isKeyAnalysisEnabled(),
      partial,
      bpm: partialBpm,
      previousKeyStatus: currentAnalysis?.keyStatus
    });

    return {
      ...(currentAnalysis || { ts: Date.now() }),
      sourceUrl,
      ...buildBpmDebugFields(
        Number.isFinite(partialBpm)
          ? 'runtime.interactive-partial'
          : (typeof partial.error === 'string' && partial.error.trim()
            ? 'runtime.failure'
            : 'runtime.pending'),
        trackCacheKey || sourceCacheKey || undefined,
        Number.isFinite(partialBpm)
          ? 'interactive update accepted via applyPartial'
          : (typeof partial.error === 'string' && partial.error.trim()
            ? 'interactive analysis failed'
            : 'interactive analysis pending'),
        cb.getBpmCacheMap(),
        normalizeCacheKey,
        Number.isFinite(partialBpm) ? partialBpm : undefined
      ),
      ...partial,
      keyStatus: nextKeyStatus,
      ts: receivedAt
    };
  };

  const settleWaveformFromPartial = (
    partial: Partial<AnalysisResult>,
    requestKeyValue: string,
    trace: KeyAnalysisTraceEntry[],
    receivedAt: number
  ): void => {
    const waveformTerminalStatus = typeof partial.waveformStatus === 'string'
      && partial.waveformStatus.trim().length > 0
      && partial.waveformStatus.trim() !== 'Computing waveform...';
    if (!(partial.waveform || waveformTerminalStatus) || lastWaveformRequestKey === requestKeyValue) {
      return;
    }

    lastWaveformRequestKey = requestKeyValue;
    appendKeyAnalysisTrace(
      trace,
      'waveform-settle',
      partial.waveform
        ? `status=ready elapsedMs=${Number.isFinite(partial.waveformMs) ? Math.round(Number(partial.waveformMs)) : '-'} buckets=${partial.waveform.buckets}`
        : `status=${partial.waveformStatus || 'failed'} elapsedMs=${Number.isFinite(partial.waveformMs) ? Math.round(Number(partial.waveformMs)) : '-'}`,
      receivedAt
    );
    cb.onWaveformSettled();
    cb.syncPreloadQueue();
  };

  const requestCurrentWaveform = (
    sourceUrl: string,
    fetchUrl: string,
    sourceCacheKey: string,
    requestKeyValue: string,
    trace: KeyAnalysisTraceEntry[],
    seed: string
  ): void => {
    // Partial BPM can settle before full-audio waveform work finishes, so the
    // current track uses the same explicit waveform request path as preload.
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource || activeWaveformRequestKey === requestKeyValue) {
      return;
    }

    const currentAnalysis = getCurrentAnalysisForSource(normalizedSource);
    if (currentAnalysis?.waveform || (sourceCacheKey && cb.getCachedWaveform(sourceCacheKey))) {
      return;
    }

    activeWaveformRequestKey = requestKeyValue;
    const startedAt = Date.now();
    void sendMessage<WaveformBands | { error?: string; debugCacheKey?: string }>({
      type: 'GET_WAVEFORM',
      url: normalizedSource,
      fetchUrl: fetchUrl && fetchUrl !== normalizedSource ? fetchUrl : undefined,
      cacheKey: sourceCacheKey || undefined
    })
      .then((response) => {
        if (activeWaveformRequestKey === requestKeyValue) {
          activeWaveformRequestKey = '';
        }
        if (cb.isStale(seed, normalizedSource)) {
          return;
        }

        if (!isWaveformBands(response)) {
          const responseError = response
            && typeof response === 'object'
            && typeof (response as { error?: unknown }).error === 'string'
            ? String((response as { error?: string }).error || '').trim()
            : 'empty-waveform-response';
          throw new Error(responseError || 'empty-waveform-response');
        }

        const elapsedMs = Date.now() - startedAt;
        if (sourceCacheKey) {
          cb.setCachedWaveform(sourceCacheKey, response);
        }

        const analysis = getBindableAnalysisAfterStaleCheck(normalizedSource);
        if (analysis) {
          const debugCacheKey = response
            && typeof response === 'object'
            && typeof (response as { debugCacheKey?: unknown }).debugCacheKey === 'string'
            ? String((response as { debugCacheKey?: string }).debugCacheKey || '').trim()
            : '';
          cb.setAnalysis({
            ...analysis,
            waveform: response,
            waveformStatus: '',
            waveformMs: elapsedMs,
            waveformDebugContentKey: sourceCacheKey || undefined,
            waveformDebugBackendKey: debugCacheKey || sourceCacheKey || undefined,
            ts: Date.now()
          });
        }

        lastWaveformRequestKey = requestKeyValue;
        appendKeyAnalysisTrace(
          trace,
          'waveform-settle',
          `status=ready elapsedMs=${elapsedMs} buckets=${response.buckets}`,
          Date.now()
        );
        cb.onWaveformSettled();
        cb.syncPreloadQueue();
        cb.applyDecorations();
        cb.render();
      })
      .catch((error) => {
        if (activeWaveformRequestKey === requestKeyValue) {
          activeWaveformRequestKey = '';
        }
        if (cb.isStale(seed, normalizedSource)) {
          return;
        }

        const message = formatErrorMessage(error);
        const analysis = getBindableAnalysisAfterStaleCheck(normalizedSource);
        if (analysis) {
          cb.setAnalysis({
            ...analysis,
            waveform: null,
            waveformStatus: `Waveform failed: ${message}`,
            waveformMs: Date.now() - startedAt,
            ts: Date.now()
          });
        }
        appendKeyAnalysisTrace(
          trace,
          'waveform-settle',
          `status=Waveform failed: ${message} elapsedMs=${Date.now() - startedAt}`,
          Date.now()
        );
        cb.onWaveformSettled();
        cb.syncPreloadQueue();
        cb.render();
      });
  };

  const resetRequestKeys = (): void => {
    lastTempoRequestKey = '';
    lastKeyRequestKey = '';
    lastWaveformRequestKey = '';
    activeWaveformRequestKey = '';
  };

  const cancelTempo = (): void => {
    cancelTempoRequest?.();
    cancelTempoRequest = null;
  };

  const cancelKey = (): void => {
    cancelKeyRequest?.();
    cancelKeyRequest = null;
  };

  const cancelAll = (): void => {
    cancelTempo();
    cancelKey();
  };

  const setKeyAnalysisPending = (sourceUrl: string): void => {
    const analysis = getCurrentAnalysisForSource(sourceUrl);
    if (!analysis) {
      return;
    }

    cb.setAnalysis({
      ...analysis,
      keyStatus: 'analyzing',
      ts: Date.now()
    });
    cb.render();
  };

  const applyKeyAnalysisSuccess = (
    sourceUrl: string,
    sourceCacheKey: string | undefined,
    keyAnalysis: KeyAnalysisResult,
    keyStatus: AnalysisResult['keyStatus'],
    debug: Parameters<KeyRequestOptions['onSuccess']>[3]
  ): void => {
    if (sourceCacheKey) {
      cb.setCachedKeyAnalysis(sourceCacheKey, keyAnalysis);
      cb.setTrackAnalyzing(sourceCacheKey, false);
    }

    const analysis = getCurrentAnalysisForSource(sourceUrl);
    if (analysis) {
      cb.setAnalysis({
        ...analysis,
        keyAnalysis,
        keyStatus,
        keyDebugSource: debug?.source,
        keyDebugDetail: debug?.detail,
        keyDebugCacheKey: debug?.cacheKey,
        keyDebugTimingMs: debug?.timingMs,
        keyDebugDecodeMs: debug?.decodeMs,
        keyDebugPreprocessMs: debug?.preprocessMs,
        keyDebugComputeMs: debug?.computeMs,
        ts: Date.now()
      });
    }
    cb.applyDecorations();
    cb.render();
  };

  const applyKeyAnalysisFailure = (
    sourceUrl: string,
    sourceCacheKey: string | undefined
  ): void => {
    if (sourceCacheKey) {
      cb.setTrackAnalyzing(sourceCacheKey, false);
    }

    const analysis = getCurrentAnalysisForSource(sourceUrl);
    if (analysis) {
      cb.setAnalysis({
        ...analysis,
        keyStatus: 'error',
        ts: Date.now()
      });
    }
    cb.applyDecorations();
    cb.render();
  };

  const requestKey = (
    sourceUrl: string,
    bpm: number,
    sourceCacheKey: string | undefined
  ): void => {
    if (!cb.isKeyAnalysisEnabled()) {
      return;
    }

    const normalizedSource = String(sourceUrl || '').trim();
    const roundedBpm = Number.isFinite(bpm) ? Math.round(Number(bpm)) : 0;
    if (!normalizedSource || !Number.isFinite(roundedBpm) || roundedBpm <= 0) {
      return;
    }

    const seed = cb.getRequestSeed();
    const requestKey = `${seed}|${normalizedSource}|${roundedBpm}`;
    if (requestKey === lastKeyRequestKey) {
      return;
    }

    cancelKeyRequest?.();
    cancelKeyRequest = null;
    lastKeyRequestKey = requestKey;

    const trace = cb.getTrace();
    if (sourceCacheKey) {
      cb.setTrackAnalyzing(sourceCacheKey, true);
    }
    appendKeyAnalysisTrace(
      trace,
      'key-start',
      `version=${seed} source=${normalizedSource} bpm=${roundedBpm} cacheKey=${sourceCacheKey || '-'}`
    );

    cancelKeyRequest = requestKeyForSource({
      sourceUrl: normalizedSource,
      bpm: roundedBpm,
      cacheKey: sourceCacheKey,
      shouldApply: () => !cb.isStale(seed, normalizedSource) && cb.isKeyAnalysisEnabled(),
      onPending: () => {
        setKeyAnalysisPending(normalizedSource);
      },
      onSuccess: (keyAnalysis, keyStatus, _elapsedMs, debug) => {
        appendKeyAnalysisTrace(
          trace,
          'key-ready',
          `${formatKeyReadySummary(keyAnalysis)} ${formatKeyTraceDebug(debug)}`,
          Date.now()
        );
        applyKeyAnalysisSuccess(normalizedSource, sourceCacheKey, keyAnalysis, keyStatus, debug);
      },
      onFailure: (statusText) => {
        appendKeyAnalysisTrace(trace, 'failure', statusText, Date.now());
        applyKeyAnalysisFailure(normalizedSource, sourceCacheKey);
      },
      onDropped: (reason, elapsedMs) => {
        appendKeyAnalysisTrace(trace, 'dropped', `${reason} elapsedMs=${elapsedMs}`, Date.now());
      }
    });
  };

  const maybeStartCurrentKeyFromSettledTempo = (
    sourceUrl: string,
    sourceCacheKey: string
  ): boolean => {
    if (!cb.isKeyAnalysisEnabled() || !cb.isContextReadyForKeyAnalysis(sourceUrl)) {
      return false;
    }
    if (sourceCacheKey && cb.getCachedKeyAnalysis(sourceCacheKey)) {
      return false;
    }

    const analysis = getCurrentAnalysisForSource(sourceUrl);
    if (!analysis || analysis.keyAnalysis) {
      return false;
    }

    const keyStatus = analysis.keyStatus;
    if (
      keyStatus === 'analyzing'
      || keyStatus === 'ready'
      || keyStatus === 'error'
      || keyStatus === 'disabled'
    ) {
      return false;
    }

    const bpm = Number(analysis.bpm);
    if (!Number.isFinite(bpm) || bpm <= 0) {
      return false;
    }

    requestKey(sourceUrl, bpm, sourceCacheKey || undefined);
    return true;
  };

  const applyTempoStartupFromCache = (
    sourceUrl: string,
    sourceCacheKey: string,
    requestKeyValue: string,
    trace: KeyAnalysisTraceEntry[],
    cached: CachedAnalysisSnapshot
  ): boolean => {
    const willStartCurrentKeyRequest = Boolean(
      cached.hasBpm
      && cb.isKeyAnalysisEnabled()
      && !cached.keyAnalysis
      && cb.isContextReadyForKeyAnalysis(sourceUrl)
    );
    cb.setAnalysis(buildInitialAnalysisState(
      sourceUrl,
      sourceCacheKey,
      cached,
      resolveCachedStartupKeyStatus(cached, willStartCurrentKeyRequest)
    ));
    if (cached.waveform) {
      lastWaveformRequestKey = requestKeyValue;
      appendKeyAnalysisTrace(
        trace,
        'waveform-start',
        `source=${sourceUrl} cacheKey=${sourceCacheKey || '-'} sourceType=cache`
      );
      appendKeyAnalysisTrace(
        trace,
        'waveform-settle',
        `status=ready source=cache elapsedMs=0 buckets=${cached.waveform.buckets}`,
        Date.now()
      );
      cb.onWaveformSettled();
      cb.syncPreloadQueue();
    } else {
      appendKeyAnalysisTrace(
        trace,
        'waveform-seed',
        `source=${sourceUrl} cacheKey=${sourceCacheKey || '-'} reason=tempo-bootstrap`
      );
      appendKeyAnalysisTrace(
        trace,
        'waveform-start',
        `source=${sourceUrl} cacheKey=${sourceCacheKey || '-'} sourceType=current-analysis`
      );
    }
    cb.render();

    bpmSettleLogged = false;
    if (!cached.hasBpm) {
      return false;
    }

    bpmSettleLogged = true;
    appendKeyAnalysisTrace(
      trace,
      'bpm-settle',
      `bpm=${Math.round(Number(cached.bpm))} status=cache analysis elapsedMs=0`,
      Date.now()
    );
    if (willStartCurrentKeyRequest) {
      requestKey(sourceUrl, Number(cached.bpm), sourceCacheKey || undefined);
    } else {
      cb.applyDecorations();
      cb.render();
    }

    return Boolean(cached.waveform) && !(
      cached.hasBpm
      && cb.isKeyAnalysisEnabled()
      && !cached.keyAnalysis
      && !willStartCurrentKeyRequest
    );
  };

  const requestTempo = (): void => {
    const sourceUrl = cb.getCurrentSourceUrl();
    const seed = cb.getRequestSeed();
    const fetchUrl = String(cb.resolveFetchUrl?.(sourceUrl) || '').trim();
    const effectiveFetchUrl = fetchUrl || sourceUrl;
    const sourceCacheKey = cb.resolveSourceCacheKey(sourceUrl);
    const requestIdentity = sourceCacheKey || sourceUrl;
    const requestKeyValue = `${seed}|${sourceUrl}|${requestIdentity}`;
    const trace = cb.getTrace();

    if (!sourceUrl) {
      clearKeyAnalysisTrace(trace);
      cancelTempo();
      cancelKey();
      lastTempoRequestKey = '';
      lastKeyRequestKey = '';
      tempoCancelRetryKey = '';
      tempoCancelRetryCount = 0;
      cb.onEmptySourceReset();
      return;
    }

    if (requestKeyValue === lastTempoRequestKey) {
      maybeStartCurrentKeyFromSettledTempo(sourceUrl, sourceCacheKey);
      return;
    }

    cancelTempo();
    cancelKey();
    lastKeyRequestKey = '';
    clearActiveTempoTrackAnalyzing();
    clearKeyAnalysisTrace(trace);
    appendKeyAnalysisTrace(
      trace,
      'request',
      `version=${seed} source=${sourceUrl} fetch=${effectiveFetchUrl}`
    );
    appendKeyAnalysisTrace(
      trace,
      'bpm-start',
      `version=${seed} source=${sourceUrl} fetch=${effectiveFetchUrl}`
    );
    lastTempoRequestKey = requestKeyValue;
    if (tempoCancelRetryKey !== requestKeyValue) {
      tempoCancelRetryKey = requestKeyValue;
      tempoCancelRetryCount = 0;
    }

    const cached = readCachedAnalysisSnapshot(sourceCacheKey);

    if (sourceCacheKey) {
      cb.clearFailed(sourceCacheKey);
      activeTempoTrackCacheKey = sourceCacheKey;
      if (!cached.hasBpm) {
        // Only count an attempt when a real analysis will run. A cache hit (and
        // the cancel-retry that re-enters with cleared dedup key) must not inflate
        // the attempt counter toward the per-track max — that previously made the
        // now-playing track show attempts=2-3 with zero extra analysis.
        cb.registerAttempt(sourceCacheKey);
        cb.setTrackAnalyzing(sourceCacheKey, true);
      }
    }

    if (applyTempoStartupFromCache(sourceUrl, sourceCacheKey, requestKeyValue, trace, cached)) {
      return;
    }

    const applyPartial = (partial: Partial<AnalysisResult>): void => {
      const receivedAt = Date.now();
      const effectivePartial = sanitizeInlineWaveformPartial(partial);
      const normalizedAnalysisMs = normalizeAnalysisDurationMs(partial);

      const currentAnalysis = cb.getAnalysis();
      const analysisAlreadySettled = Boolean(
        Number.isFinite(currentAnalysis?.confidence) ||
        (typeof currentAnalysis?.error === 'string' && currentAnalysis.error.trim())
      );
      if (!activeTempoTrackCacheKey && !analysisAlreadySettled) {
        setActiveTempoTrackFromSource(sourceUrl);
      }

      const trackCacheKey = activeTempoTrackCacheKey;
      const tempoSummary = summarizeBpmPartial(effectivePartial);
      const partialBpm = tempoSummary.bpm;
      recordPartialTrace(trace, effectivePartial, tempoSummary, normalizedAnalysisMs, receivedAt);
      cachePartialAnalysisResult(trackCacheKey, effectivePartial, tempoSummary);
      settleActiveTempoTrackFromPartial(trackCacheKey, effectivePartial, tempoSummary);

      const sanitizedPartial: Partial<AnalysisResult> = cb.isKeyAnalysisEnabled()
        ? effectivePartial
        : { ...effectivePartial, keyAnalysis: undefined };
      if (Number.isFinite(normalizedAnalysisMs)) {
        sanitizedPartial.analysisMs = normalizedAnalysisMs;
      }
      if (sanitizedPartial.waveform && trackCacheKey && !sanitizedPartial.waveformDebugContentKey) {
        sanitizedPartial.waveformDebugContentKey = trackCacheKey;
      }

      cb.setAnalysis(buildPartialAnalysisState({
        currentAnalysis,
        sourceUrl,
        sourceCacheKey,
        trackCacheKey,
        partial: sanitizedPartial,
        tempoSummary,
        receivedAt
      }));

      if (
        !sanitizedPartial.waveform
        && String(sanitizedPartial.waveformStatus || '').trim() === 'Computing waveform...'
      ) {
        requestCurrentWaveform(
          sourceUrl,
          effectiveFetchUrl,
          trackCacheKey || sourceCacheKey,
          requestKeyValue,
          trace,
          seed
        );
      }

      settleWaveformFromPartial(sanitizedPartial, requestKeyValue, trace, receivedAt);

      if (shouldRequestKeyAfterBpmPartial({
        keyAnalysisEnabled: cb.isKeyAnalysisEnabled(),
        partial,
        bpm: partialBpm,
        settledStatus: tempoSummary.settledStatus,
        contextReady: cb.isContextReadyForKeyAnalysis(sourceUrl)
      })) {
        requestKey(sourceUrl, partialBpm, trackCacheKey || sourceCacheKey || undefined);
      }

      cb.applyDecorations();
      cb.render();
    };

    cancelTempoRequest = requestTempoForSource({
      sourceUrl,
      fetchUrl: effectiveFetchUrl !== sourceUrl ? effectiveFetchUrl : undefined,
      cacheKey: sourceCacheKey || undefined,
      shouldApply: () => !cb.isStale(seed, sourceUrl),
      onPending: (statusText) => {
        if (cached.hasBpm) {
          return;
        }
        applyPartial({
          analysisStatus: statusText,
          analysisMs: undefined,
          error: undefined
        });
      },
      onPartial: (partial) => {
        applyPartial(partial);
      },
      onFailure: (statusText, elapsedMs) => {
        if (
          isCancelledAnalysisStatus(statusText)
          && tempoCancelRetryKey === requestKeyValue
          && tempoCancelRetryCount < 2
          && (sourceCacheKey ? cb.canAttemptAnalysis(sourceCacheKey) : true)
          && !cb.isStale(seed, sourceUrl)
        ) {
          tempoCancelRetryCount += 1;
          applyPartial({
            analysisStatus: 'Retrying BPM analysis...',
            analysisMs: elapsedMs,
            error: undefined,
            ts: Date.now()
          });
          lastTempoRequestKey = '';
          cb.scheduleTempoRetry(sourceUrl, 140);
          return;
        }

        const failedCacheKey = normalizeCacheKey(activeTempoTrackCacheKey || sourceCacheKey);
        if (failedCacheKey && cb.getCachedBpm(failedCacheKey) === undefined) {
          cb.markFailed(failedCacheKey);
        }

        applyPartial({
          analysisStatus: statusText,
          analysisMs: elapsedMs,
          error: statusText
        });
        appendKeyAnalysisTrace(trace, 'failure', statusText, Date.now());
      }
    });

    // Decouple the waveform from BPM: the waveform only needs the decoded PCM,
    // which is ready well before tempo finishes. Fire the standalone waveform
    // request in parallel with the tempo request so it paints at decode time
    // instead of waiting for the full corrected-tempo pass. The offscreen
    // dedupes decode by cache key, so this shares the analysis decode rather
    // than triggering a second fetch, and requestCurrentWaveform no-ops when a
    // waveform is already present or cached.
    requestCurrentWaveform(
      sourceUrl,
      effectiveFetchUrl,
      sourceCacheKey,
      requestKeyValue,
      trace,
      seed
    );
  };

  // Listening mode entry point: seed the analysis object for the current source and request the
  // waveform only — never the tempo/BPM pass. Reuses the same source/cacheKey/requestKey resolution
  // and the standalone `requestCurrentWaveform` the normal path fires in parallel, so the waveform
  // paints at decode time exactly as it does with BPM enabled, just without any BPM work.
  const requestWaveformOnly = (): void => {
    const sourceUrl = cb.getCurrentSourceUrl();
    const seed = cb.getRequestSeed();
    const fetchUrl = String(cb.resolveFetchUrl?.(sourceUrl) || '').trim();
    const effectiveFetchUrl = fetchUrl || sourceUrl;
    const sourceCacheKey = cb.resolveSourceCacheKey(sourceUrl);
    const requestIdentity = sourceCacheKey || sourceUrl;
    const requestKeyValue = `${seed}|${sourceUrl}|${requestIdentity}`;
    const trace = cb.getTrace();

    if (!sourceUrl) {
      clearKeyAnalysisTrace(trace);
      cancelTempo();
      cancelKey();
      lastTempoRequestKey = '';
      lastKeyRequestKey = '';
      tempoCancelRetryKey = '';
      tempoCancelRetryCount = 0;
      cb.onEmptySourceReset();
      return;
    }

    if (requestKeyValue === lastTempoRequestKey) {
      return;
    }

    cancelTempo();
    cancelKey();
    lastKeyRequestKey = '';
    clearActiveTempoTrackAnalyzing();
    clearKeyAnalysisTrace(trace);
    appendKeyAnalysisTrace(
      trace,
      'request',
      `version=${seed} source=${sourceUrl} fetch=${effectiveFetchUrl} mode=listening`
    );
    lastTempoRequestKey = requestKeyValue;
    if (sourceCacheKey) {
      cb.clearFailed(sourceCacheKey);
      activeTempoTrackCacheKey = sourceCacheKey;
    }

    // No BPM in listening mode, even if a value lingers in the cache from a prior session: force
    // an empty (no-bpm, key-disabled) snapshot so only the waveform binds to the analysis object.
    const cachedWaveform = sourceCacheKey ? cb.getCachedWaveform(sourceCacheKey) : undefined;
    const initial = buildInitialAnalysisState(
      sourceUrl,
      sourceCacheKey,
      {
        bpm: undefined,
        confidence: undefined,
        keyAnalysis: undefined,
        keyStatus: cb.resolveKeyStatus(null),
        waveform: cachedWaveform,
        hasBpm: false
      },
      'disabled'
    );
    cb.setAnalysis({ ...initial, analysisStatus: '' });

    if (cachedWaveform) {
      lastWaveformRequestKey = requestKeyValue;
      cb.onWaveformSettled();
      cb.syncPreloadQueue();
    }
    cb.applyDecorations();
    cb.render();

    requestCurrentWaveform(sourceUrl, effectiveFetchUrl, sourceCacheKey, requestKeyValue, trace, seed);
  };

  return {
    requestTempo,
    requestWaveformOnly,
    requestKey,
    cancelTempo,
    cancelKey,
    cancelAll,
    getActiveTempoTrackCacheKey: () => activeTempoTrackCacheKey,
    setActiveTempoTrackCacheKey: (key: string) => { activeTempoTrackCacheKey = key; },
    clearActiveTempoTrackAnalyzing,
    resetRequestKeys
  };
}
