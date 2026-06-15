import { analyzeAudioBuffer } from '@/background/handlers/analysis-tempo';
import { analyzeKeyDetailed } from '@/background/key-essentia';
import { computeWaveformBands } from '@/background/audio/waveform-core';
import { getWorkerPool } from '@/background/audio/worker-pool';
import { getEssentiaRuntimeSync } from '@/background/audio/essentia-runtime';
import type { AnalysisResult, FetchPlaybackAudioResponse, HostResourceDiagnostics, WaveformBands } from '@/shared/types';
import type {
  ChromeAnalysisHostRequest,
  ChromeAnalysisHostResponse
} from '@/shared/chrome-analysis-host-types';
import { createResourceSampler } from '@/shared/resource-sampler';
import { createLogger } from '@/utils/debug';

const logger = createLogger('AUDIO');
const WAVEFORM_BUCKETS = 300;
const WAVEFORM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_CACHE_TTL_MS = 10 * 60 * 1000;
// These offscreen maps are only an in-session L1 in front of the service
// worker's persistent store, so they need a hard size cap, not just a TTL
// (TTL is checked lazily on read and never evicts on its own). Decoded audio is
// the memory-critical one — each AudioBuffer is ~120 MB of PCM — so it gets the
// tightest cap, matching ANALYSIS_DECODED_AUDIO_MAX_ENTRIES in background/cache.
const DECODED_AUDIO_MAX_ENTRIES = 8;
const RESULT_CACHE_MAX_ENTRIES = 200;
type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

type CachedDecodedAudio = {
  audioBuffer: AudioBuffer;
  ts: number;
};

type CachedWaveform = WaveformBands & {
  ts: number;
};

type CachedAnalysis = {
  result: AnalysisResult;
  ts: number;
};

type CachedKeyAnalysis = {
  result: Record<string, unknown>;
  ts: number;
};

interface ActiveAnalysisController {
  url: string;
  cacheKey: string;
  controller: AbortController;
}

let sharedDecodeContext: AudioContext | null = null;
const decodedAudioCache = new Map<string, CachedDecodedAudio>();
const decodedAudioInFlight = new Map<string, Promise<AudioBuffer>>();
const waveformCache = new Map<string, CachedWaveform>();
const waveformInFlight = new Map<string, Promise<WaveformBands>>();
const analysisCache = new Map<string, CachedAnalysis>();
const analysisInFlight = new Map<string, Promise<AnalysisResult>>();
const activeAnalysisControllers = new Map<string, ActiveAnalysisController>();
const keyAnalysisCache = new Map<string, CachedKeyAnalysis>();
const keyAnalysisInFlight = new Map<string, Promise<Record<string, unknown>>>();
const activeActionCounts = new Map<ChromeAnalysisHostRequest['action'], number>();
const lastActionMs = new Map<ChromeAnalysisHostRequest['action'], number>();

function normalizeUrlIdentity(url: string): string {
  const src = String(url || '').trim();
  if (!src) {
    return '';
  }

  try {
    const parsed = new URL(src, 'https://bandcamp.com');
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return src;
  }
}

function resolveCacheIdentity(url: string, cacheKey?: string): string {
  return String(cacheKey || '').trim() || normalizeUrlIdentity(url);
}

function buildWaveformCacheKey(url: string, cacheKey?: string): string {
  return `${resolveCacheIdentity(url, cacheKey)}|waveform-v4.0|${WAVEFORM_BUCKETS}`;
}

function buildAnalysisCacheKey(url: string, cacheKey?: string, enableKeyAnalysis?: boolean): string {
  const keyMode = enableKeyAnalysis ? 'with-key' : 'tempo-only';
  return `${resolveCacheIdentity(url, cacheKey)}|analysis-v1|${keyMode}`;
}

function buildKeyAnalysisCacheKey(url: string, bpm: number, cacheKey?: string): string {
  return `${resolveCacheIdentity(url, cacheKey)}|key-v1|bpm:${Math.round(Number(bpm) || 0)}`;
}

function isFresh(ts: number, ttlMs: number): boolean {
  return Date.now() - ts <= ttlMs;
}

