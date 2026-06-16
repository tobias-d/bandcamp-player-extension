import type { KeyAnalysisResult, PlaylistState, PlaylistTrack, WaveformBands } from '@/shared/types';
import type { PreloadTarget } from '@/content/player/preloader';
import type { PlaylistAnalysisCache } from '@/content/playlist/analysis-cache';
import { createPreloader } from '@/content/player/preloader';
import { filterPreloadTargets } from '@/content/playlist/analysis-cache';
import {
  buildDormantPreloadSyncSignature,
  buildPreloadEpochTargets,
  buildPreloadKeyTaskSignature,
  buildPreloadKeyTasks as buildSharedPreloadKeyTasks,
  buildPreloadTargetSignature,
  filterDeferredPreloadTargets
} from '@/content/playlist/preload-orchestration';
import { requestKeyForSource } from '@/content/analysis/key-request';
import { formatKeyTraceDebug } from '@/content/analysis/debug-helpers';
import {
  buildTrackCacheKey,
  resolveSourceTrackCacheKey
} from '@/content/playlist/track-identity';
import { decoratePlaylistTracks } from '@/content/playlist/analysis-decoration';
import { applyPlaylistSort } from '@/content/playlist/sorter';
import { normalizeUrl, readTrackIdFromUrl } from '@/content/playlist/resolver';

// --- Constants ---

const DISCOVER_PRELOAD_AUDIT_INTERVAL_MS = 12_000;
const DISCOVER_PRELOAD_MAX_ENQUEUED_TARGETS = 6;
const DISCOVER_PRELOAD_TIMEOUT_RETRY_DELAY_MS = 20_000;

export { DISCOVER_PRELOAD_AUDIT_INTERVAL_MS };

// --- Pure helpers ---

function mergeDiscoverPlaybackQuery(targetUrl: string, currentSrc: string): string {
  const targetRaw = String(targetUrl || '').trim();
  const currentRaw = String(currentSrc || '').trim();
  if (!targetRaw || !currentRaw) {
    return targetRaw;
  }

  try {
    const target = new URL(targetRaw, window.location.href);
    if (target.searchParams.toString()) {
      return target.toString();
    }
    const current = new URL(currentRaw, window.location.href);
    for (const key of ['p', 'ts', 't', 'token']) {
      const value = current.searchParams.get(key);
      if (value) {
        target.searchParams.set(key, value);
      }
    }
    return target.toString();
  } catch {
    return targetRaw;
  }
}

function deriveSyntheticStreamUrl(currentSrc: string, targetTrackId: string): string {
  const trackId = String(targetTrackId || '').trim();
  const source = String(currentSrc || '').trim();
  if (!trackId) {
    return '';
  }

  if (source) {
    try {
      const parsed = new URL(source);
      parsed.searchParams.set('track_id', trackId);
      parsed.searchParams.delete('trackid');
      return parsed.toString();
    } catch {
      // Fall through to canonical stream template.
    }
  }

  return `https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=${encodeURIComponent(trackId)}`;
}

function resolveTrackCacheKey(track: PlaylistTrack): string {
  return (
    buildTrackCacheKey(track, String(track.streamUrl || '').trim(), {
      normalizeUrlForCache: normalizeUrl
    }) || ''
  );
}

export function buildDiscoverPreloadQueue(
  tracks: PlaylistTrack[],
  currentIndex: number,
  currentSrc: string
): PreloadTarget[] {
  if (!tracks.length) {
    return [];
  }

  const normalizedCurrentSrc = normalizeUrl(String(currentSrc || '').trim());
  const currentTrackId = readTrackIdFromUrl(String(currentSrc || '').trim());
  const total = tracks.length;
  const startIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < total ? currentIndex : 0;
  const targets: PreloadTarget[] = [];

  for (let offset = 1; offset < total; offset += 1) {
    const index = (startIndex + offset) % total;
    const track = tracks[index];
    if (!track) {
      continue;
    }
    const trackId = String(track.trackId || readTrackIdFromUrl(String(track.streamUrl || '').trim()) || '').trim();
    const directStreamUrl = mergeDiscoverPlaybackQuery(String(track.streamUrl || '').trim(), currentSrc);
    const syntheticStreamUrl = trackId ? deriveSyntheticStreamUrl(currentSrc, trackId) : '';
    const streamUrl = directStreamUrl || syntheticStreamUrl;
    if (!streamUrl) {
      continue;
    }
    if (track.playable === false && !syntheticStreamUrl) {
      continue;
    }
    if (currentTrackId && trackId && currentTrackId === trackId) {
      continue;
    }
    if (normalizedCurrentSrc && normalizeUrl(streamUrl) === normalizedCurrentSrc) {
      continue;
    }
    const cacheKey = resolveTrackCacheKey(track);
    if (!cacheKey) {
      continue;
    }
    targets.push({ url: streamUrl, cacheKey });
  }

  return targets;
}

