import type { KeyAnalysisResult, PlaylistTrack, WaveformBands } from '@/shared/types';
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
import {
  formatKeyTraceDebug,
  formatPlaylistKeySummary
} from '@/content/analysis/debug-helpers';
import {
  buildTrackCacheKey,
  normalizeCacheKey,
  resolveSourceTrackCacheKey
} from '@/content/playlist/track-identity';
import { buildPlaylistAnalysisProgressLines } from '@/content/playlist/analysis-progress-debug';
import { decoratePlaylistTracks } from '@/content/playlist/analysis-decoration';
import { applyPlaylistSort } from '@/content/playlist/sorter';
import { buildDebugSections } from '@/content/player/render';
import type { DebugSectionsFactory } from '@/shared/debug-trace';
import type { PlayerState } from '@/content/player/state';
import { getLatestPageGlobals } from '@/content/discover/origin-bridge';
import { getCachedApiTralbum } from '@/content/metadata/extractor/api/cache';
import { readTrackIdFromUrl } from '@/content/metadata/common';

const PRELOAD_MAX_ENQUEUED_TARGETS = 6;
const PRELOAD_TIMEOUT_RETRY_DELAY_MS = 20_000;

function isBandcampStreamRedirectUrl(url: string): boolean {
  return /\/stream_redirect\b/i.test(String(url || '').trim());
}

function readRuntimeTrackStreamUrl(trackRaw: unknown): string {
  if (!trackRaw || typeof trackRaw !== 'object') {
    return '';
  }

  const track = trackRaw as Record<string, unknown>;
  const file = (track.file ?? null) as Record<string, unknown> | null;
  const fromFile = String(file?.['mp3-128'] ?? file?.['mp3-v0'] ?? file?.['mp3-320'] ?? '').trim();
  if (fromFile) {
    return fromFile;
  }

  const streaming = track.streaming_url ?? track.streamingUrl;
  if (typeof streaming === 'string') {
    const raw = streaming.trim();
    if (raw) {
      return raw;
    }
  }

  if (streaming && typeof streaming === 'object') {
    const record = streaming as Record<string, unknown>;
    const fromStreaming = String(record['mp3-128'] ?? record['mp3-v0'] ?? record['mp3-320'] ?? '').trim();
    if (fromStreaming) {
      return fromStreaming;
    }
  }

  return String(track.stream_url ?? track.streamUrl ?? '').trim();
}

function resolveStablePreloadFetchUrl(sourceUrl: string): string {
  const normalizedSource = String(sourceUrl || '').trim();
  if (!normalizedSource) {
    return '';
  }
  if (!isBandcampStreamRedirectUrl(normalizedSource)) {
    return normalizedSource;
  }

  const cachedTralbum = getCachedApiTralbum(getLatestPageGlobals(60_000), normalizedSource);
  if (!cachedTralbum) {
    return '';
  }

  const sourceTrackId = readTrackIdFromUrl(normalizedSource);
  const trackArrays = [
    ...(Array.isArray(cachedTralbum.tracks) ? [cachedTralbum.tracks] : []),
    ...(Array.isArray(cachedTralbum.trackinfo) ? [cachedTralbum.trackinfo] : [])
  ];

  for (const tracks of trackArrays) {
    for (const track of tracks) {
      const trackRecord = track as Record<string, unknown>;
      const trackId = String(trackRecord.track_id ?? trackRecord.id ?? '').trim();
      const streamUrl = readRuntimeTrackStreamUrl(trackRecord);
      if (!streamUrl || isBandcampStreamRedirectUrl(streamUrl)) {
        continue;
      }
      if (sourceTrackId && trackId && trackId === sourceTrackId) {
        return streamUrl;
      }
    }
  }

  return '';
}

export interface PreloadControllerCallbacks {
  getState(): PlayerState;
  getSourceVersion(): number;
  getCurrentSrc(): string;
  getPlaylistTracks(): PlaylistTrack[];
  getPlaylistCurrentIndex(): number;

  isPreloadTracksEnabled(): boolean;
  isKeyAnalysisEnabled(): boolean;

  resolvePreloadStartupBlockReason(): string;
  isCurrentSourcePreloadPhaseReady(): boolean;

  // Analysis cache facade
  resolvePreloadTargetKey(target: PreloadTarget): string;
  hasCachedBpm(cacheKey: string): boolean;
  setCachedBpm(cacheKey: string, bpm: number): boolean;
  canAttemptAnalysis(cacheKey: string): boolean;
  registerAnalysisAttempt(cacheKey: string): void;
  setPlaylistTrackAnalyzing(cacheKey: string, analyzing: boolean): boolean;
  clearPlaylistTrackAnalyzing(): void;

  // Cache maps (direct access for decorations and debug)
  getPlaylistBpmByCacheKey(): Map<string, number>;
  getPlaylistKeyAnalysisByCacheKey(): Map<string, KeyAnalysisResult>;
  getPlaylistWaveformByCacheKey(): Map<string, WaveformBands>;
  getPlaylistAnalyzingCacheKeys(): Set<string>;
  getPlaylistFailedCacheKeys(): Set<string>;
  getPlaylistAttemptCountByCacheKey(): Map<string, number>;
  getPlaylistConfidenceByCacheKey(): Map<string, number>;
  getPlaylistAnalysisCache(): PlaylistAnalysisCache;