// Insertion-order (FIFO) eviction: re-set the written key so it becomes newest,
// then drop the oldest entries until the map is within its cap.
function setWithCap<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function beginHostAction(action: ChromeAnalysisHostRequest['action']): () => void {
  const startedAt = performance.now();
  activeActionCounts.set(action, (activeActionCounts.get(action) || 0) + 1);
  return () => {
    activeActionCounts.set(action, Math.max(0, (activeActionCounts.get(action) || 1) - 1));
    lastActionMs.set(action, Math.max(0, performance.now() - startedAt));
  };
}

function formatCount(action: ChromeAnalysisHostRequest['action']): string {
  return `${action}:${activeActionCounts.get(action) || 0}`;
}

function formatLastMs(action: ChromeAnalysisHostRequest['action']): string {
  const value = lastActionMs.get(action);
  return Number.isFinite(value) ? `${action}:${Math.round(Number(value))}ms` : `${action}:-`;
}

function buildChromeOffscreenDebug(): string {
  const actions: ChromeAnalysisHostRequest['action'][] = [
    'ANALYZE_TRACK',
    'GET_WAVEFORM',
    'ANALYZE_KEY',
    'CANCEL_ANALYSIS',
    'PING'
  ];
  return [
    `active=${actions.map(formatCount).join(',')}`,
    `last=${actions.map(formatLastMs).join(',')}`,
    `decodeCache=${decodedAudioCache.size}`,
    `decodeInFlight=${decodedAudioInFlight.size}`,
    `analysisInFlight=${analysisInFlight.size}`,
    `waveformInFlight=${waveformInFlight.size}`,
    `keyInFlight=${keyAnalysisInFlight.size}`,
    `activeAbort=${activeAnalysisControllers.size}`
  ].join(' ');
}

function attachChromeOffscreenDebug(result: AnalysisResult): AnalysisResult {
  return {
    ...result,
    chromeOffscreenDebug: buildChromeOffscreenDebug()
  };
}

/* ---- Resource diagnostics (offscreen owns the real Chrome worker pool) ---- */

// Same session-gated model as the background handler: sample only while a debug panel session
// is active, prune sessions whose forwarded CLOSE never arrived. GET also registers/refreshes
// the session — the offscreen document may be created after the panel already opened (e.g. by
// the first analysis), so the OPEN forward can be missed; auto-registering on GET starts
// sampling deterministically without an extra round trip.
const SESSION_STALE_MS = 5_000;
const resourceSampler = createResourceSampler();
const resourceDiagnosticsSessions = new Map<string, number>();

function pruneResourceDiagnosticsSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastSeenAt] of resourceDiagnosticsSessions) {
    if (now - lastSeenAt > SESSION_STALE_MS) {
      resourceDiagnosticsSessions.delete(sessionId);
    }
  }
}

function applyResourceSamplingState(): void {
  const shouldSample = resourceDiagnosticsSessions.size > 0;
  if (shouldSample === resourceSampler.isRunning()) {
    return;
  }
  if (shouldSample) {
    resourceSampler.start();
    getWorkerPool().setPerfSampling(true);
  } else {
    resourceSampler.stop();
    getWorkerPool().setPerfSampling(false);
  }
}

function readEssentiaHeapBytes(): number | null {
  const module = getEssentiaRuntimeSync()?.module as { HEAPU8?: Uint8Array } | undefined;
  return module?.HEAPU8 ? module.HEAPU8.buffer.byteLength : null;
}

async function buildOffscreenResourceDiagnostics(): Promise<HostResourceDiagnostics> {
  const pool = getWorkerPool();
  const status = pool.getStatus();
  const workers = await pool.collectPerfReports();
  return {
    context: 'offscreen-analysis-host',
    awakeForDiagnostics: true,
    sample: resourceSampler.snapshot(),
    pool: { ...status, busyFraction: pool.busyFraction() },
    workers,
    caches: buildChromeOffscreenDebug(),
    essentiaHeapBytes: readEssentiaHeapBytes(),
    ts: Date.now()
  };
}

function getDecodeContext(): AudioContext {
  if (sharedDecodeContext && sharedDecodeContext.state !== 'closed') {
    return sharedDecodeContext;
  }

  const ContextCtor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!ContextCtor) {
    throw new Error('AudioContext unavailable in chrome offscreen host');
  }

  sharedDecodeContext = new ContextCtor();
  return sharedDecodeContext;
}

async function decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  let context = getDecodeContext();

  if (context.state === 'suspended') {
    await context.resume();
  }

  try {
    const copied = arrayBuffer.slice(0);
    return await context.decodeAudioData(copied);
  } catch {
    sharedDecodeContext = null;
    context = getDecodeContext();
    const copied = arrayBuffer.slice(0);
    return await context.decodeAudioData(copied);
  }
}