// --- Callback interface ---

export interface DiscoverPreloadControllerCallbacks {
  getPlaylistRunId(): number;
  getNowPlayingStreamUrl(): string;
  getPlaylistTracks(): PlaylistTrack[];
  getPlaylistCurrentIndex(): number;
  isPreloadTracksEnabled(): boolean;
  isKeyAnalysisEnabled(): boolean;

  resolvePreloadStartupBlockReason(): string;

  // Analysis cache facade
  resolvePreloadTargetKey(target: PreloadTarget): string;
  hasCachedBpm(cacheKey: string): boolean;
  setCachedBpm(cacheKey: string, bpm: number): boolean;
  canAttemptAnalysis(cacheKey: string): boolean;
  registerAnalysisAttempt(cacheKey: string): void;
  setPlaylistTrackAnalyzing(cacheKey: string, analyzing: boolean): boolean;

  // Cache maps (direct access for decorations and debug)
  getPlaylistBpmByCacheKey(): Map<string, number>;
  getPlaylistKeyAnalysisByCacheKey(): Map<string, KeyAnalysisResult>;
  getPlaylistWaveformByCacheKey(): Map<string, WaveformBands>;
  getPlaylistAnalyzingCacheKeys(): Set<string>;
  getPlaylistFailedCacheKeys(): Set<string>;
  getPlaylistAttemptCountByCacheKey(): Map<string, number>;
  getPlaylistConfidenceByCacheKey(): Map<string, number>;
  getPlaylistAnalysisCache(): PlaylistAnalysisCache;

  // Rendering
  render(): void;
  setPlaylistState(playlist: PlaylistState): void;
  getPlaylistState(): PlaylistState;
  getSettings(): { preloadTracksEnabled: boolean; keyAnalysisEnabled: boolean; preloadSortKey: string };
  getAnalysis(): { sourceUrl?: string; keyStatus?: string } | null;
  getMaxAnalysisAttempts(): number;
}

// --- Public interface ---

export interface DiscoverPreloadController {
  readonly preloader: ReturnType<typeof createPreloader>;
  syncDiscoverPreloadQueue(): void;
  cancelDiscoverPreloadKeyPass(): void;
  resetDiscoverPreloadBpmEpoch(): void;
  resetDiscoverPreloadFailureEpoch(): void;
  clearPreloadKeyFailedCacheKeys(): void;
  clearAllPreloadKeyTrackAnalyzing(): void;
  applyPlaylistAnalysisDecorations(): void;
  // Debug getters for buildDiscoverControllerDebugBody
  getPreloadTrace(): Array<{ ts: number; stage: string; detail: string }>;
  getPreloadEpochTargets(): PreloadTarget[];
  getPreloadBpmBatchSettled(): boolean;
  getPreloadBpmBatchOpenTs(): number;
  getPreloadKeyBatchOpenTs(): number;
  getPreloadKeyQueueLength(): number;
  getPreloadKeyInFlightTargetKey(): string;
  getPreloadKeyStartupBlockReason(): string;
  getPreloadDeferredRetryUntilByCacheKey(): Map<string, number>;
  getPreloadKeyAnalyzingCacheKeys(): Set<string>;
  getPreloadEpochFailedCacheKeys(): Set<string>;
  getPreloadKeyFailedCacheKeys(): Set<string>;
  getPreloadBlockedReason(): string;
}

// --- Factory ---

export interface DiscoverPreloadControllerOptions {
  maxConcurrentPreloads?: number;
  maxConcurrentKeyAnalyses?: number;
}