  // Rendering and debug
  requestRender(): void;
  pushDebug(title: string, sectionsFactory: DebugSectionsFactory): void;

  // Like phase integration
  maybeStartCurrentSourceDeepLikePhase(): void;
  maybeStartCurrentSourceLikePhases(forceTargeted?: boolean): void;

  // Analysis request controller integration
  getActiveTempoTrackCacheKey(): string;
  setActiveTempoTrackCacheKey(key: string): void;
  getLastAnalysis(): PlayerState['lastAnalysis'];
  setPlaylist(playlist: PlayerState['playlist']): void;
}

export interface PreloadController {
  readonly preloader: ReturnType<typeof createPreloader>;

  syncPreloadQueue(expectedSourceVersion?: number): void;
  cancelPreloadKeyPass(): void;
  resetPreloadBpmBatchGate(): void;
  resetPreloadFailureEpoch(): void;
  clearPreloadKeyFailedCacheKeys(): void;
  applyPlaylistAnalysisDecorations(): void;
  refreshPlayerPreloadDebugSnapshot(): void;
  maybeStartCurrentSourceBackgroundPhase(): void;

  // For direct state access from callers that need to reset specific fields
  resetPreloadQueueSignature(): void;

  // Expose for settings callback and debug cache reset
  getPreloadDeferredRetryUntilByCacheKey(): Map<string, number>;
  getPreloadKeyAnalyzingCacheKeys(): Set<string>;
}

export interface PreloadControllerOptions {
  maxConcurrentPreloads?: number;
  maxConcurrentKeyAnalyses?: number;
}

