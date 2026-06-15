import { decodeAudio } from '@/background/audio/decoder';
import { analyzeTempoBySparseWindows } from '@/background/audio/tempo-segment-prototype';
import { extractRhythmEvidence, refineTempoToBeatGrid } from '@/background/audio/tempo';
import type { TempoGridRefinement } from '@/shared/types';
import { computeAndCacheWaveformForUrl } from '@/background/audio/waveform';
import { computeWaveformBands } from '@/background/audio/waveform-core';
import { analyzeKeyDebug, analyzeKeyDetailed } from '@/background/key-essentia';
import {
  buildAnalysisCacheKey,
  clearAllAnalysisCaches,
  clearInFlightKeyAnalysis,
  clearInFlightAnalysis,
  getAnalysisCacheEpoch,
  getCachedKeyAnalysis,
  getCachedAnalysis,
  getDecodedAudioInFlightCount,
  getDecodedAudioState,
  getInFlightKeyAnalysis,
  getInFlightAnalysis,
  resolveAnalysisCacheIdentity,
  setCachedKeyAnalysis,
  setCachedAnalysis,
  setInFlightKeyAnalysis,
  setInFlightAnalysis
} from '@/background/cache';
import type {
  AnalysisResult,
  AnalyzeBpmPrototypeMessage,
  AnalyzeBpmPrototypeResponse,
  AnalyzeKeyDebugMessage,
  AnalyzeKeyDebugResponse,
  BackgroundPush,
  ContentMessage,
  KeyAnalysisResult,
  KeyAnalysisStatus,
  WaveformBands
} from '@/shared/types';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';
import {
  createAbortError,
  isAbortError,
  throwIfAborted,
  awaitWithAbort,
  fetchAudioArrayBuffer,
  getDecodedAudioWithTiming,
  fullAudioUpgradeInFlight
} from './analysis-audio-fetch';
import {
  resolveTempoForAnalysis,
  analyzeAudioBuffer,
  buildWorkerPoolDebug,
  scheduleTempoRefinement,
  scheduleConfidenceEstimation,
  shouldEstimateConfidence,
  inFlightTempoRefinementByCacheKey,
  resolveKeyStatus,
  ANALYSIS_EXECUTION_OPTIONS
} from './analysis-tempo';
import type {
  TempoAnalysisMode,
  AnalysisExecutionOptions,
  KeyAnalysisRuntimeDebug
} from './analysis-tempo';

const logger = createLogger('ANALYZER');

const TEMPO_REFINING_STATUS_SUFFIX = ' (refining full audio...)';
const CURRENT_INLINE_WAVEFORM_BUCKETS = 300;

interface AnalysisErrorResponse {
  error: string;
  ts: number;
}

interface AnalysisCancelledResponse {
  cancelled: boolean;
  ts: number;
}

function isRefiningTempoAnalysisStatus(status: string | undefined): boolean {
  return String(status || '').trim().toLowerCase().includes('refining');
}


type AnalyzeTrackResponse = AnalysisResult | AnalysisErrorResponse | AnalysisCancelledResponse;
type AnalyzeKeyResponse =
  | ({ keyAnalysis: KeyAnalysisResult; keyStatus: KeyAnalysisStatus; ts: number } & Partial<KeyAnalysisRuntimeDebug>)
  | AnalysisErrorResponse
  | AnalysisCancelledResponse;

interface ActiveAnalysis {
  url: string;
  fetchUrl?: string;
  controller: AbortController;
}

const activeAnalysisByTab = new Map<number, ActiveAnalysis>();
const activeKeyAnalysisByTab = new Map<number, Map<string, ActiveAnalysis>>();

function readTrackIdFromUrl(sourceUrl: string): string {
  const src = String(sourceUrl || '').trim();
  if (!src) {
    return '';
  }

  try {
    const parsed = new URL(src, 'https://bandcamp.com');
    const fromParam = parsed.searchParams.get('track_id') || parsed.searchParams.get('trackid') || '';
    if (fromParam) {
      return fromParam.trim();
    }
  } catch {
    // Ignore parsing failures and use regex fallback.
  }

  const match = src.match(/[?&](?:track_id|trackid)=(\d+)/i) || src.match(/\/track\/(\d+)\b/i);
  return match?.[1] ? String(match[1]).trim() : '';
}

function resolveWaveformCacheIdentity(url: string, cacheKey?: string): string {
  const explicit = String(cacheKey || '').trim();
  if (explicit) {
    return explicit;
  }

  const trackId = readTrackIdFromUrl(url);
  if (trackId) {
    return `track:${trackId}`;
  }

  return url;
}