function createAbortError(): Error {
  const error = new Error('Analysis cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const record = error as { name?: unknown; message?: unknown };
  return record.name === 'AbortError'
    || /abort|cancel/i.test(String(record.message || ''));
}

let playbackAudioRequestSeq = 0;

function shouldIncludePlaybackAudioCredentials(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://bandcamp.com');
    return parsed.hostname === 'bandcamp.com' && /\/stream_redirect\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

// Route audio fetches through the background's shared trackId-keyed cache (the
// same authority runtime predecode uses) so a track is downloaded once across
// the offscreen analysis/waveform and content playback predecode, instead of the
// offscreen fetching independently. The offscreen analysis runs before predecode,
// so the higher-quality v0 stream (offered for owned tracks) wins and is reused
// for playback. The shared fetch runs to completion; honour our own abort after.
async function fetchAudioArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = (await chrome.runtime.sendMessage({
    type: 'FETCH_PLAYBACK_AUDIO',
    url,
    includeCredentials: shouldIncludePlaybackAudioCredentials(url),
    requestId: `offscreen-audio-${++playbackAudioRequestSeq}`
  })) as FetchPlaybackAudioResponse | undefined;
  throwIfAborted(signal);
  if (!response?.ok || !response.audioDataBase64) {
    throw new Error(response?.error || `Audio fetch failed: HTTP ${response?.status ?? 'unknown'}`);
  }
  const binary = atob(response.audioDataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getOrDecodeAudio(url: string, cacheKey?: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const cacheIdentity = resolveCacheIdentity(url, cacheKey);
  const cached = decodedAudioCache.get(cacheIdentity);
  if (cached && isFresh(cached.ts, ANALYSIS_CACHE_TTL_MS)) {
    throwIfAborted(signal);
    return cached.audioBuffer;
  }

  const inFlight = decodedAudioInFlight.get(cacheIdentity);
  if (inFlight) {
    const audioBuffer = await inFlight;
    throwIfAborted(signal);
    return audioBuffer;
  }

  const promise = (async () => {
    const arrayBuffer = await fetchAudioArrayBuffer(url, signal);
    throwIfAborted(signal);
    const audioBuffer = await decodeAudio(arrayBuffer);
    throwIfAborted(signal);
    setWithCap(decodedAudioCache, cacheIdentity, {
      audioBuffer,
      ts: Date.now()
    }, DECODED_AUDIO_MAX_ENTRIES);
    return audioBuffer;
  })().finally(() => {
    decodedAudioInFlight.delete(cacheIdentity);
  });

  decodedAudioInFlight.set(cacheIdentity, promise);
  return await promise;
}

function cancelActiveAnalysis(payload: { url?: string; cacheKey?: string }): boolean {
  const url = String(payload.url || '').trim();
  const cacheKey = String(payload.cacheKey || '').trim();
  let cancelled = false;

  for (const [key, active] of activeAnalysisControllers.entries()) {
    if (url && active.url !== url) {
      continue;
    }
    if (cacheKey && active.cacheKey !== cacheKey) {
      continue;
    }
    active.controller.abort();
    activeAnalysisControllers.delete(key);
    cancelled = true;
  }

  return cancelled;
}

function buildFailure(
  request: ChromeAnalysisHostRequest,
  error: string
): ChromeAnalysisHostResponse {
  return {
    target: 'chrome-analysis-host',
    requestId: request.requestId,
    action: request.action,
    ok: false,
    error
  };
}

function buildSuccess<T>(
  request: ChromeAnalysisHostRequest,
  result: T
): ChromeAnalysisHostResponse<T> {
  return {
    target: 'chrome-analysis-host',
    requestId: request.requestId,
    action: request.action,
    ok: true,
    result
  };
}

async function handleRequest(request: ChromeAnalysisHostRequest): Promise<ChromeAnalysisHostResponse> {
  const finishAction = beginHostAction(request.action);
  try {
  switch (request.action) {
    case 'PING':
      return buildSuccess(request, {
        status: 'ready',
        context: 'offscreen-analysis-host',
        ts: Date.now()
      });
    case 'ANALYZE_TRACK': {
      const url = String(request.payload.url || '').trim();
      const fetchUrl = String(request.payload.fetchUrl || url || '').trim() || url;
      if (!url) {
        return buildFailure(request, 'ANALYZE_TRACK requires a url');
      }

      const cacheKey = buildAnalysisCacheKey(url, request.payload.cacheKey, request.payload.enableKeyAnalysis);
      const cached = analysisCache.get(cacheKey);
      if (cached && isFresh(cached.ts, ANALYSIS_CACHE_TTL_MS)) {
        return buildSuccess(request, attachChromeOffscreenDebug({ ...cached.result, analysisServedBy: 'offscreen-cache' }));
      }

      const inFlight = analysisInFlight.get(cacheKey);
      if (inFlight) {
        const shared = await inFlight;
        return buildSuccess(request, attachChromeOffscreenDebug({ ...shared, analysisServedBy: 'offscreen-in-flight' }));
      }

      const controller = new AbortController();
      activeAnalysisControllers.set(cacheKey, {
        url,
        cacheKey: String(request.payload.cacheKey || '').trim(),
        controller
      });
      const promise = (async (): Promise<AnalysisResult> => {
        const analysisStartedAt = Date.now();
        const fetchStartedAt = performance.now();
        const audioBuffer = await getOrDecodeAudio(fetchUrl, request.payload.cacheKey, controller.signal);
        throwIfAborted(controller.signal);
        const fetchMs = Math.round(performance.now() - fetchStartedAt);
        const result = await analyzeAudioBuffer(
          audioBuffer,
          url,
          Boolean(request.payload.enableKeyAnalysis),
          analysisStartedAt,
          {
            fetchMs,
            decodeMs: 0
          },
          {
            includeInlineWaveform: true,
            // Chrome has no deferred-refinement stage (the offscreen is one-shot
            // per track and its cache feeds both the current track and preload).
            // So the single pass must be 'corrected' to apply beat-evidence
            // correction + beat-grid precision. Firefox keeps base-only here and
            // refines in the background SW; Chrome trades a slightly slower first
            // BPM for correctness in one pass.
            tempoAnalysisMode: 'corrected'
          }
        );
        const resolved = {
          ...result.result,
          analysisServedBy: 'offscreen-computed',
          ts: Date.now()
        };
        setWithCap(analysisCache, cacheKey, {
          result: resolved,
          ts: Date.now()
        }, RESULT_CACHE_MAX_ENTRIES);
        return resolved;
      })().finally(() => {
        analysisInFlight.delete(cacheKey);
        const active = activeAnalysisControllers.get(cacheKey);
        if (active?.controller === controller) {
          activeAnalysisControllers.delete(cacheKey);
        }
      });

      analysisInFlight.set(cacheKey, promise);
      try {
        return buildSuccess(request, attachChromeOffscreenDebug(await promise));
      } catch (error) {
        if (isAbortError(error)) {
          return buildSuccess(request, {
            cancelled: true,
            ts: Date.now()
          });
        }
        throw error;
      }
    }
    case 'CANCEL_ANALYSIS':
      return buildSuccess(request, {
        cancelled: cancelActiveAnalysis(request.payload || {}),
        ts: Date.now()
      });
    case 'ANALYZE_KEY':
      {
        const url = String(request.payload.url || '').trim();
        if (!url) {
          return buildFailure(request, 'ANALYZE_KEY requires a url');
        }
        // The client sends the BPM it last saw, which can be a provisional value
        // from before correction landed. Key windows are sized from the BPM, so
        // bind them to this host's own settled result when it has one — the
        // offscreen analysis cache is authoritative over the client's copy.
        const cachedAnalysis =
          analysisCache.get(buildAnalysisCacheKey(url, request.payload.cacheKey, false))
          ?? analysisCache.get(buildAnalysisCacheKey(url, request.payload.cacheKey, true));
        const cachedBpm = Number(cachedAnalysis?.result?.bpm);
        const bpm = Number.isFinite(cachedBpm) && cachedBpm > 0
          ? cachedBpm
          : Number(request.payload.bpm);
        if (!Number.isFinite(bpm) || bpm <= 0) {
          return buildFailure(request, 'ANALYZE_KEY requires a settled BPM');
        }

        const cacheKey = buildKeyAnalysisCacheKey(url, bpm, request.payload.cacheKey);
        const cached = keyAnalysisCache.get(cacheKey);
        if (cached && isFresh(cached.ts, ANALYSIS_CACHE_TTL_MS)) {
          return buildSuccess(request, cached.result);
        }

        const inFlight = keyAnalysisInFlight.get(cacheKey);
        if (inFlight) {
          return buildSuccess(request, await inFlight);
        }

        const promise = (async (): Promise<Record<string, unknown>> => {
          const audioBuffer = await getOrDecodeAudio(url, request.payload.cacheKey);
          const { result, timing } = await analyzeKeyDetailed(audioBuffer, bpm);
          const response = {
            keyAnalysis: result,
            keyStatus: result.topKeys.length > 0 ? 'ready' : 'empty',
            keyDebugSource: 'chrome.offscreen-key',
            keyDebugDetail: `chrome offscreen key analysis${timing.frameStageDetail ? ` ${timing.frameStageDetail}` : ''}${timing.dispatchDetail ? ` ${timing.dispatchDetail}` : ''}${timing.comparisonDetail ? ` ${timing.comparisonDetail}` : ''}`,
            keyDebugCacheKey: cacheKey,
            keyDebugTimingMs: timing.totalMs,
            keyDebugDecodeMs: 0,
            keyDebugPreprocessMs: timing.preprocessMs,
            keyDebugComputeMs: timing.computeMs,
            ts: Date.now()
          };
          setWithCap(keyAnalysisCache, cacheKey, {
            result: response,
            ts: Date.now()
          }, RESULT_CACHE_MAX_ENTRIES);
          return response;
        })().finally(() => {
          keyAnalysisInFlight.delete(cacheKey);
        });

        keyAnalysisInFlight.set(cacheKey, promise);
        return buildSuccess(request, await promise);
      }
    case 'GET_WAVEFORM': {
      const url = String(request.payload.url || '').trim();
      const fetchUrl = String(request.payload.fetchUrl || url || '').trim() || url;
      if (!url) {
        return buildFailure(request, 'GET_WAVEFORM requires a url');
      }

      const cacheKey = buildWaveformCacheKey(url, request.payload.cacheKey);
      const cached = waveformCache.get(cacheKey);
      if (cached && isFresh(cached.ts, WAVEFORM_CACHE_TTL_MS)) {
        return buildSuccess(request, cached);
      }

      const inFlight = waveformInFlight.get(cacheKey);
      if (inFlight) {
        return buildSuccess(request, await inFlight);
      }

      const promise = (async (): Promise<WaveformBands> => {
        const audioBuffer = await getOrDecodeAudio(fetchUrl, request.payload.cacheKey);
        const waveform = computeWaveformBands(audioBuffer, WAVEFORM_BUCKETS);
        setWithCap(waveformCache, cacheKey, {
          ...waveform,
          ts: Date.now()
        }, RESULT_CACHE_MAX_ENTRIES);
        return waveform;
      })().finally(() => {
        waveformInFlight.delete(cacheKey);
      });

      waveformInFlight.set(cacheKey, promise);
      return buildSuccess(request, await promise);
    }
    case 'OPEN_RESOURCE_DIAGNOSTICS_SESSION':
      pruneResourceDiagnosticsSessions();
      resourceDiagnosticsSessions.set(request.payload.sessionId, Date.now());
      applyResourceSamplingState();
      return buildSuccess(request, { ok: true });
    case 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION':
      resourceDiagnosticsSessions.delete(request.payload.sessionId);
      pruneResourceDiagnosticsSessions();
      applyResourceSamplingState();
      return buildSuccess(request, { ok: true });
    case 'GET_RESOURCE_DIAGNOSTICS':
      pruneResourceDiagnosticsSessions();
      resourceDiagnosticsSessions.set(request.payload.sessionId, Date.now());
      applyResourceSamplingState();
      return buildSuccess(request, await buildOffscreenResourceDiagnostics());
    default:
      return buildFailure(request, 'chrome-analysis-host-unknown-action');
  }
  } finally {
    finishAction();
  }
}

void getWorkerPool().initialize()
  .then(() => {
    logger.info('Analysis worker pool ready');
  })
  .catch((error) => {
    logger.warn('Worker pool init failed; analysis will continue on main thread', error);
  });

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const request = raw as ChromeAnalysisHostRequest | undefined;
  if (!request || request.target !== 'chrome-analysis-host') {
    return false;
  }

  void handleRequest(request)
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      logger.warn('offscreen analysis host request failed', error);
      sendResponse(buildFailure(request, error instanceof Error ? error.message : String(error)));
    });

  return true;
});