export function createPreloadController(
  cb: PreloadControllerCallbacks,
  options: PreloadControllerOptions = {}
): PreloadController {
  // ── Internal preload state ──
  let preloadPhaseOwnerSignature = '';
  let preloadQueueSignature = '';
  let preloadRunnableQueueSignature = '';
  let preloadBpmEpochTargets: PreloadTarget[] = [];
  let preloadBpmBatchSettledForSourceVersion = false;
  let preloadKeyBatchSettledForSourceVersion = false;
  let preloadBpmBatchOpenTs = 0;
  let preloadKeyBatchOpenTs = 0;
  let preloadKeyQueueSignature = '';
  let preloadIdleSyncSignature = '';
  let preloadDormantSyncSignature = '';
  let preloadKeyQueue: Array<{ target: PreloadTarget; bpm: number }> = [];
  const preloadKeyInFlightTargetKeys = new Set<string>();
  const preloadKeyCancelByTargetKey = new Map<string, () => void>();

  const preloadKeyFailedCacheKeys = new Set<string>();
  const preloadEpochFailedCacheKeys = new Set<string>();
  const preloadBpmFailureDetailByCacheKey = new Map<string, string>();
  const preloadDeferredRetryUntilByCacheKey = new Map<string, number>();
  const preloadKeyAnalyzingCacheKeys = new Set<string>();

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

  // ── Pure helpers ──

  function buildPreloadQueue(
    tracks: PlaylistTrack[],
    currentIndex: number,
    currentSrc: string
  ): PreloadTarget[] {
    if (!tracks.length) {
      return [];
    }

    const normalizedCurrentSrc = String(currentSrc || '').trim();
    const ordered: PlaylistTrack[] = [];
    const total = tracks.length;
    const startIndex = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < total ? currentIndex : 0;

    for (let offset = 1; offset < total; offset += 1) {
      const index = (startIndex + offset) % total;
      const track = tracks[index];
      if (!track) {
        continue;
      }
      ordered.push(track);
    }

    const targets: PreloadTarget[] = [];
    for (const track of ordered) {
      const streamUrl = String(track.streamUrl || '').trim();
      if (!streamUrl || track.playable === false) {
        continue;
      }
      if (normalizedCurrentSrc && streamUrl === normalizedCurrentSrc) {
        continue;
      }

      targets.push({
        url: streamUrl,
        fetchUrl: resolveStablePreloadFetchUrl(streamUrl) || undefined,
        cacheKey: buildTrackCacheKey(track, streamUrl, { includePageUrl: true })
      });
    }

    return targets;
  }

  // ── Debug / trace ──

  const refreshPlayerPreloadDebugSnapshot = (): void => {
    const state = cb.getState();
    const currentSource = cb.getCurrentSrc();
    const currentTrackKey = resolveSourceTrackCacheKey(cb.getPlaylistTracks(), currentSource, {
      includePageUrl: true
    });
    const playlistBpmByCacheKey = cb.getPlaylistBpmByCacheKey();
    const playlistKeyAnalysisByCacheKey = cb.getPlaylistKeyAnalysisByCacheKey();
    const playlistWaveformByCacheKey = cb.getPlaylistWaveformByCacheKey();
    const playlistAnalyzingCacheKeys = cb.getPlaylistAnalyzingCacheKeys();
    const playlistFailedCacheKeys = cb.getPlaylistFailedCacheKeys();
    const playlistAttemptCountByCacheKey = cb.getPlaylistAttemptCountByCacheKey();
    const currentTrackBpm = currentTrackKey ? playlistBpmByCacheKey.get(currentTrackKey) : undefined;
    const currentTrackKeyAnalysis = currentTrackKey ? playlistKeyAnalysisByCacheKey.get(currentTrackKey) : undefined;
    const preloadDebug = preloader.getDebugState();
    const playlistTracks = cb.getPlaylistTracks();
    const lines = [
      `settings: preloadEnabled=${cb.isPreloadTracksEnabled() ? '1' : '0'} keyAnalysisEnabled=${cb.isKeyAnalysisEnabled() ? '1' : '0'}`,
      `gate: bpmBlocked=${cb.resolvePreloadStartupBlockReason() || '-'} keyBlocked=${resolvePreloadKeyStartupBlockReason() || '-'} bpmBatchSettled=${preloadBpmBatchSettledForSourceVersion ? '1' : '0'} keyBatchSettled=${preloadKeyBatchSettledForSourceVersion ? '1' : '0'} preloadBpmStartTs=${preloadBpmBatchOpenTs || '-'} preloadKeyStartTs=${preloadKeyBatchOpenTs || '-'}`,
      `preloader: enabled=${preloadDebug.enabled ? '1' : '0'} inFlight=${preloadDebug.inFlight ? '1' : '0'} queue=${preloadDebug.queueLength} inFlightMs=${preloadDebug.inFlightMs} keyQueue=${preloadKeyQueue.length} keyInFlight=${preloadKeyInFlightTargetKeys.size > 0 ? Array.from(preloadKeyInFlightTargetKeys).join(',') : '-'} sourceVersion=${cb.getSourceVersion()}`,
      `cache: bpm=${playlistBpmByCacheKey.size}, key=${playlistKeyAnalysisByCacheKey.size}, waveform=${playlistWaveformByCacheKey.size}, analyzing=${playlistAnalyzingCacheKeys.size}, failed=${playlistFailedCacheKeys.size}, attempted=${playlistAttemptCountByCacheKey.size}, preloadKeyFailed=${preloadKeyFailedCacheKeys.size}`,
      ...buildPlaylistAnalysisProgressLines({
        tracks: playlistTracks,
        preloadEnabled: cb.isPreloadTracksEnabled(),
        keyAnalysisEnabled: cb.isKeyAnalysisEnabled(),
        bpmByCacheKey: playlistBpmByCacheKey,
        keyAnalysisByCacheKey: playlistKeyAnalysisByCacheKey,
        bpmAnalyzingCacheKeys: playlistAnalyzingCacheKeys,
        bpmFailedCacheKeys: playlistFailedCacheKeys,
        keyFailedCacheKeys: preloadKeyFailedCacheKeys,
        bpmInFlight: preloadDebug.inFlight,
        bpmQueueLength: preloadDebug.queueLength,
        keyInFlightCount: preloadKeyInFlightTargetKeys.size,
        keyQueueLength: preloadKeyQueue.length,
        bpmBlockedReason: cb.resolvePreloadStartupBlockReason(),
        keyBlockedReason: resolvePreloadKeyStartupBlockReason(),
        resolveTrackCacheKey: (track) => normalizeCacheKey(
          buildTrackCacheKey(track, String(track.streamUrl || '').trim(), { includePageUrl: true })
        )
      }),
      `current: index=${cb.getPlaylistCurrentIndex()} key=${currentTrackKey || '-'} bpm=${Number.isFinite(currentTrackBpm) ? Math.round(Number(currentTrackBpm)) : '-'} ${formatPlaylistKeySummary(currentTrackKeyAnalysis)} hasBpm=${currentTrackKey && playlistBpmByCacheKey.has(currentTrackKey) ? '1' : '0'} hasKey=${currentTrackKey && playlistKeyAnalysisByCacheKey.has(currentTrackKey) ? '1' : '0'} hasWaveform=${currentTrackKey && playlistWaveformByCacheKey.has(currentTrackKey) ? '1' : '0'} analyzing=${currentTrackKey && playlistAnalyzingCacheKeys.has(currentTrackKey) ? '1' : '0'} failed=${currentTrackKey && playlistFailedCacheKeys.has(currentTrackKey) ? '1' : '0'}`
    ];

    playlistTracks.forEach((track, index) => {
      const key = normalizeCacheKey(
        buildTrackCacheKey(track, String(track.streamUrl || '').trim(), { includePageUrl: true })
      );
      const bpm = key ? playlistBpmByCacheKey.get(key) : undefined;
      const keyAnalysis = key ? playlistKeyAnalysisByCacheKey.get(key) : undefined;
      const attempts = key ? (playlistAttemptCountByCacheKey.get(key) || 0) : 0;
      const lastBpmFailure = key ? (preloadBpmFailureDetailByCacheKey.get(key) || '') : '';
      lines.push(
        `track[${index}] key=${key || '-'} bpm=${Number.isFinite(bpm) ? Math.round(Number(bpm)) : '-'} ${formatPlaylistKeySummary(keyAnalysis)} hasBpm=${key && playlistBpmByCacheKey.has(key) ? '1' : '0'} hasKey=${key && playlistKeyAnalysisByCacheKey.has(key) ? '1' : '0'} hasWaveform=${key && playlistWaveformByCacheKey.has(key) ? '1' : '0'} analyzing=${key && playlistAnalyzingCacheKeys.has(key) ? '1' : '0'} failed=${key && playlistFailedCacheKeys.has(key) ? '1' : '0'} preloadKeyFailed=${key && preloadKeyFailedCacheKeys.has(key) ? '1' : '0'} attempts=${attempts} lastBpmFailure=${lastBpmFailure || '-'}`
      );
    });

    state.preloadStateLines = lines;
    state.preloadDebugSnapshot = {
      trace: state.preloadTrace.slice(),
      stateLines: lines.slice(),
      preloadBpmBatchOpenTs,
      preloadKeyBatchOpenTs
    };
  };

  const appendPreloadTrace = (stage: string, detail: string): void => {
    const state = cb.getState();
    state.preloadTrace.push({ ts: Date.now(), stage, detail });
    if (state.preloadTrace.length > 120) {
      state.preloadTrace.splice(0, state.preloadTrace.length - 120);
    }
    refreshPlayerPreloadDebugSnapshot();
    cb.pushDebug('Debugger', () => buildDebugSections(state));
  };

  // ── Playlist analysis decorations ──

  const applyPlaylistAnalysisDecorations = (): void => {
    const state = cb.getState();
    if (!state.playlist.tracks.length) {
      return;
    }

    const playlistBpmByCacheKey = cb.getPlaylistBpmByCacheKey();
    const playlistKeyAnalysisByCacheKey = cb.getPlaylistKeyAnalysisByCacheKey();
    const playlistFailedCacheKeys = cb.getPlaylistFailedCacheKeys();

    // Backfill: if the BPM arrived before the playlist was populated,
    // state.lastAnalysis has the result but playlistBpmByCacheKey was never written.
    const currentSourceUrl = cb.getCurrentSrc();
    if (
      currentSourceUrl
      && Number.isFinite(state.lastAnalysis?.bpm)
      && state.lastAnalysis?.sourceUrl === currentSourceUrl
    ) {
      const backfillKey = resolveSourceTrackCacheKey(state.playlist.tracks, currentSourceUrl, {
        includePageUrl: true
      });
      if (backfillKey) {
        cb.setCachedBpm(backfillKey, Number(state.lastAnalysis.bpm));
        playlistFailedCacheKeys.delete(backfillKey);
      }
      if (backfillKey && !cb.getActiveTempoTrackCacheKey()) {
        cb.setActiveTempoTrackCacheKey(backfillKey);
        if (Number.isFinite(state.lastAnalysis?.confidence)) {
          cb.setPlaylistTrackAnalyzing(backfillKey, false);
        }
      }
      if (backfillKey && cb.isKeyAnalysisEnabled() && state.lastAnalysis?.keyAnalysis && !playlistKeyAnalysisByCacheKey.has(backfillKey)) {
        playlistKeyAnalysisByCacheKey.set(backfillKey, state.lastAnalysis.keyAnalysis);
      }
    }

    const activeSourceUrl = cb.getCurrentSrc();
    const currentTrackCacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, activeSourceUrl, {
      includePageUrl: true
    });
    const currentTrackKeyLoading = Boolean(
      cb.isKeyAnalysisEnabled()
      && state.lastAnalysis
      && String(state.lastAnalysis.sourceUrl || '').trim() === activeSourceUrl
      && state.lastAnalysis.keyStatus === 'analyzing'
    );

    const result = decoratePlaylistTracks(state.playlist.tracks, {
      bpmByKey: playlistBpmByCacheKey,
      keyAnalysisByKey: playlistKeyAnalysisByCacheKey,
      analyzingKeys: cb.getPlaylistAnalyzingCacheKeys(),
      failedKeys: playlistFailedCacheKeys,
      preloadKeyAnalyzingKeys: preloadKeyAnalyzingCacheKeys,
      deferredRetryUntilByKey: preloadDeferredRetryUntilByCacheKey
    }, {
      keyAnalysisEnabled: cb.isKeyAnalysisEnabled(),
      currentTrackCacheKey,
      currentTrackKeyLoading,
      resolveCacheKey: (track) => normalizeCacheKey(
        buildTrackCacheKey(track, String(track.streamUrl || '').trim(), { includePageUrl: true })
      )
    });

    if (!result.changed) {
      return;
    }

    cb.setPlaylist(applyPlaylistSort({
      ...state.playlist,
      tracks: result.tracks
    }));
  };

  // ── Preloader instance ──

  const maxConcurrentKeyAnalyses = options.maxConcurrentKeyAnalyses ?? 1;

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
      preloadBpmFailureDetailByCacheKey.delete(key);
      if (cb.setPlaylistTrackAnalyzing(key, true)) {
        cb.requestRender();
      }
    },
    onTrackComplete(target, result, outcome, failureDetail) {
      const key = cb.resolvePreloadTargetKey(target);
      appendPreloadTrace(
        'complete',
        `key=${key || '-'} bpm=${Number.isFinite(result?.bpm) ? Math.round(Number(result?.bpm)) : '-'} outcome=${outcome} reason=${failureDetail || '-'}`
      );
      let shouldRender = false;

      if (key && cb.setPlaylistTrackAnalyzing(key, false)) {
        shouldRender = true;
      }

      if (key) {
        const bpm = Number(result?.bpm);
        const playlistKeyAnalysisByCacheKey = cb.getPlaylistKeyAnalysisByCacheKey();
        const playlistBpmByCacheKey = cb.getPlaylistBpmByCacheKey();
        const playlistFailedCacheKeys = cb.getPlaylistFailedCacheKeys();
        if (outcome === 'cancelled') {
          const attempts = cb.getPlaylistAttemptCountByCacheKey();
          const attemptCount = attempts.get(key) || 0;
          if (attemptCount <= 1) {
            attempts.delete(key);
          } else {
            attempts.set(key, attemptCount - 1);
          }
          preloadBpmFailureDetailByCacheKey.delete(key);
          preloadEpochFailedCacheKeys.delete(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
          appendPreloadTrace('cancel', `key=${key} reason=${failureDetail || 'analysis-cancelled'}`);
        } else if (cb.isKeyAnalysisEnabled() && result?.keyAnalysis) {
          playlistKeyAnalysisByCacheKey.set(key, result.keyAnalysis);
          shouldRender = true;
        }
        if (outcome !== 'cancelled' && Number.isFinite(bpm)) {
          if (cb.setCachedBpm(key, bpm)) {
            shouldRender = true;
          }
          const confDisplay = Number(result?.confidence);
          const confTdc = Number(result?.tempoDecisionConfidence);
          const confRaw = Number(result?.tempoRawConfidence);
          const confBest = Number.isFinite(confDisplay) && confDisplay > 0
            ? confDisplay
            : Number.isFinite(confTdc) && confTdc > 0
              ? confTdc
              : Number.isFinite(confRaw) && confRaw > 0
                ? confRaw
                : 0;
          if (confBest > 0) {
            cb.getPlaylistConfidenceByCacheKey().set(key, confBest);
          }
          playlistFailedCacheKeys.delete(key);
          preloadEpochFailedCacheKeys.delete(key);
          preloadBpmFailureDetailByCacheKey.delete(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
        } else if (outcome === 'timeout' && !playlistBpmByCacheKey.has(key)) {
          preloadBpmFailureDetailByCacheKey.set(key, failureDetail || 'preload-timeout');
          preloadDeferredRetryUntilByCacheKey.set(key, Date.now() + PRELOAD_TIMEOUT_RETRY_DELAY_MS);
          appendPreloadTrace('defer', `key=${key} retryInMs=${PRELOAD_TIMEOUT_RETRY_DELAY_MS}`);
        } else if (outcome !== 'cancelled' && !playlistBpmByCacheKey.has(key)) {
          preloadBpmFailureDetailByCacheKey.set(key, failureDetail || `analysis-${outcome}-without-bpm`);
          if (!playlistFailedCacheKeys.has(key)) {
            playlistFailedCacheKeys.add(key);
            shouldRender = true;
          }
          preloadEpochFailedCacheKeys.add(key);
          preloadDeferredRetryUntilByCacheKey.delete(key);
        }
      }

      syncPreloadQueue(cb.getSourceVersion());
      appendPreloadTrace('resync', 'trigger=onTrackComplete');
      if (shouldRender) {
        cb.requestRender();
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

  // ── Preload phase helpers ──

  const isPreloadBpmTargetTerminal = (cacheKey: string): boolean => {
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

  const buildPreloadPhaseOwnerSignature = (): string => {
    const targets = buildPreloadQueue(cb.getPlaylistTracks(), cb.getPlaylistCurrentIndex(), cb.getCurrentSrc());
    return buildPreloadTargetSignature(String(cb.getSourceVersion()), targets);
  };

  const buildNextPreloadBpmEpochTargets = (): PreloadTarget[] =>
    buildPreloadEpochTargets({
      targets: buildPreloadQueue(cb.getPlaylistTracks(), cb.getPlaylistCurrentIndex(), cb.getCurrentSrc()),
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      isTerminal: isPreloadBpmTargetTerminal
    });

  const buildPreloadEpochSig = (targets: PreloadTarget[]): string =>
    buildPreloadTargetSignature(String(cb.getSourceVersion()), targets);

  const resolvePreloadKeyStartupBlockReason = (): string => {
    if (!cb.isPreloadTracksEnabled()) {
      return 'preload-disabled';
    }
    if (!cb.isKeyAnalysisEnabled()) {
      return 'key-disabled';
    }
    return cb.resolvePreloadStartupBlockReason();
  };

  const buildPreloadKeyTasksLocal = (): Array<{ target: PreloadTarget; bpm: number }> => {
    if (!cb.isPreloadTracksEnabled() || !cb.isKeyAnalysisEnabled()) {
      return [];
    }
    return buildSharedPreloadKeyTasks({
      targets: buildPreloadQueue(cb.getPlaylistTracks(), cb.getPlaylistCurrentIndex(), cb.getCurrentSrc()),
      maxTargets: PRELOAD_MAX_ENQUEUED_TARGETS,
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      bpmByCacheKey: cb.getPlaylistBpmByCacheKey(),
      keyAnalysisByCacheKey: cb.getPlaylistKeyAnalysisByCacheKey(),
      failedCacheKeys: preloadKeyFailedCacheKeys
    });
  };

  // ── Reset helpers ──

  const cancelPreloadKeyPass = (): void => {
    for (const cancel of preloadKeyCancelByTargetKey.values()) {
      cancel();
    }
    preloadKeyCancelByTargetKey.clear();
    preloadKeyInFlightTargetKeys.clear();
    preloadKeyQueue = [];
    preloadKeyQueueSignature = '';
    preloadKeyBatchSettledForSourceVersion = false;
    clearAllPreloadKeyTrackAnalyzing();
    refreshPlayerPreloadDebugSnapshot();
  };

  const resetPreloadFailureEpoch = (): void => {
    preloadEpochFailedCacheKeys.clear();
    preloadBpmFailureDetailByCacheKey.clear();
    preloadDeferredRetryUntilByCacheKey.clear();
  };

  const resetPreloadBpmEpoch = (): void => {
    preloadBpmEpochTargets = [];
    preloadQueueSignature = '';
    preloadRunnableQueueSignature = '';
    preloadBpmBatchSettledForSourceVersion = false;
    preloadBpmBatchOpenTs = 0;
    preloadKeyBatchOpenTs = 0;
  };

  const resetPreloadBpmBatchGate = (): void => {
    resetPreloadBpmEpoch();
  };

  // ── Key queue orchestration ──

  const startOneKeyAnalysis = (expectedSourceVersion: number, next: { target: PreloadTarget; bpm: number }, targetKey: string): void => {
    const expectedSource = cb.getCurrentSrc();
    preloadKeyInFlightTargetKeys.add(targetKey);
    const startedLoading = setPreloadKeyTrackAnalyzing(targetKey, true);
    appendPreloadTrace('key-start', `key=${targetKey} bpm=${next.bpm} url=${next.target.url}`);

    const cleanupSlot = (): void => {
      preloadKeyInFlightTargetKeys.delete(targetKey);
      preloadKeyCancelByTargetKey.delete(targetKey);
    };

    const cancel = requestKeyForSource({
      sourceUrl: next.target.url,
      bpm: next.bpm,
      cacheKey: next.target.cacheKey,
      shouldApply: () => (
        expectedSourceVersion === cb.getSourceVersion()
        && cb.getCurrentSrc() === expectedSource
        && cb.isPreloadTracksEnabled()
        && cb.isKeyAnalysisEnabled()
        && preloadKeyInFlightTargetKeys.has(targetKey)
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
        syncPreloadQueue(expectedSourceVersion);
        cb.requestRender();
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
        syncPreloadQueue(expectedSourceVersion);
        cb.requestRender();
      },
      onDropped: (reason, elapsedMs) => {
        cleanupSlot();
        setPreloadKeyTrackAnalyzing(targetKey, false);
        appendPreloadTrace('key-drop', `key=${targetKey} reason=${reason} elapsedMs=${elapsedMs}`);
        syncPreloadQueue(expectedSourceVersion);
        cb.requestRender();
      }
    });
    preloadKeyCancelByTargetKey.set(targetKey, cancel);
    if (startedLoading) {
      applyPlaylistAnalysisDecorations();
      cb.requestRender();
    }
  };

  const maybeKickoffPreloadKeyQueue = (expectedSourceVersion: number): void => {
    if (expectedSourceVersion !== cb.getSourceVersion()) {
      return;
    }
    if (Boolean(resolvePreloadKeyStartupBlockReason())) {
      return;
    }
    while (preloadKeyInFlightTargetKeys.size < maxConcurrentKeyAnalyses && preloadKeyQueue.length > 0) {
      const next = preloadKeyQueue.shift();
      if (!next) {
        break;
      }
      const targetKey = cb.resolvePreloadTargetKey(next.target);
      if (!targetKey || preloadKeyInFlightTargetKeys.has(targetKey)) {
        continue;
      }
      startOneKeyAnalysis(expectedSourceVersion, next, targetKey);
    }
  };

  // ── Key queue sync ──

  const syncPreloadKeyQueue = (expectedSourceVersion: number): void => {
    if (expectedSourceVersion !== cb.getSourceVersion()) {
      return;
    }
    if (!cb.isPreloadTracksEnabled() || !cb.isKeyAnalysisEnabled()) {
      cancelPreloadKeyPass();
      if (cb.isPreloadTracksEnabled()) {
        preloadKeyBatchSettledForSourceVersion = true;
        preloader.flushDeferredWaveforms();
      }
      return;
    }
    const tasks = buildPreloadKeyTasksLocal();
    const signature = buildPreloadKeyTaskSignature(String(cb.getSourceVersion()), tasks);

    if (signature !== preloadKeyQueueSignature) {
      const hadActiveBatch = !preloadKeyBatchSettledForSourceVersion && Boolean(preloadKeyQueueSignature);
      preloadKeyQueueSignature = signature;
      preloadKeyBatchSettledForSourceVersion = false;
      preloadKeyQueue = tasks.filter(({ target }) => !preloadKeyInFlightTargetKeys.has(cb.resolvePreloadTargetKey(target)));
      if (tasks.length > 0) {
        if (!preloadKeyBatchOpenTs && !hadActiveBatch) { preloadKeyBatchOpenTs = Date.now(); }
        appendPreloadTrace(
          hadActiveBatch ? 'key-batch-update' : 'key-batch-open',
          `sourceVersion=${expectedSourceVersion} tasks=${tasks.length} blocked=${resolvePreloadKeyStartupBlockReason() || '-'}`
        );
      }
    }

    maybeKickoffPreloadKeyQueue(expectedSourceVersion);
    if (preloadKeyCancelByTargetKey.size === 0 && preloadKeyQueue.length === 0 && !preloadKeyBatchSettledForSourceVersion) {
      preloadKeyBatchSettledForSourceVersion = true;
      appendPreloadTrace('key-batch-settle', `sourceVersion=${expectedSourceVersion} reason=idle`);
    } else {
      refreshPlayerPreloadDebugSnapshot();
    }
  };

  // ── Main BPM preload sync ──

  const syncPreloadQueue = (expectedSourceVersion = cb.getSourceVersion()): void => {
    if (expectedSourceVersion !== cb.getSourceVersion()) {
      return;
    }

    preloader.setEnabled(cb.isPreloadTracksEnabled());
    if (!cb.isPreloadTracksEnabled()) {
      preloadIdleSyncSignature = '';
      preloadDormantSyncSignature = '';
      cancelPreloadKeyPass();
      preloader.setQueue([]);
      preloadPhaseOwnerSignature = '';
      resetPreloadBpmEpoch();
      appendPreloadTrace('queue-disabled', 'preloadTracksEnabled=0');
      return;
    }
    const ownerSignature = buildPreloadPhaseOwnerSignature();
    if (ownerSignature !== preloadPhaseOwnerSignature) {
      preloadPhaseOwnerSignature = ownerSignature;
      resetPreloadBpmEpoch();
      cancelPreloadKeyPass();
    }

    const preloadDebug = preloader.getDebugState();
    const bpmPassIdle = !preloadDebug.inFlight && preloadDebug.queueLength === 0;
    const keyPassIdle = preloadKeyCancelByTargetKey.size === 0 && preloadKeyQueue.length === 0;
    const blockedReason = cb.resolvePreloadStartupBlockReason();
    const keyBlockedReason = resolvePreloadKeyStartupBlockReason();
    if (
      preloadBpmBatchSettledForSourceVersion
      && preloadKeyBatchSettledForSourceVersion
      && bpmPassIdle
      && keyPassIdle
    ) {
      const idleSignature = [
        expectedSourceVersion,
        ownerSignature,
        cb.getCurrentSrc(),
        cb.getPlaylistTracks().length,
        cb.getPlaylistCurrentIndex(),
        cb.isPreloadTracksEnabled() ? '1' : '0',
        cb.isKeyAnalysisEnabled() ? '1' : '0',
        preloadQueueSignature || '-',
        preloadKeyQueueSignature || '-',
        blockedReason || '-',
        keyBlockedReason || '-'
      ].join('|');
      if (idleSignature === preloadIdleSyncSignature) {
        return;
      }
      preloadIdleSyncSignature = idleSignature;
    } else {
      preloadIdleSyncSignature = '';
    }

    if (
      preloadBpmBatchSettledForSourceVersion
      && preloadKeyBatchSettledForSourceVersion
      && bpmPassIdle
      && keyPassIdle
    ) {
      const nextEpochTargets = buildNextPreloadBpmEpochTargets();
      const nextEpochSignature = buildPreloadEpochSig(nextEpochTargets);
      if (nextEpochTargets.length > 0 && nextEpochSignature !== preloadQueueSignature) {
        resetPreloadBpmEpoch();
        cancelPreloadKeyPass();
      } else {
        syncPreloadKeyQueue(expectedSourceVersion);
        refreshPlayerPreloadDebugSnapshot();
        return;
      }
    }

    // Once the BPM epoch is fully terminal, let the key pass finish without
    // repeatedly rebuilding the same empty runnable queue on every sync tick.
    if (
      bpmPassIdle
      && preloadBpmEpochTargets.length > 0
      && preloadBpmEpochTargets.every((target) => isPreloadBpmTargetTerminal(cb.resolvePreloadTargetKey(target)))
    ) {
      if (!preloadBpmBatchSettledForSourceVersion) {
        appendPreloadTrace('bpm-batch-settle', `sourceVersion=${expectedSourceVersion} reason=epoch-complete`);
      }
      preloadBpmBatchSettledForSourceVersion = true;
      syncPreloadKeyQueue(expectedSourceVersion);
      refreshPlayerPreloadDebugSnapshot();
      return;
    }

    if (preloadBpmEpochTargets.length === 0) {
      preloadBpmEpochTargets = buildNextPreloadBpmEpochTargets();
      preloadQueueSignature = buildPreloadEpochSig(preloadBpmEpochTargets);
      preloadRunnableQueueSignature = '';
      preloadKeyBatchSettledForSourceVersion = false;
      if (preloadBpmEpochTargets.length > 0) {
        if (!preloadBpmBatchOpenTs) { preloadBpmBatchOpenTs = Date.now(); }
        appendPreloadTrace('bpm-batch-open', `sourceVersion=${expectedSourceVersion} targets=${preloadBpmEpochTargets.length}`);
      }
    }

    const unresolvedTargets = filterDeferredPreloadTargets({
      targets: preloadBpmEpochTargets,
      resolvePreloadTargetKey: cb.resolvePreloadTargetKey,
      isTerminal: isPreloadBpmTargetTerminal,
      deferredRetryUntilByCacheKey: preloadDeferredRetryUntilByCacheKey
    });
    const { targets, stats } = filterPreloadTargets(
      unresolvedTargets,
      PRELOAD_MAX_ENQUEUED_TARGETS,
      cb.getPlaylistAnalysisCache()
    );
    const runnableSignature = buildPreloadTargetSignature(`${preloadQueueSignature}|run`, targets);
    const blocked = Boolean(blockedReason);
    const dormantSignature = buildDormantPreloadSyncSignature({
      blocked,
      targetsLength: targets.length,
      unresolvedTargetCount: unresolvedTargets.length,
      runnableSignature,
      previousRunnableSignature: preloadRunnableQueueSignature,
      contextParts: [
        expectedSourceVersion,
        ownerSignature,
        preloadQueueSignature || '-',
        runnableSignature || '-'
      ],
      stats
    });
    if (dormantSignature && dormantSignature === preloadDormantSyncSignature) {
      return;
    }
    preloadDormantSyncSignature = dormantSignature;
    appendPreloadTrace(
      'queue-build',
      `tracks=${cb.getPlaylistTracks().length} unresolved=${unresolvedTargets.length} epoch=${preloadBpmEpochTargets.length} current=${cb.getPlaylistCurrentIndex()}`
    );
    appendPreloadTrace(
      'queue-filter',
      `kept=${stats.kept} skipMissingKey=${stats.skipMissingKey} skipCached=${stats.skipCached} skipAnalyzing=${stats.skipAnalyzing} skipAttempts=${stats.skipAttempts} skipLimit=${stats.skipLimit}`
    );

    if (runnableSignature !== preloadRunnableQueueSignature) {
      preloadRunnableQueueSignature = runnableSignature;
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
    const bpmEpochSettled = preloadBpmEpochTargets.length === 0
      || preloadBpmEpochTargets.every((target) => isPreloadBpmTargetTerminal(cb.resolvePreloadTargetKey(target)));
    if (bpmEpochSettled) {
      if (!preloadBpmBatchSettledForSourceVersion) {
        appendPreloadTrace('bpm-batch-settle', `sourceVersion=${expectedSourceVersion} reason=epoch-complete`);
      }
      preloadBpmBatchSettledForSourceVersion = true;
    } else {
      preloadBpmBatchSettledForSourceVersion = false;
    }
    syncPreloadKeyQueue(expectedSourceVersion);
  };

  // ── Background phase integration ──

  const maybeStartCurrentSourceBackgroundPhase = (): void => {
    if (cb.isCurrentSourcePreloadPhaseReady()) {
      syncPreloadQueue(cb.getSourceVersion());
    }
    cb.maybeStartCurrentSourceDeepLikePhase();
  };

  // Initial debug snapshot
  refreshPlayerPreloadDebugSnapshot();

  return {
    preloader,
    syncPreloadQueue,
    cancelPreloadKeyPass,
    resetPreloadBpmBatchGate,
    resetPreloadFailureEpoch,
    clearPreloadKeyFailedCacheKeys: () => preloadKeyFailedCacheKeys.clear(),
    applyPlaylistAnalysisDecorations,
    refreshPlayerPreloadDebugSnapshot,
    maybeStartCurrentSourceBackgroundPhase,
    resetPreloadQueueSignature: () => { preloadQueueSignature = ''; },
    getPreloadDeferredRetryUntilByCacheKey: () => preloadDeferredRetryUntilByCacheKey,
    getPreloadKeyAnalyzingCacheKeys: () => preloadKeyAnalyzingCacheKeys
  };
}