function resolveKeyAnalysisCacheKey(cacheIdentity: string, bpm: number): string {
  return buildAnalysisCacheKey(`${cacheIdentity}|key|bpm:${Math.round(Number(bpm) || 0)}`);
}

function buildAnalysisExecutionKey(
  cacheIdentity: string,
  fetchUrl: string,
  options: AnalysisExecutionOptions
): string {
  return `${cacheIdentity}|fetch:${String(fetchUrl || '').trim()}|partial:${options.usePartialFetch ? '1' : '0'}`;
}

type WaveformAnalysisUpdate = Pick<
  AnalysisResult,
  'waveform' | 'waveformStatus' | 'waveformMs' | 'waveformDebugBackendKey'
>;

async function computeWaveformAnalysisUpdate(
  cacheIdentity: string,
  fetchUrl: string
): Promise<WaveformAnalysisUpdate> {
  const waveformStartedAt = Date.now();

  try {
    const waveform = await computeAndCacheWaveformForUrl(fetchUrl, cacheIdentity);
    return {
      waveform,
      waveformStatus: '',
      waveformMs: Date.now() - waveformStartedAt,
      waveformDebugBackendKey: cacheIdentity
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.warn('current-track waveform hydration failed', { cacheIdentity, fetchUrl, error });
    return {
      waveform: null,
      waveformStatus: `Waveform failed: ${message}`,
      waveformMs: Date.now() - waveformStartedAt,
      waveformDebugBackendKey: cacheIdentity
    };
  }
}

function computeInlineWaveformAnalysisUpdate(
  audioBuffer: AudioBuffer,
  cacheIdentity: string
): WaveformAnalysisUpdate {
  const waveformStartedAt = Date.now();

  try {
    return {
      waveform: computeWaveformBands(audioBuffer, CURRENT_INLINE_WAVEFORM_BUCKETS),
      waveformStatus: '',
      waveformMs: Date.now() - waveformStartedAt,
      waveformDebugBackendKey: cacheIdentity
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('current-track inline waveform failed', { cacheIdentity, error });
    return {
      waveform: null,
      waveformStatus: `Waveform failed: ${message}`,
      waveformMs: Date.now() - waveformStartedAt,
      waveformDebugBackendKey: cacheIdentity
    };
  }
}

async function analyzeKeyInternal(
  url: string,
  cacheIdentity: string,
  bpm: number,
  signal?: AbortSignal | null
): Promise<{ keyAnalysis: KeyAnalysisResult; debug: KeyAnalysisRuntimeDebug }> {
  const normalizedUrl = String(url || '').trim();
  const cacheKey = resolveKeyAnalysisCacheKey(cacheIdentity, bpm);
  const cached = getCachedKeyAnalysis(cacheKey);
  if (cached) {
    return {
      keyAnalysis: cached,
      debug: {
        keyDebugSource: 'cache.key-analysis',
        keyDebugDetail: 'keyCache=hit',
        keyDebugCacheKey: cacheKey,
        keyDebugTimingMs: 0,
        keyDebugDecodeMs: 0,
        keyDebugPreprocessMs: 0,
        keyDebugComputeMs: 0
      }
    };
  }

  const inFlight = getInFlightKeyAnalysis(cacheKey);
  if (inFlight) {
    const waitStartedAt = performance.now();
    const shared = await awaitWithAbort(inFlight, signal);
    return {
      keyAnalysis: shared,
      debug: {
        keyDebugSource: 'shared.key-analysis',
        keyDebugDetail: 'keyCache=in-flight',
        keyDebugCacheKey: cacheKey,
        keyDebugTimingMs: Math.round(performance.now() - waitStartedAt),
        keyDebugDecodeMs: 0,
        keyDebugPreprocessMs: 0,
        keyDebugComputeMs: 0
      }
    };
  }

  const keyPromise = (async (): Promise<{ keyAnalysis: KeyAnalysisResult; debug: KeyAnalysisRuntimeDebug }> => {
    try {
      const keyStartedAt = performance.now();
      const decodeState = getDecodedAudioState(cacheIdentity);
      const upgradeInFlight = fullAudioUpgradeInFlight.has(cacheIdentity);
      const upgradeCount = fullAudioUpgradeInFlight.size;
      const decodeQueue = getDecodedAudioInFlightCount();
      const { audioBuffer, timing, resolveMs, completeness } = await awaitWithAbort(
        getDecodedAudioWithTiming(cacheIdentity, normalizedUrl, signal, {
          requireFull: true
        }),
        signal
      );
      throwIfAborted(signal);
      const { result: keyAnalysis, timing: keyTiming } = await analyzeKeyDetailed(audioBuffer, bpm);
      setCachedKeyAnalysis(cacheKey, keyAnalysis);
      const decodeDetail = decodeState === 'cached-full'
        ? 'decode=cache-hit-full'
        : decodeState === 'cached-partial'
          ? `decode=cache-upgrade waitMs=${resolveMs}`
          : decodeState === 'in-flight'
          ? `decode=cache-wait waitMs=${resolveMs}`
          : `decode=fresh-${completeness} fetchMs=${timing.fetchMs} decodeMs=${timing.decodeMs}`;
      const stageDetail = `stages=diag:${keyTiming.diagnosticsMs}|prefilter:${keyTiming.prefilterMs}|hpcp:${keyTiming.hpcpMs}|score:${keyTiming.scoreMs}|aggregate:${keyTiming.aggregateMs}`;
      const prefilterDispatchDetail = keyTiming.prefilterDispatchDetail ? ` ${keyTiming.prefilterDispatchDetail}` : '';
      const frameStageDetail = keyTiming.frameStageDetail ? ` ${keyTiming.frameStageDetail}` : '';
      const dispatchDetail = keyTiming.dispatchDetail ? ` ${keyTiming.dispatchDetail}` : '';
      const comparisonDetail = keyTiming.comparisonDetail ? ` ${keyTiming.comparisonDetail}` : '';
      return {
        keyAnalysis,
        debug: {
          keyDebugSource: 'runtime.key-analysis',
          keyDebugDetail: `${decodeDetail} completeness=${completeness} upgradeInFlight=${upgradeInFlight ? '1' : '0'} upgradeCount=${upgradeCount} decodeQueue=${decodeQueue} ${stageDetail}${prefilterDispatchDetail}${frameStageDetail}${dispatchDetail}${comparisonDetail}`,
          keyDebugCacheKey: cacheKey,
          keyDebugTimingMs: Math.round(performance.now() - keyStartedAt),
          keyDebugDecodeMs: Math.round(resolveMs),
          keyDebugPreprocessMs: keyTiming.preprocessMs,
          keyDebugComputeMs: keyTiming.computeMs
        }
      };
    } finally {
      clearInFlightKeyAnalysis(cacheKey);
    }
  })();

  setInFlightKeyAnalysis(cacheKey, keyPromise.then(({ keyAnalysis }) => keyAnalysis));
  return await awaitWithAbort(keyPromise, signal);
}

async function sendPushToTab(tabId: number, push: BackgroundPush): Promise<void> {
  if (!browserApi.tabs?.sendMessage) {
    return;
  }

  try {
    const maybePromise = browserApi.tabs.sendMessage(tabId, push);
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      await (maybePromise as Promise<unknown>).catch(() => undefined);
      return;
    }
  } catch {
    // Fall through and try callback mode.
  }

  await new Promise<void>((resolve) => {
    try {
      browserApi.tabs.sendMessage(tabId, push, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function analyzeTrackInternal(
  url: string,
  cacheIdentity: string,
  enableKeyAnalysis: boolean,
  options: AnalysisExecutionOptions,
  signal?: AbortSignal | null,
  onUpdate?: (update: Partial<AnalysisResult>) => void,
  fetchUrl?: string
): Promise<AnalysisResult> {
  const normalizedUrl = String(url || '').trim();
  const normalizedFetchUrl = String(fetchUrl || normalizedUrl || '').trim() || normalizedUrl;
  const cacheKey = buildAnalysisCacheKey(cacheIdentity);
  const executionKey = buildAnalysisExecutionKey(cacheIdentity, normalizedFetchUrl, options);
  const analysisEpoch = getAnalysisCacheEpoch();
  const isCurrentEpoch = (): boolean => analysisEpoch === getAnalysisCacheEpoch();
  const throwIfStale = (): void => {
    if (!isCurrentEpoch()) {
      throw createAbortError();
    }
  };
  const emitUpdate = (update: Partial<AnalysisResult>): void => {
    if (!isCurrentEpoch()) {
      return;
    }
    onUpdate?.(update);
  };

  const cached = await getCachedAnalysis(cacheKey);
  throwIfStale();
  if (cached) {
    emitUpdate({ ...cached, sourceUrl: normalizedUrl, analysisStatus: cached.analysisStatus || 'Cached', workerPoolDebug: buildWorkerPoolDebug() });
    let cachedResult = cached;
    if (isRefiningTempoAnalysisStatus(cached.analysisStatus)) {
      scheduleTempoRefinement(
        cacheIdentity,
        cacheKey,
        cached,
        normalizedUrl,
        normalizedFetchUrl,
        enableKeyAnalysis,
        signal,
        isCurrentEpoch,
        emitUpdate
      );
      // Await the refinement so the sendMessage response returns the
      // corrected result instead of the stale "refining" status.
      const refinement = inFlightTempoRefinementByCacheKey.get(cacheKey);
      if (refinement) {
        await refinement.catch(() => undefined);
        const corrected = await getCachedAnalysis(cacheKey);
        if (corrected) {
          cachedResult = corrected;
        }
      }
    }
    if (shouldEstimateConfidence(cachedResult, options)) {
      void getDecodedAudioWithTiming(cacheIdentity, normalizedFetchUrl, signal)
        .then(({ audioBuffer }) => {
          scheduleConfidenceEstimation(audioBuffer, cacheKey, cachedResult, normalizedUrl, signal, isCurrentEpoch, emitUpdate);
        })
        .catch((error) => {
          logger.warn('cached confidence warm-up failed', error);
        });
    }
    if (onUpdate && !cachedResult.waveform && !cachedResult.waveformStatus) {
      const waveformUpdate = await computeWaveformAnalysisUpdate(cacheIdentity, normalizedFetchUrl);
      throwIfAborted(signal);
      throwIfStale();
      const hydratedResult: AnalysisResult = {
        ...cachedResult,
        sourceUrl: normalizedUrl,
        ...waveformUpdate,
        analysisServedBy: 'background-cache',
        ts: Date.now()
      };
      if (isCurrentEpoch()) {
        await setCachedAnalysis(cacheKey, hydratedResult);
      }
      return { ...hydratedResult, workerPoolDebug: buildWorkerPoolDebug() };
    }
    return { ...cachedResult, workerPoolDebug: buildWorkerPoolDebug(), analysisServedBy: 'background-cache' };
  }

  const inFlight = getInFlightAnalysis(executionKey);
  if (inFlight) {
    let shared = await awaitWithAbort(inFlight, signal);
    throwIfStale();
    if (onUpdate && !shared.waveform && !shared.waveformStatus) {
      const waveformUpdate = await computeWaveformAnalysisUpdate(cacheIdentity, normalizedFetchUrl);
      throwIfAborted(signal);
      throwIfStale();
      shared = {
        ...shared,
        sourceUrl: normalizedUrl,
        ...waveformUpdate,
        analysisServedBy: 'background-in-flight',
        ts: Date.now()
      };
      if (isCurrentEpoch()) {
        await setCachedAnalysis(cacheKey, shared);
      }
    }
    const poolDebug = buildWorkerPoolDebug();
    emitUpdate({
      bpm: shared.bpm,
      confidence: shared.confidence,
      tempoRawConfidence: shared.tempoRawConfidence,
      tempoDecisionConfidence: shared.tempoDecisionConfidence,
      analysisFetchMs: shared.analysisFetchMs,
      analysisDecodeMs: shared.analysisDecodeMs,
      analysisTempoMs: shared.analysisTempoMs,
      keyAnalysis: shared.keyAnalysis,
      waveform: shared.waveform,
      waveformStatus: shared.waveformStatus,
      waveformMs: shared.waveformMs,
      waveformDebugBackendKey: shared.waveformDebugBackendKey,
      beatTypeAuto: shared.beatTypeAuto,
      breakbeatScore: shared.breakbeatScore,
      analysisStatus: shared.analysisStatus || 'Analyzed',
      tempoDebugBaseBpm: shared.tempoDebugBaseBpm,
      tempoDebugSummary: shared.tempoDebugSummary,
      tempoDebugGate: shared.tempoDebugGate,
      tempoDebugCandidates: shared.tempoDebugCandidates,
      workerPoolDebug: poolDebug,
      analysisMs: shared.analysisMs,
      sourceUrl: normalizedUrl,
      error: shared.error,
      ts: Date.now()
    });
    return { ...shared, workerPoolDebug: poolDebug, analysisServedBy: 'background-in-flight' };
  }

  const analysisStartedAt = Date.now();
  const analysisPromise = (async (): Promise<AnalysisResult> => {
    try {
      throwIfAborted(signal);
      throwIfStale();
      const shouldComputeWaveformForCurrentRequest = Boolean(onUpdate);
      emitUpdate({
        sourceUrl: normalizedUrl,
        analysisStatus: 'Fetching audio...',
        ts: Date.now()
      });

      const { audioBuffer, timing, completeness, resolvedUrl } = await awaitWithAbort(
        getDecodedAudioWithTiming(cacheIdentity, normalizedFetchUrl, signal, {
          usePartialFetch: Boolean(options.usePartialFetch),
          inFlightKey: executionKey
        }),
        signal
      );

      throwIfAborted(signal);
      throwIfStale();
      const waveformUpdate = shouldComputeWaveformForCurrentRequest
        ? completeness === 'partial'
          ? {
            waveform: null,
            waveformStatus: 'Computing waveform...'
          }
          : computeInlineWaveformAnalysisUpdate(audioBuffer, cacheIdentity)
        : {};
      if (shouldComputeWaveformForCurrentRequest) {
        emitUpdate({
          sourceUrl: normalizedUrl,
          ...waveformUpdate,
          ts: Date.now()
        });
      }

      emitUpdate({
        sourceUrl: normalizedUrl,
        analysisStatus: 'Estimating BPM...',
        ts: Date.now()
      });

      // Run the 'corrected' tempo pass (beat-evidence correction + beat-grid
      // refine) directly on first paint, so the very first BPM shown is already
      // corrected — the same one-shot behavior as Chrome's offscreen host. This
      // replaces the old base-only-then-deferred two-step (which flashed the raw
      // base BPM, then ticked to the corrected value ~2s later). Full audio is
      // fetched above (usePartialFetch=false) because the correction needs it.
      const { result } = await analyzeAudioBuffer(
        audioBuffer,
        normalizedUrl,
        enableKeyAnalysis,
        analysisStartedAt,
        timing,
        {
          tempoAnalysisMode: 'corrected',
          includeInlineWaveform: false
        }
      );

      throwIfAborted(signal);
      throwIfStale();

      const settledStatus = Number.isFinite(result.bpm)
        ? `BPM: ${Math.round(Number(result.bpm))}`
        : 'BPM unavailable';
      const finalResult: AnalysisResult = {
        ...result,
        resolvedAudioUrl: resolvedUrl,
        analysisStatus: settledStatus,
        bpmDebugSource: 'runtime.interactive-corrected',
        bpmDebugDetail: 'corrected BPM computed on first paint (one-shot, full audio)',
        analysisServedBy: 'background-computed',
        analysisAudioCompleteness: completeness,
        ...waveformUpdate,
        ts: Date.now()
      };

      if (isCurrentEpoch()) {
        await setCachedAnalysis(cacheKey, finalResult);
      }
      emitUpdate(finalResult);

      if (shouldEstimateConfidence(finalResult, options)) {
        setTimeout(() => {
          scheduleConfidenceEstimation(audioBuffer, cacheKey, finalResult, normalizedUrl, signal, isCurrentEpoch, emitUpdate);
        }, 0);
      }

      return finalResult;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const failure: AnalysisResult = {
        sourceUrl: normalizedUrl,
        error: message,
        analysisStatus: 'Analysis failed',
        analysisMs: Date.now() - analysisStartedAt,
        ts: Date.now()
      };
      if (isCurrentEpoch()) {
        await setCachedAnalysis(cacheKey, failure);
      }
      emitUpdate(failure);
      return failure;
    }
  })().finally(() => {
    clearInFlightAnalysis(executionKey);
  });

  setInFlightAnalysis(executionKey, analysisPromise);
  return await awaitWithAbort(analysisPromise, signal);
}

function cancelActiveAnalysisForTab(tabId: number | undefined, url?: string): boolean {
  if (!Number.isFinite(tabId)) {
    return false;
  }

  const active = activeAnalysisByTab.get(Number(tabId));
  if (!active) {
    return false;
  }
  if (url && active.url !== url) {
    return false;
  }

  active.controller.abort();
  activeAnalysisByTab.delete(Number(tabId));
  return true;
}

function cancelActiveKeyAnalysisForTab(tabId: number | undefined, url?: string): boolean {
  if (!Number.isFinite(tabId)) {
    return false;
  }

  const tabMap = activeKeyAnalysisByTab.get(Number(tabId));
  if (!tabMap) {
    return false;
  }

  if (url) {
    const active = tabMap.get(url);
    if (!active) {
      return false;
    }
    active.controller.abort();
    tabMap.delete(url);
    if (tabMap.size === 0) {
      activeKeyAnalysisByTab.delete(Number(tabId));
    }
    return true;
  }

  for (const active of tabMap.values()) {
    active.controller.abort();
  }
  activeKeyAnalysisByTab.delete(Number(tabId));
  return true;
}

export async function handleAnalyzeTrack(
  msg: Extract<ContentMessage, { type: 'ANALYZE_TRACK' }>,
  sender: chrome.runtime.MessageSender
): Promise<AnalyzeTrackResponse> {
  const url = String(msg.url || '').trim();
  const fetchUrl = String(msg.fetchUrl || '').trim();
  if (!url) {
    return { error: 'ANALYZE_TRACK requires a url', ts: Date.now() };
  }

  const cacheIdentity = resolveAnalysisCacheIdentity(url, msg.cacheKey);
  const enableKeyAnalysis = Boolean(msg.enableKeyAnalysis);
  const tabId = sender.tab?.id;
  if (!Number.isFinite(tabId)) {
    return await analyzeTrackInternal(url, cacheIdentity, enableKeyAnalysis, ANALYSIS_EXECUTION_OPTIONS, undefined, undefined, fetchUrl);
  }

  const resolvedTabId = Number(tabId);
  const previous = activeAnalysisByTab.get(resolvedTabId);
  let controller: AbortController;

  if (
    previous
    && (previous.url !== url || previous.fetchUrl !== fetchUrl)
  ) {
    previous.controller.abort();
    activeAnalysisByTab.delete(resolvedTabId);
  }

  const reused = activeAnalysisByTab.get(resolvedTabId);
  if (reused && reused.url === url && reused.fetchUrl === fetchUrl) {
    controller = reused.controller;
  } else {
    controller = new AbortController();
    activeAnalysisByTab.set(resolvedTabId, { url, fetchUrl, controller });
  }

  const onUpdate = (partial: Partial<AnalysisResult>): void => {
    const push: BackgroundPush = {
      type: 'ANALYSIS_PARTIAL',
      url,
      ...partial,
      ts: Date.now()
    };
    void sendPushToTab(resolvedTabId, push);
  };

  try {
    return await analyzeTrackInternal(
      url,
      cacheIdentity,
      enableKeyAnalysis,
      ANALYSIS_EXECUTION_OPTIONS,
      controller.signal,
      onUpdate,
      fetchUrl
    );
  } catch (error) {
    if (isAbortError(error)) {
      return { cancelled: true, ts: Date.now() };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, ts: Date.now() };
  } finally {
    const active = activeAnalysisByTab.get(resolvedTabId);
    if (active && active.controller === controller) {
      activeAnalysisByTab.delete(resolvedTabId);
    }
  }
}

export async function handleClearAnalysisCache(): Promise<{ ok: true }> {
  for (const active of activeAnalysisByTab.values()) {
    active.controller.abort();
  }
  activeAnalysisByTab.clear();
  for (const tabMap of activeKeyAnalysisByTab.values()) {
    for (const active of tabMap.values()) {
      active.controller.abort();
    }
  }
  activeKeyAnalysisByTab.clear();
  await clearAllAnalysisCaches();
  logger.info('analysis caches cleared from debugger request');
  return { ok: true };
}

export async function handleAnalyzeTrackSilent(
  msg: Extract<ContentMessage, { type: 'ANALYZE_TRACK_SILENT' }>
): Promise<AnalyzeTrackResponse> {
  const url = String(msg.url || '').trim();
  const fetchUrl = String(msg.fetchUrl || '').trim();
  if (!url) {
    return { error: 'ANALYZE_TRACK_SILENT requires a url', ts: Date.now() };
  }

  try {
    const cacheIdentity = resolveAnalysisCacheIdentity(url, msg.cacheKey);
    const enableKeyAnalysis = Boolean(msg.enableKeyAnalysis);
    return await analyzeTrackInternal(url, cacheIdentity, enableKeyAnalysis, ANALYSIS_EXECUTION_OPTIONS, undefined, undefined, fetchUrl);
  } catch (error) {
    if (isAbortError(error)) {
      return { cancelled: true, ts: Date.now() };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, ts: Date.now() };
  }
}

export async function handleAnalyzeKey(
  msg: Extract<ContentMessage, { type: 'ANALYZE_KEY' }>,
  sender: chrome.runtime.MessageSender
): Promise<AnalyzeKeyResponse> {
  const url = String(msg.url || '').trim();
  if (!url) {
    return { error: 'ANALYZE_KEY requires a url', ts: Date.now() };
  }

  const cacheIdentity = resolveAnalysisCacheIdentity(url, msg.cacheKey);
  // The client sends the BPM it last saw, which may be a provisional first-paint
  // value from before a correction landed. Key analysis windows are sized from the
  // BPM, so bind them to the background's own settled value when it has one — the
  // cache is authoritative over the client's copy.
  const cachedTempo = await getCachedAnalysis(buildAnalysisCacheKey(cacheIdentity));
  const cachedBpm = Number(cachedTempo?.bpm);
  const bpm = Number.isFinite(cachedBpm) && cachedBpm > 0 ? cachedBpm : Number(msg.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return { error: 'ANALYZE_KEY requires a settled BPM', ts: Date.now() };
  }
  const tabId = sender.tab?.id;
  if (!Number.isFinite(tabId)) {
    try {
      const { keyAnalysis, debug } = await analyzeKeyInternal(url, cacheIdentity, bpm);
      return { keyAnalysis, keyStatus: resolveKeyStatus(keyAnalysis), ts: Date.now(), ...debug };
    } catch (error) {
      if (isAbortError(error)) {
        return { cancelled: true, ts: Date.now() };
      }
      return { error: error instanceof Error ? error.message : String(error), ts: Date.now() };
    }
  }

  const resolvedTabId = Number(tabId);
  let tabMap = activeKeyAnalysisByTab.get(resolvedTabId);
  if (!tabMap) {
    tabMap = new Map();
    activeKeyAnalysisByTab.set(resolvedTabId, tabMap);
  }

  const existing = tabMap.get(url);
  const controller = existing ? existing.controller : new AbortController();
  if (!existing) {
    tabMap.set(url, { url, controller });
  }

  try {
    const { keyAnalysis, debug } = await analyzeKeyInternal(url, cacheIdentity, bpm, controller.signal);
    return { keyAnalysis, keyStatus: resolveKeyStatus(keyAnalysis), ts: Date.now(), ...debug };
  } catch (error) {
    if (isAbortError(error)) {
      return { cancelled: true, ts: Date.now() };
    }
    return { error: error instanceof Error ? error.message : String(error), ts: Date.now() };
  } finally {
    const currentTabMap = activeKeyAnalysisByTab.get(resolvedTabId);
    if (currentTabMap) {
      const active = currentTabMap.get(url);
      if (active && active.controller === controller) {
        currentTabMap.delete(url);
      }
      if (currentTabMap.size === 0) {
        activeKeyAnalysisByTab.delete(resolvedTabId);
      }
    }
  }
}

export async function handleCancelAnalysis(
  msg: Extract<ContentMessage, { type: 'CANCEL_ANALYSIS' }>,
  sender: chrome.runtime.MessageSender
): Promise<AnalysisCancelledResponse> {
  const tabId = sender.tab?.id;
  const cancelled = cancelActiveAnalysisForTab(tabId, msg.url);
  return { cancelled, ts: Date.now() };
}

export async function handleCancelKeyAnalysis(
  msg: Extract<ContentMessage, { type: 'CANCEL_KEY_ANALYSIS' }>,
  sender: chrome.runtime.MessageSender
): Promise<AnalysisCancelledResponse> {
  const tabId = sender.tab?.id;
  const cancelled = cancelActiveKeyAnalysisForTab(tabId, msg.url);
  return { cancelled, ts: Date.now() };
}

export async function handleGetWaveform(
  msg: Extract<ContentMessage, { type: 'GET_WAVEFORM' }>
): Promise<WaveformBands & { debugCacheKey: string }> {
  const url = String(msg.url || '').trim();
  const fetchUrl = String(msg.fetchUrl || '').trim();
  if (!url) {
    throw new Error('GET_WAVEFORM requires a url');
  }

  const cacheIdentity = resolveWaveformCacheIdentity(url, msg.cacheKey);

  try {
    const waveform = await computeAndCacheWaveformForUrl(fetchUrl || url, cacheIdentity);
    return { ...waveform, debugCacheKey: cacheIdentity };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('GET_WAVEFORM failed', message, url);
    throw new Error(message);
  }
}

export async function handleAnalyzeKeyDebug(
  msg: AnalyzeKeyDebugMessage
): Promise<AnalyzeKeyDebugResponse> {
  const url = String(msg.url || '').trim();
  if (!url) {
    return { type: 'ANALYZE_KEY_DEBUG_RESPONSE', debug: null, error: 'ANALYZE_KEY_DEBUG requires a url' };
  }

  try {
    const response = await fetch(url, { method: 'GET', credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Fetch failed: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await decodeAudio(arrayBuffer);
    const bpm = msg.bpm ?? (await resolveTempoForAnalysis(audioBuffer)).bpm;

    const debug = await analyzeKeyDebug(audioBuffer, bpm, msg.params);
    return { type: 'ANALYZE_KEY_DEBUG_RESPONSE', debug };
  } catch (error) {
    return {
      type: 'ANALYZE_KEY_DEBUG_RESPONSE',
      debug: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function handleAnalyzeBpmPrototype(
  msg: AnalyzeBpmPrototypeMessage
): Promise<AnalyzeBpmPrototypeResponse> {
  const url = String(msg.url || '').trim();
  if (!url) {
    return {
      type: 'ANALYZE_BPM_PROTOTYPE_RESPONSE',
      analysis: null,
      prototype: null,
      simulated: null,
      error: 'ANALYZE_BPM_PROTOTYPE requires a url'
    };
  }

  try {
    const tempoAnalysisMode: TempoAnalysisMode = msg.tempoAnalysisMode === 'base-only' ? 'base-only' : 'corrected';
    const analysisStartedAt = Date.now();
    const fetchStartedAt = performance.now();
    const fetched = await fetchAudioArrayBuffer(url);
    const fetchMs = Math.round(performance.now() - fetchStartedAt);
    const decodeStartedAt = performance.now();
    const audioBuffer = await decodeAudio(fetched.arrayBuffer);
    const decodeMs = Math.round(performance.now() - decodeStartedAt);
    const { result: analysis } = await analyzeAudioBuffer(
      audioBuffer,
      url,
      false,
      analysisStartedAt,
      {
        fetchMs,
        decodeMs
      },
      {
        tempoAnalysisMode
      }
    );
    const prototype = await analyzeTempoBySparseWindows(audioBuffer, undefined, {
      maxDurationSec: 72,
      maxWindows: 6
    });
    if (analysis) {
      analysis.resolvedAudioUrl = String(fetched.resolvedUrl || url || '').trim();
    }
    const refinedTempo = analysis ? await resolveTempoForAnalysis(audioBuffer, 'corrected') : null;
    const acceptedRefined = analysis && refinedTempo
      ? {
        ...analysis,
        bpm: refinedTempo.bpm,
        confidence: Number.isFinite(refinedTempo.tempoRawConfidence)
          ? Number(refinedTempo.tempoRawConfidence)
          : analysis.confidence,
        tempoRawConfidence: refinedTempo.tempoRawConfidence,
        tempoDecisionConfidence: refinedTempo.tempoDecisionConfidence,
        beatTypeAuto: refinedTempo.beatTypeAuto,
        analysisStatus: `BPM: ${refinedTempo.bpm}`,
        tempoDebugBaseBpm: refinedTempo.tempoDebugBaseBpm,
        tempoDebugSummary: refinedTempo.tempoDebugSummary,
        tempoDebugGate: refinedTempo.tempoDebugGate,
        tempoDebugCandidates: refinedTempo.tempoDebugCandidates
      }
      : null;
    const simulatedAction: 'keep-base' | 'promote-slower' =
      analysis && acceptedRefined && Number(acceptedRefined.bpm) !== Number(analysis.bpm)
        ? 'promote-slower'
        : 'keep-base';
    const simulated = analysis && acceptedRefined
      ? {
        bpm: Number(acceptedRefined.bpm),
        action: simulatedAction,
        label: Number(acceptedRefined.bpm) !== Number(analysis.bpm)
          ? 'corrected'
          : 'current',
        confidence: Number.isFinite(acceptedRefined.tempoDecisionConfidence) ? Number(acceptedRefined.tempoDecisionConfidence) : 0,
        reason: acceptedRefined.tempoDebugSummary || '-',
        gate: acceptedRefined.tempoDebugGate || '-'
      }
      : null;
    // EXPERIMENT (panel-only): beat-grid precision refinement of the base estimate.
    // Reuses the already-extracted rhythm intervals; never touches runtime BPM.
    let precision: TempoGridRefinement | null = null;
    try {
      const baseRaw = Number(analysis?.tempoDebugBaseRawBpm);
      if (Number.isFinite(baseRaw) && baseRaw > 0) {
        const rhythm = await extractRhythmEvidence(audioBuffer, { quality: 'fast' });
        precision = refineTempoToBeatGrid(baseRaw, rhythm.bpm);
      }
    } catch {
      precision = null;
    }
    return {
      type: 'ANALYZE_BPM_PROTOTYPE_RESPONSE',
      analysis,
      prototype,
      simulated,
      precision
    };
  } catch (error) {
    return {
      type: 'ANALYZE_BPM_PROTOTYPE_RESPONSE',
      analysis: null,
      prototype: null,
      simulated: null,
      precision: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