export function createDiscoverPreloadController(
  cb: DiscoverPreloadControllerCallbacks,
  options: DiscoverPreloadControllerOptions = {}
): DiscoverPreloadController {
  const maxConcurrentKeyAnalyses = options.maxConcurrentKeyAnalyses ?? 1;

  // ── Internal preload state ──
  const preloadTrace = [] as Array<{ ts: number; stage: string; detail: string }>;
  const preloadKeyCancelByTargetKey = new Map<string, () => void>();
  let discoverPreloadEpochTargets: PreloadTarget[] = [];
  let discoverPreloadSignature = '';
  let discoverPreloadRunnableSignature = '';
  let discoverPreloadBpmBatchSettled = false;
  let discoverPreloadKeyBatchSettled = false;
  let discoverPreloadBpmBatchOpenTs = 0;
  let discoverPreloadKeyBatchOpenTs = 0;
  let discoverPreloadKeySignature = '';
  let discoverPreloadIdleSyncSignature = '';
  let discoverPreloadDormantSyncSignature = '';
  let discoverPreloadKeyQueue: Array<{ target: PreloadTarget; bpm: number }> = [];
  const discoverPreloadKeyInFlightTargetKeys = new Set<string>();

  const preloadKeyAnalyzingCacheKeys = new Set<string>();
  const preloadKeyFailedCacheKeys = new Set<string>();
  const preloadEpochFailedCacheKeys = new Set<string>();
  const preloadDeferredRetryUntilByCacheKey = new Map<string, number>();

  // ── Trace ──

  const appendPreloadTrace = (stage: string, detail: string): void => {
    preloadTrace.push({ ts: Date.now(), stage, detail });
    if (preloadTrace.length > 120) {
      preloadTrace.splice(0, preloadTrace.length - 120);
    }
  };

  // ── Key analyzing state ──

  const setPreloadKeyTrackAnalyzing = (cacheKey: string, isAnalyzing: boolean): boolean => {
    if (!cacheKey) {
      return false;
    }
    const hadKey = preloadKeyAnalyzingCacheKeys.has(cacheKey);
    if (isAnalyzing) {
      if (hadKey) {
        return false;
      }
      preloadKeyAnalyzingCacheKeys.add(cacheKey);
      return true;
    }
    if (!hadKey) {
      return false;
    }
    preloadKeyAnalyzingCacheKeys.delete(cacheKey);
    return true;
  };

  const clearAllPreloadKeyTrackAnalyzing = (): void => {
    if (!preloadKeyAnalyzingCacheKeys.size) {
      return;
    }
    preloadKeyAnalyzingCacheKeys.clear();
  };

  // ── Decorations ──

  const applyPlaylistAnalysisDecorations = (): void => {
    const playlistState = cb.getPlaylistState();
    if (!playlistState.tracks.length) {
      return;
    }
    const currentSourceUrl = cb.getNowPlayingStreamUrl();
    const currentTrackCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, currentSourceUrl, {
      normalizeUrlForCompare: normalizeUrl,
      normalizeUrlForCache: normalizeUrl
    });
    const analysisRef = cb.getAnalysis();
    const settings = cb.getSettings();
    const currentTrackKeyLoading = Boolean(
      settings.keyAnalysisEnabled
      && analysisRef
      && String(analysisRef.sourceUrl || '').trim() === currentSourceUrl
      && analysisRef.keyStatus === 'analyzing'
    );

    const result = decoratePlaylistTracks(playlistState.tracks, {
      bpmByKey: cb.getPlaylistBpmByCacheKey(),
      keyAnalysisByKey: cb.getPlaylistKeyAnalysisByCacheKey(),
      analyzingKeys: cb.getPlaylistAnalyzingCacheKeys(),
      failedKeys: cb.getPlaylistFailedCacheKeys(),
      preloadKeyAnalyzingKeys: preloadKeyAnalyzingCacheKeys,
      deferredRetryUntilByKey: preloadDeferredRetryUntilByCacheKey,
      attemptCountByKey: cb.getPlaylistAttemptCountByCacheKey(),
      maxAttempts: cb.getMaxAnalysisAttempts()
    }, {
      keyAnalysisEnabled: settings.keyAnalysisEnabled,
      currentTrackCacheKey,
      currentTrackKeyLoading,
      resolveCacheKey: resolveTrackCacheKey
    });

    if (!result.changed) {
      return;
    }
    cb.setPlaylistState(applyPlaylistSort({
      ...playlistState,
      tracks: result.tracks
    }));
  };

  // ── Preloader instance ──

  const preloader = createPreloader({
    onTrackStart(target) {
      const key = cb.resolvePreloadTargetKey(target);
      appendPreloadTrace('start', `key=${key || '-'} url=${target.url}`);
      if (!key || cb.getPlaylistBpmByCacheKey().has(key)) {
        appendPreloadTrace('start-skip', `key=${key || '-'} reason=${!key ? 'missing-key' : 'cached'}`);
        return;
      }
      cb.registerAnalysisAttempt(key);
      cb.getPlaylistFailedCacheKeys().delete(key);
      if (cb.setPlaylistTrackAnalyzing(key, true)) {
        cb.render();
      }
    },
    onTrackComplete(target, result, outcome, failureDetail) {
      const key = cb.resolvePreloadTargetKey(target);
      const resultConfDisplay = Number(result?.confidence);
      const resultConfTdc = Number(result?.tempoDecisionConfidence);
      const resultConfRaw = Number(result?.tempoRawConfidence);
      const resultConfBest = Number.isFinite(resultConfDisplay) && resultConfDisplay > 0
        ? resultConfDisplay
        : Number.isFinite(resultConfTdc) && resultConfTdc > 0
          ? resultConfTdc
          : Number.isFinite(resultConfRaw) && resultConfRaw > 0
            ? resultConfRaw
            : 0;
      appendPreloadTrace(
        'complete',
        `key=${key || '-'} bpm=${Number.isFinite(result?.bpm) ? Math.round(Number(result?.bpm)) : '-'} conf=${resultConfBest > 0 ? Math.round(resultConfBest) : '-'} outcome=${outcome} reason=${failureDetail || '-'}`
      );
      let shouldRender = false;
      if (key && cb.setPlaylistTrackAnalyzing(key, false)) {
        shouldRender = true;
      }
      if (key) {
        const bpm = Number(result?.bpm);
        if (outcome === 'cancelled') {
          const attempts = cb.getPlaylistAttemptCountByCacheKey();
          const attemptCount = attempts.get(key) || 0;
          if (attemptCount <= 1) {
            attempts.delete(key);
          } else {
            attempts.set(key, attemptCount - 1);
          }
          preloadEpochFailedCacheKeys.delete(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
          appendPreloadTrace('cancel', `key=${key} reason=${failureDetail || 'analysis-cancelled'}`);
        } else if (Number.isFinite(bpm)) {
          if (cb.setCachedBpm(key, bpm)) {
            shouldRender = true;
          }
          if (resultConfBest > 0) {
            cb.getPlaylistConfidenceByCacheKey().set(key, resultConfBest);
          }
          cb.getPlaylistFailedCacheKeys().delete(key);
          preloadEpochFailedCacheKeys.delete(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
        } else if (outcome === 'timeout' && !cb.getPlaylistBpmByCacheKey().has(key)) {
          preloadDeferredRetryUntilByCacheKey.set(key, Date.now() + DISCOVER_PRELOAD_TIMEOUT_RETRY_DELAY_MS);
          appendPreloadTrace('defer', `key=${key} retryInMs=${DISCOVER_PRELOAD_TIMEOUT_RETRY_DELAY_MS}`);
        } else if (!cb.getPlaylistBpmByCacheKey().has(key)) {
          if (!cb.getPlaylistFailedCacheKeys().has(key)) {
            cb.getPlaylistFailedCacheKeys().add(key);
            shouldRender = true;
          }
          preloadEpochFailedCacheKeys.add(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
        }
        if (cb.isKeyAnalysisEnabled() && result?.keyAnalysis?.topKeys?.length) {
          cb.getPlaylistKeyAnalysisByCacheKey().set(key, result.keyAnalysis);
          shouldRender = true;
        }
      }
      appendPreloadTrace('resync', 'trigger=onTrackComplete');
      syncDiscoverPreloadQueue();
      if (shouldRender) {
        cb.render();
      }
    },
    shouldDeferWaveform(target, result) {
      const key = cb.resolvePreloadTargetKey(target);
      if (!key || !cb.isKeyAnalysisEnabled() || cb.getPlaylistKeyAnalysisByCacheKey().has(key) || preloadKeyFailedCacheKeys.has(key)) {
        return false;
      }
      return Number.isFinite(Number(result?.bpm));
    },
    onWaveformStart(target) {
      const key = cb.resolvePreloadTargetKey(target);
      appendPreloadTrace('waveform-start', `key=${key || '-'} url=${target.url}`);
    },
    onWaveformComplete(target, success, waveform) {
      const key = cb.resolvePreloadTargetKey(target);
      appendPreloadTrace('waveform-complete', `key=${key || '-'} ok=${success ? '1' : '0'}`);
      if (key && waveform) {
        cb.getPlaylistWaveformByCacheKey().set(key, waveform);
      }
    },
    onWaveformSkipped(target, reason) {
      const key = cb.resolvePreloadTargetKey(target);
      appendPreloadTrace('waveform-skip', `key=${key || '-'} reason=${reason || 'unknown'}`);
    }
  }, { maxConcurrentPreloads: options.maxConcurrentPreloads });

  // ── Key pass helpers ──

  const cancelDiscoverPreloadKeyPass = (): void => {
    for (const cancel of preloadKeyCancelByTargetKey.values()) {
      cancel();
    }
    preloadKeyCancelByTargetKey.clear();
    discoverPreloadKeyInFlightTargetKeys.clear();
    discoverPreloadKeyQueue = [];
    discoverPreloadKeySignature = '';
    discoverPreloadKeyBatchSettled = false;
    clearAllPreloadKeyTrackAnalyzing();
  };

  const resetDiscoverPreloadFailureEpoch = (): void => {
    preloadEpochFailedCacheKeys.clear();
    preloadDeferredRetryUntilByCacheKey.clear();
  };

  const resetDiscoverPreloadBpmEpoch = (): void => {
    discoverPreloadEpochTargets = [];
    discoverPreloadSignature = '';
    discoverPreloadRunnableSignature = '';
    discoverPreloadBpmBatchSettled = false;
    discoverPreloadBpmBatchOpenTs = 0;
    discoverPreloadKeyBatchOpenTs = 0;
  };

  const isDiscoverPreloadBpmTargetTerminal = (cacheKey: string): boolean => {
    if (!cacheKey) {
      return true;
    }
    if (cb.hasCachedBpm(cacheKey)) {
      return true;
    }
    if (preloadEpochFailedCacheKeys.has(cacheKey)) {
      return true;
    }
    return !cb.canAttemptAnalysis(cacheKey);
  };

  const buildNextDiscoverPreloadBpmEpochTargets = (): PreloadTarget[] =>
    buildPreloadEpochTargets({
      targets: buildDiscoverPreloadQueue(
        cb.getPlaylistTracks(),
        cb.getPlaylistCurrentIndex(),
        cb.getNowPlayingStreamUrl()
      ),
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      isTerminal: isDiscoverPreloadBpmTargetTerminal
    });

  const buildDiscoverPreloadEpochSignature = (targets: PreloadTarget[]): string =>
    buildPreloadTargetSignature(`${cb.getPlaylistRunId()}|${cb.getNowPlayingStreamUrl()}`, targets);

  const resolveDiscoverPreloadKeyStartupBlockReason = (): string => {
    if (!cb.isPreloadTracksEnabled()) {
      return 'preload-disabled';
    }
    if (!cb.isKeyAnalysisEnabled()) {
      return 'key-disabled';
    }
    return cb.resolvePreloadStartupBlockReason();
  };

  const buildDiscoverPreloadKeyTasks = (): Array<{ target: PreloadTarget; bpm: number }> => {
    if (!cb.isPreloadTracksEnabled() || !cb.isKeyAnalysisEnabled()) {
      return [];
    }
    return buildSharedPreloadKeyTasks({
      targets: buildDiscoverPreloadQueue(cb.getPlaylistTracks(), cb.getPlaylistCurrentIndex(), cb.getNowPlayingStreamUrl()),
      maxTargets: DISCOVER_PRELOAD_MAX_ENQUEUED_TARGETS,
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      bpmByCacheKey: cb.getPlaylistBpmByCacheKey(),
      keyAnalysisByCacheKey: cb.getPlaylistKeyAnalysisByCacheKey(),
      failedCacheKeys: preloadKeyFailedCacheKeys
    });
  };

  const startOneDiscoverKeyAnalysis = (next: { target: PreloadTarget; bpm: number }, targetKey: string): void => {
    const expectedRunId = cb.getPlaylistRunId();
    const expectedSource = cb.getNowPlayingStreamUrl();
    discoverPreloadKeyInFlightTargetKeys.add(targetKey);
    const startedLoading = setPreloadKeyTrackAnalyzing(targetKey, true);
    appendPreloadTrace('key-start', `key=${targetKey} bpm=${next.bpm} url=${next.target.url}`);

    const cleanupSlot = (): void => {
      discoverPreloadKeyInFlightTargetKeys.delete(targetKey);
      preloadKeyCancelByTargetKey.delete(targetKey);
    };

    const cancel = requestKeyForSource({
      sourceUrl: next.target.url,
      bpm: next.bpm,
      cacheKey: next.target.cacheKey,
      shouldApply: () => (
        expectedRunId === cb.getPlaylistRunId()
        && cb.getNowPlayingStreamUrl() === expectedSource
        && cb.isPreloadTracksEnabled()
        && cb.isKeyAnalysisEnabled()
        && discoverPreloadKeyInFlightTargetKeys.has(targetKey)
      ),
      onPending: () => {},
      onSuccess: (keyAnalysis, _keyStatus, _elapsedMs, debug) => {
        cleanupSlot();
        cb.getPlaylistKeyAnalysisByCacheKey().set(targetKey, keyAnalysis);
        preloadKeyFailedCacheKeys.delete(targetKey);
        setPreloadKeyTrackAnalyzing(targetKey, false);
        appendPreloadTrace(
          'key-complete',
          `key=${targetKey} top=${keyAnalysis.topKeys[0]?.camelot || '-'} ${formatKeyTraceDebug(debug)}`
        );
        preloader.startWaveform(next.target);
        applyPlaylistAnalysisDecorations();
        syncDiscoverPreloadKeyQueue();
        cb.render();
      },
      onFailure: (statusText) => {
        const cancelled = /cancel/i.test(statusText);
        cleanupSlot();
        setPreloadKeyTrackAnalyzing(targetKey, false);
        if (!cancelled) {
          preloadKeyFailedCacheKeys.add(targetKey);
        }
        appendPreloadTrace(
          cancelled ? 'key-cancel' : 'key-failure',
          `key=${targetKey} reason=${statusText || 'unknown'}`
        );
        preloader.startWaveform(next.target);
        syncDiscoverPreloadKeyQueue();
        cb.render();
      },
      onDropped: (reason, elapsedMs) => {
        cleanupSlot();
        setPreloadKeyTrackAnalyzing(targetKey, false);
        appendPreloadTrace('key-drop', `key=${targetKey} reason=${reason} elapsedMs=${elapsedMs}`);
        syncDiscoverPreloadKeyQueue();
        cb.render();
      }
    });
    preloadKeyCancelByTargetKey.set(targetKey, cancel);
    if (startedLoading) {
      applyPlaylistAnalysisDecorations();
      cb.render();
    }
  };

  const maybeKickoffDiscoverPreloadKeyQueue = (): void => {
    if (Boolean(resolveDiscoverPreloadKeyStartupBlockReason())) {
      return;
    }
    while (discoverPreloadKeyInFlightTargetKeys.size < maxConcurrentKeyAnalyses && discoverPreloadKeyQueue.length > 0) {
      const next = discoverPreloadKeyQueue.shift();
      if (!next) {
        break;
      }
      const targetKey = cb.resolvePreloadTargetKey(next.target);
      if (!targetKey || discoverPreloadKeyInFlightTargetKeys.has(targetKey)) {
        continue;
      }
      startOneDiscoverKeyAnalysis(next, targetKey);
    }
  };

  const syncDiscoverPreloadKeyQueue = (): void => {
    if (!cb.isPreloadTracksEnabled() || !cb.isKeyAnalysisEnabled()) {
      cancelDiscoverPreloadKeyPass();
      if (cb.isPreloadTracksEnabled()) {
        discoverPreloadKeyBatchSettled = true;
        preloader.flushDeferredWaveforms();
      }
      return;
    }
    const tasks = buildDiscoverPreloadKeyTasks();
    const signature = buildPreloadKeyTaskSignature(`${cb.getPlaylistRunId()}|${cb.getNowPlayingStreamUrl()}`, tasks);

    if (signature !== discoverPreloadKeySignature) {
      const hadActiveBatch = !discoverPreloadKeyBatchSettled && Boolean(discoverPreloadKeySignature);
      discoverPreloadKeySignature = signature;
      discoverPreloadKeyBatchSettled = false;
      discoverPreloadKeyQueue = tasks.filter(
        ({ target }) => !discoverPreloadKeyInFlightTargetKeys.has(cb.resolvePreloadTargetKey(target))
      );
      if (tasks.length > 0) {
        if (!discoverPreloadKeyBatchOpenTs && !hadActiveBatch) { discoverPreloadKeyBatchOpenTs = Date.now(); }
        appendPreloadTrace(
          hadActiveBatch ? 'key-batch-update' : 'key-batch-open',
          `run=${cb.getPlaylistRunId()} tasks=${tasks.length} blocked=${resolveDiscoverPreloadKeyStartupBlockReason() || '-'}`
        );
      }
    }

    maybeKickoffDiscoverPreloadKeyQueue();
    if (preloadKeyCancelByTargetKey.size === 0 && discoverPreloadKeyQueue.length === 0 && !discoverPreloadKeyBatchSettled) {
      discoverPreloadKeyBatchSettled = true;
      appendPreloadTrace('key-batch-settle', `run=${cb.getPlaylistRunId()} reason=idle`);
    }
  };

  const syncDiscoverPreloadQueue = (): void => {
    preloader.setEnabled(cb.isPreloadTracksEnabled());
    if (!cb.isPreloadTracksEnabled()) {
      discoverPreloadIdleSyncSignature = '';
      discoverPreloadDormantSyncSignature = '';
      cancelDiscoverPreloadKeyPass();
      preloader.setQueue([]);
      resetDiscoverPreloadBpmEpoch();
      appendPreloadTrace('queue-disabled', 'preloadTracksEnabled=0');
      return;
    }

    const preloadDebug = preloader.getDebugState();
    const bpmPassIdle = !preloadDebug.inFlight && preloadDebug.queueLength === 0;
    const keyPassIdle = preloadKeyCancelByTargetKey.size === 0 && discoverPreloadKeyQueue.length === 0;
    const blockedReason = cb.resolvePreloadStartupBlockReason();
    const keyBlockedReason = resolveDiscoverPreloadKeyStartupBlockReason();
    if (
      discoverPreloadBpmBatchSettled
      && discoverPreloadKeyBatchSettled
      && bpmPassIdle
      && keyPassIdle
    ) {
      const idleSignature = [
        cb.getPlaylistRunId(),
        cb.getNowPlayingStreamUrl(),
        cb.getPlaylistTracks().length,
        cb.getPlaylistCurrentIndex(),
        cb.isPreloadTracksEnabled() ? '1' : '0',
        cb.isKeyAnalysisEnabled() ? '1' : '0',
        discoverPreloadSignature || '-',
        discoverPreloadKeySignature || '-',
        blockedReason || '-',
        keyBlockedReason || '-'
      ].join('|');
      if (idleSignature === discoverPreloadIdleSyncSignature) {
        return;
      }
      discoverPreloadIdleSyncSignature = idleSignature;

      const nextEpochTargets = buildNextDiscoverPreloadBpmEpochTargets();
      const nextEpochSignature = buildDiscoverPreloadEpochSignature(nextEpochTargets);
      if (nextEpochTargets.length > 0 && nextEpochSignature !== discoverPreloadSignature) {
        resetDiscoverPreloadBpmEpoch();
        cancelDiscoverPreloadKeyPass();
      } else {
        syncDiscoverPreloadKeyQueue();
        return;
      }
    } else {
      discoverPreloadIdleSyncSignature = '';
    }

    // Once the BPM epoch is fully terminal, let the key pass finish without
    // repeatedly rebuilding the same empty runnable queue on every sync tick.
    if (
      bpmPassIdle
      && discoverPreloadEpochTargets.length > 0
      && discoverPreloadEpochTargets.every((target) => isDiscoverPreloadBpmTargetTerminal(cb.resolvePreloadTargetKey(target)))
    ) {
      if (!discoverPreloadBpmBatchSettled) {
        appendPreloadTrace('bpm-batch-settle', `run=${cb.getPlaylistRunId()} reason=epoch-complete`);
      }
      discoverPreloadBpmBatchSettled = true;
      syncDiscoverPreloadKeyQueue();
      return;
    }

    if (discoverPreloadEpochTargets.length === 0) {
      discoverPreloadEpochTargets = buildNextDiscoverPreloadBpmEpochTargets();
      discoverPreloadSignature = buildDiscoverPreloadEpochSignature(discoverPreloadEpochTargets);
      discoverPreloadRunnableSignature = '';
      discoverPreloadKeyBatchSettled = false;
      if (discoverPreloadEpochTargets.length > 0) {
        if (!discoverPreloadBpmBatchOpenTs) { discoverPreloadBpmBatchOpenTs = Date.now(); }
        appendPreloadTrace('bpm-batch-open', `run=${cb.getPlaylistRunId()} targets=${discoverPreloadEpochTargets.length}`);
      }
    }

    const unresolvedTargets = filterDeferredPreloadTargets({
      targets: discoverPreloadEpochTargets,
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      isTerminal: isDiscoverPreloadBpmTargetTerminal,
      deferredRetryUntilByCacheKey: preloadDeferredRetryUntilByCacheKey
    });
    const { targets, stats } = filterPreloadTargets(
      unresolvedTargets,
      DISCOVER_PRELOAD_MAX_ENQUEUED_TARGETS,
      cb.getPlaylistAnalysisCache()
    );
    const runnableSignature = buildPreloadTargetSignature(`${discoverPreloadSignature}|run`, targets);
    const blocked = Boolean(blockedReason);
    const dormantSignature = buildDormantPreloadSyncSignature({
      blocked,
      targetsLength: targets.length,
      unresolvedTargetCount: unresolvedTargets.length,
      runnableSignature,
      previousRunnableSignature: discoverPreloadRunnableSignature,
      contextParts: [
        cb.getPlaylistRunId(),
        cb.getNowPlayingStreamUrl(),
        discoverPreloadSignature || '-',
        runnableSignature || '-'
      ],
      stats
    });
    if (dormantSignature && dormantSignature === discoverPreloadDormantSyncSignature) {
      return;
    }
    discoverPreloadDormantSyncSignature = dormantSignature;
    appendPreloadTrace(
      'queue-build',
      `tracks=${cb.getPlaylistTracks().length} unresolved=${unresolvedTargets.length} epoch=${discoverPreloadEpochTargets.length} current=${cb.getPlaylistCurrentIndex()}`
    );
    appendPreloadTrace(
      'queue-filter',
      `kept=${stats.kept} skipMissingKey=${stats.skipMissingKey} skipCached=${stats.skipCached} skipAnalyzing=${stats.skipAnalyzing} skipAttempts=${stats.skipAttempts} skipLimit=${stats.skipLimit}`
    );
    if (runnableSignature !== discoverPreloadRunnableSignature) {
      discoverPreloadRunnableSignature = runnableSignature;
      preloader.setQueue(targets);
      appendPreloadTrace('queue-set', `changed=1 size=${targets.length}`);
    } else {
      appendPreloadTrace('queue-set', `changed=0 size=${targets.length}`);
    }

    appendPreloadTrace(
      'kickoff',
      `blocked=${blocked ? '1' : '0'} reason=${blockedReason || '-'} targets=${targets.length} enabled=${preloadDebug.enabled ? '1' : '0'} inFlight=${preloadDebug.inFlight ? '1' : '0'} queue=${preloadDebug.queueLength} inFlightMs=${preloadDebug.inFlightMs}`
    );
    void preloader.maybeKickoff({
      blocked
    });
    const bpmEpochSettled = discoverPreloadEpochTargets.length === 0
      || discoverPreloadEpochTargets.every((target) => isDiscoverPreloadBpmTargetTerminal(cb.resolvePreloadTargetKey(target)));
    if (bpmEpochSettled) {
      if (!discoverPreloadBpmBatchSettled) {
        appendPreloadTrace('bpm-batch-settle', `run=${cb.getPlaylistRunId()} reason=epoch-complete`);
      }
      discoverPreloadBpmBatchSettled = true;
    } else {
      discoverPreloadBpmBatchSettled = false;
    }
    syncDiscoverPreloadKeyQueue();
  };

  // ── Public interface ──

  return {
    preloader,
    syncDiscoverPreloadQueue,
    cancelDiscoverPreloadKeyPass,
    resetDiscoverPreloadBpmEpoch,
    resetDiscoverPreloadFailureEpoch,
    clearPreloadKeyFailedCacheKeys: () => { preloadKeyFailedCacheKeys.clear(); },
    clearAllPreloadKeyTrackAnalyzing,
    applyPlaylistAnalysisDecorations,
    getPreloadTrace: () => preloadTrace,
    getPreloadEpochTargets: () => discoverPreloadEpochTargets,
    getPreloadBpmBatchSettled: () => discoverPreloadBpmBatchSettled,
    getPreloadBpmBatchOpenTs: () => discoverPreloadBpmBatchOpenTs,
    getPreloadKeyBatchOpenTs: () => discoverPreloadKeyBatchOpenTs,
    getPreloadKeyQueueLength: () => discoverPreloadKeyQueue.length,
    getPreloadKeyInFlightTargetKey: () => discoverPreloadKeyInFlightTargetKeys.size > 0 ? Array.from(discoverPreloadKeyInFlightTargetKeys).join(',') : '',
    getPreloadKeyStartupBlockReason: () => resolveDiscoverPreloadKeyStartupBlockReason(),
    getPreloadDeferredRetryUntilByCacheKey: () => preloadDeferredRetryUntilByCacheKey,
    getPreloadKeyAnalyzingCacheKeys: () => preloadKeyAnalyzingCacheKeys,
    getPreloadEpochFailedCacheKeys: () => preloadEpochFailedCacheKeys,
    getPreloadKeyFailedCacheKeys: () => preloadKeyFailedCacheKeys,
    getPreloadBlockedReason: () => cb.resolvePreloadStartupBlockReason()
  };
}
