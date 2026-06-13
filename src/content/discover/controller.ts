/**
 * Discover orchestrator — runs on bandcamp.com/discover.
 *
 * Structure:
 *   1–125    Imports
 *   126–338  Pure helper functions
 *   339–500  State init, settings, likes/analysis cache setup
 *   500–850  Album & like identity resolution
 *   850–1160 Analysis readiness checks, BPM/key/waveform settle checks
 *   1160–1330 Preload startup, analysis kickoff, track navigation
 *   1330–1510 Panel setup, debug panel, render loop
 *   1510–1770 runPlaylistAttempt() — metadata → playlist pipeline
 *   1771–2018 syncFromDiscover() — track change detection and reset
 */
import {
  createDefaultLikesDebugSnapshot,
  DEFAULT_LIKE_VIEW_STATE,
  LIKES_DEEP_SYNC_POLL_INTERVAL_MS,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import { resolveRuntimePredecodePolicy } from '@/shared/runtime-predecode-policy';
import type {
  AnalysisResult,
  KeyAnalysisResult,
  LikeIdentity,
  LikeViewState,
  NonReleaseResolverSnapshot,
  PageGlobals,
  PanelInput,
  PlaylistState,
  PlaylistTrack,
  TrackMetadata,
  UiPerformanceDebug
} from '@/shared/types';
import {
  buildBpmDebugFields
} from '@/content/analysis/debug-helpers';
import {
  isBpmAnalysisInProgressForSource,
  resolveKeyStatusFromAnalysis
} from '@/content/analysis/current-session-helpers';
import { createAnalysisRequestController } from '@/content/analysis/analysis-request-controller';
import type { PreloadTarget } from '@/content/player/preloader';
import {
  createPlaylistAnalysisCache,
  createPlaylistAnalysisCacheFacade
} from '@/content/playlist/analysis-cache';
import {
  createDiscoverPreloadController,
  buildDiscoverPreloadQueue,
  DISCOVER_PRELOAD_AUDIT_INTERVAL_MS
} from '@/content/discover/preload-controller';
import { createDiscoverLikeController } from '@/content/discover/like-controller';
import { createDiscoverRuntimeAudioController } from '@/content/discover/runtime-audio-controller';
import type { RuntimeAudioController } from '@/content/player/runtime-audio/controller';
import { createRuntimeAudioEngine } from '@/content/player/runtime-audio/engine';
import { resolveRuntimePlaylistPreparationUiState } from '@/content/player/runtime-audio/playlist-prep-status';
import type {
  RuntimeAudioOwnershipDebugState,
  RuntimeAudioPlaybackState
} from '@/content/player/runtime-audio/types';
import { resolveWorkerCount, deriveConcurrencyConfig } from '@/shared/concurrency';
import { formatLikeIdentityDebug } from '@/content/player/like-controller';
import {
  ensureOriginBridge,
  getLatestObservedDiscoverAudioEnded,
  getRecentApiIdentityHints,
  getLatestPageGlobals,
  sendDiscoverAudioCommand,
  setDiscoverSelectionCallback,
  setDiscoverOriginTrackChangeCallback
} from '@/content/discover/origin-bridge';
import { createPlaybackHandoff } from '@/content/playback-handoff';
import {
  getDiscoverNowPlaying,
  watchDiscoverMetadata,
  type DiscoverNowPlaying
} from '@/content/discover/metadata';
import {
  getRootPlaylistProbeStatus,
  notifyTrackSwitch
} from '@/content/metadata/extractor';
import {
  getTrackFetchGateDebug,
  getValidCachedApiEntryForRequestUrl
} from '@/content/metadata/extractor/api/fetch';
import {
  getCachedApiTralbum,
  prewarmTralbumReleaseUrl
} from '@/content/metadata/extractor/api/probe';
import {
  getResolvedIdentityForTrack,
  upsertResolvedIdentityForTrack
} from '@/content/metadata/extractor/probe-state';
import {
  isBandcampReleaseUrl,
  normalizeReleaseUrl
} from '@/content/metadata/common';
import { tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import {
  normalizeUrl,
  readTrackIdFromUrl,
  resolveNonReleaseResolverSnapshot
} from '@/content/playlist/resolver';
import { findNextPlayableIndexWithoutWrap } from '@/content/playlist/track-navigation';
import {
  buildTrackCacheKey,
  findPlaylistTrackIndexBySource,
  normalizeCacheKey,
  playlistContainsSourceTrack,
  resolveSourceTrackCacheKey,
  sourcesShareTrackIdentity
} from '@/content/playlist/track-identity';
import { applyPlaylistSort, togglePlaylistSort } from '@/content/playlist/sorter';
import {
  createThrottledDebugPush,
  createDiscoverTransportDebugState,
  type DiscoverTransportDebugState
} from '@/content/debug/debugger';
import {
  buildHintDebug,
  buildInput,
  isMissingMetadataValue,
  shouldRunDiscoverScript
} from '@/content/discover/helpers';
import {
  applyTempoAdjust,
  buildTempoAdjustControlsUiState,
  createDefaultTempoAdjustControls,
  isTempoAdjustReady,
  resetTempoAdjustSession as resetSharedTempoAdjustSession,
  setTempoAdjustMasterTempo,
  setTempoAdjustOffset
} from '@/content/tempo/controls';
import { runDiscoverMetadataPhase } from '@/content/discover/metadata/phase';
import { buildDiscoverControllerDebugSections } from '@/content/discover/debug-assembly';
import type { DebugSection, DebugSectionsFactory } from '@/shared/debug-trace';
import { formatApiPolicyLine, formatApiShadowPolicyLine } from '@/content/metadata/api-policy';
import { recordTransportAction, recordTransportResult } from '@/content/discover/transport-log';
import { updateLikeDebugDocumentAttrs } from '@/content/debug/likes-debug-attrs';
import { appendKeyAnalysisTrace } from '@/content/debug/key-analysis-trace';
import { openBackgroundTab } from '@/content/open-background-tab';
import { createSettingsController } from '@/content/settings/settings-controller';
import {
  LikesStatusController,
  resolveReleaseLikeIdentityFromGlobals
} from '@/content/likes/inventory';
import { detectPageContext, shouldUseApiOnlyLikeIdentity } from '@/content/page-context';
import { pushLikeProcessEvent } from '@/content/likes/mutation-debug';
import {
  canonicalizeLikeIdentityPageUrl,
  evaluateTrackLikeIdentityTrust,
  isTrustedPlaylistLikeSource,
  normalizeLikeId,
  toCanonicalLikeUrl
} from '@/content/likes/state';
import { subscribeDebugClearCaches } from '@/shared/debug-cache-reset';
import { showResultsPanel } from '@/ui/panel';
import { createDebugPanel, type DebugPanelController } from '@/ui/debug-panel';
import {
  createResourceDiagnosticsController,
  type ResourceDiagnosticsController
} from '@/content/debug/resource-diagnostics';
import type { KeyboardShortcutAction } from '@/shared/keyboard-shortcuts';
import { clearMetadataRuntimeCaches } from '@/content/metadata/extractor/state';
import {
  isApiMetadataSource,
  hasDiscoverApiFastPathHints,
  readFetchGateReason,
  readFetchGateRetryDelayMs,
  buildDiscoverTrackKey,
  isDiscoverPlaylistUnresolved,
  withCurrentPlaylistIndex,
  isTrackPlayable,
  findDirectionalPlayableIndex,
  deriveSyntheticStreamUrl,
  resolveTrackCacheKey,
  mergeDiscoverPlaybackQuery
} from '@/content/discover/controller-helpers';

const DISCOVER_EMPTY_RECOVERY_INTERVAL_MS = 12_000;
const DISCOVER_MAX_ANALYSIS_ATTEMPTS_PER_TRACK = 4;
const DISCOVER_PROBE_API_REFRESH_INTERVAL_MS = 1800;
const DISCOVER_PROBE_API_REFRESH_FAST_INTERVAL_MS = 320;
const DISCOVER_API_INFLIGHT_BACKPRESSURE_MS = 560;
const DISCOVER_DEBUG_PANEL_TITLE = 'Debugger';
const DISCOVER_AUTO_ADVANCE_DEDUP_MS = 1500;

export function initDiscoverController(): void {
  if (!shouldRunDiscoverScript()) {
    return;
  }

  ensureOriginBridge();

  let prewarmDiscoverRelease: (releaseUrl: string, trigger: string) => void = () => {};

  setDiscoverSelectionCallback((url: string) => {
    // DISCOVER_SELECTION signals the user clicked a discover card. The native
    // player will start shortly; prewarm the selected release metadata while
    // DISCOVER_ORIGIN_TRACK_CHANGE waits for the actual audio handoff.
    prewarmDiscoverRelease(url, 'selection');
  });

  setDiscoverOriginTrackChangeCallback((newSrc: string) => {
    // Origin always wins: the native player started a new track (auto-advance
    // or user card click). Release runtime/detached ownership and re-sync to
    // the origin source.
    appendJumpTrace(
      'origin-track-change',
      `src=${String(newSrc || '').trim() || '-'} mode=${discoverPlaybackMode} playlistRun=${playlistRunId} runtimeSourceVersion=${runtimeSourceVersion}`
    );
    runtimePlaylistWarmToken += 1;
    runtimePlaylistWarmActive = false;
    runtimePlaylistWarmSignature = '';
    runtimePlaylistPrepareInFlight.clear();
    runtimeAudioEngine.clearPreparedTrack();
    discoverPlaybackMode = 'origin';
    runtimeAudioController?.releaseToOrigin();
    syncFromDiscover();
  });

  let extensionDeactivated = false;
  let nowPlaying = getDiscoverNowPlaying();
  let metadata = { ...DEFAULT_TRACK_METADATA };
  let analysis: AnalysisResult | null = null;
  const keyAnalysisTrace = [] as Array<{ ts: number; stage: string; detail: string }>;
  const jumpTrace = [] as Array<{ ts: number; stage: string; detail: string }>;
  const resolverTrace = [] as Array<{ ts: number; stage: string; detail: string }>;
  let playlistState: PlaylistState = { ...DEFAULT_PLAYLIST_STATE, tracks: [] };
  let playlistSource = 'none';
  let playlistAlbumReleaseUrl = '';
  let nonReleaseSnapshot: NonReleaseResolverSnapshot | null = null;
  let playlistRunId = 0;
  let analysisRunId = 0;
  let tempoRunId = 0;
  let runtimeSourceVersion = 0;
  let lastRuntimeSyncedSourceUrl = '';
  let pendingManualRuntimeSyncSourceUrl = '';
  let runtimePlaybackOwned = false;
  let runtimePlaylistSelectionPending = false;
  // Playhead seek hold (mirror of the player path in state-sync.ts): the
  // displayed playhead/clock hold at the committed seek target until the observed
  // position actually reaches it, then resume live tracking. This prevents the
  // new->old->new jump caused by a stale runtime STATE arriving before the engine
  // has finished seeking.
  let pendingSeekFraction: number | null = null;
  let pendingSeekAtMs = 0;
  const SEEK_SETTLE_WINDOW_MS = 30000;
  const SEEK_SETTLE_FRACTION_EPSILON = 0.035;
  let runtimeOwnershipDebug: RuntimeAudioOwnershipDebugState = {
    ownershipState: 'origin-started',
    firstOriginAvailable: true
  };
  let discoverPlaybackMode: 'origin' | 'detached' = 'origin';
  let lastRuntimePlaybackState: RuntimeAudioPlaybackState | null = null;
  let lastAutoAdvanceTrackKey = '';
  let lastAutoAdvanceAtMs = 0;
  let lastHandledDiscoverEndedAt = 0;
  const tempoAdjust = createDefaultTempoAdjustControls();
  let playlistPollId: number | null = null;
  let lastTrackKey = '';
  let lastEmptyRecoveryAt = 0;
  let hintDebug = '-';
  const uiPerformanceDebug: UiPerformanceDebug = {};
  // Forward-declared; assigned after preload controller is created.
  let preloadCtrl: ReturnType<typeof createDiscoverPreloadController>;
  const settings = createSettingsController({
    onPreloadTracksChanged() {
      if (!settings.preloadTracksEnabled) {
        preloadCtrl.preloader.cancel();
        preloadCtrl.resetDiscoverPreloadBpmEpoch();
        preloadCtrl.clearPreloadKeyFailedCacheKeys();
        preloadCtrl.resetDiscoverPreloadFailureEpoch();
        preloadCtrl.cancelDiscoverPreloadKeyPass();
      }
      preloadCtrl.syncDiscoverPreloadQueue();
      render();
    },
    onKeyAnalysisChanged(enabled) {
      if (!enabled) {
        playlistKeyAnalysisByCacheKey.clear();
        preloadCtrl.clearPreloadKeyFailedCacheKeys();
        preloadCtrl.resetDiscoverPreloadFailureEpoch();
        preloadCtrl.cancelDiscoverPreloadKeyPass();
        analysis = analysis ? { ...analysis, keyAnalysis: undefined, keyStatus: 'disabled', ts: Date.now() } : analysis;
      }
      analysisReqCtrl.cancelAll();
      analysisReqCtrl.resetRequestKeys();
      preloadCtrl.applyPlaylistAnalysisDecorations();
      preloadCtrl.syncDiscoverPreloadQueue();
      maybeStartNowPlayingAnalysis(`toggle:${Date.now()}`);
      render();
    },
    onAutoPlayChanged() {
      render();
    },
    onPerformanceModeChanged() {
      // Chrome-only opt-in. Discover now honors it at full parity with the player: the predecode
      // policy is resolved once at construction with this flag (see createRuntimeAudioEngine above),
      // so the new tier takes effect on the reload that the shared Performance-mode confirm dialog
      // triggers.
      render();
    },
    onKeyboardShortcutsChanged() {
      render();
    }
  });
  let lastDiscoverProbeApiRefreshAt = 0;
  let likeViewState: LikeViewState = { ...DEFAULT_LIKE_VIEW_STATE, trackStates: {} };
  let likeNoticeText = '';
  const discoverPageContext = detectPageContext({ pageGlobals: getLatestPageGlobals(60_000) });
  const likesDebug = createDefaultLikesDebugSnapshot('discover');
  likesDebug.context = discoverPageContext.mode;
  likesDebug.contextFamily = discoverPageContext.likeContextFamily;
  likesDebug.contextVariant = discoverPageContext.likeContextVariant;
  const likesController = new LikesStatusController(discoverPageContext.mode);
  const lastLikeDebugDetailByStage = new Map<string, string>();
  const pushDistinctLikeDebugEvent = (stage: string, detail: string): void => {
    const normalizedStage = String(stage || 'like-debug');
    const normalizedDetail = String(detail || '-');
    if (lastLikeDebugDetailByStage.get(normalizedStage) === normalizedDetail) {
      return;
    }
    lastLikeDebugDetailByStage.set(normalizedStage, normalizedDetail);
    pushLikeProcessEvent(likesDebug, normalizedStage, normalizedDetail);
  };
  let metadataDebugLastDecision = '-';
  let releasePrewarmDebug = 'status=idle trigger=- release=-';
  const releasePrewarmStartedByUrl = new Set<string>();
  const releasePrewarmInFlightByUrl = new Set<string>();
  const setReleasePrewarmDebug = (
    status: string,
    trigger: string,
    releaseUrl: string,
    detail = ''
  ): void => {
    releasePrewarmDebug =
      `status=${status} trigger=${trigger || '-'} release=${releaseUrl || '-'}${detail ? ` ${detail}` : ''}`;
  };
  prewarmDiscoverRelease = (releaseUrl: string, trigger: string): void => {
    const normalizedReleaseUrl = normalizeReleaseUrl(String(releaseUrl || '').trim());
    if (!normalizedReleaseUrl) {
      return;
    }
    if (!isBandcampReleaseUrl(normalizedReleaseUrl)) {
      setReleasePrewarmDebug('ignored-non-release', trigger, normalizedReleaseUrl);
      return;
    }
    if (getValidCachedApiEntryForRequestUrl(normalizedReleaseUrl)) {
      setReleasePrewarmDebug('cache-hit', trigger, normalizedReleaseUrl);
      return;
    }
    if (releasePrewarmInFlightByUrl.has(normalizedReleaseUrl)) {
      setReleasePrewarmDebug('in-flight', trigger, normalizedReleaseUrl);
      return;
    }
    if (releasePrewarmStartedByUrl.has(normalizedReleaseUrl)) {
      setReleasePrewarmDebug('already-started', trigger, normalizedReleaseUrl);
      return;
    }

    const request = prewarmTralbumReleaseUrl(normalizedReleaseUrl);
    if (!request) {
      setReleasePrewarmDebug('gated', trigger, normalizedReleaseUrl);
      return;
    }

    const startedAt = Date.now();
    releasePrewarmStartedByUrl.add(normalizedReleaseUrl);
    releasePrewarmInFlightByUrl.add(normalizedReleaseUrl);
    setReleasePrewarmDebug('request-start', trigger, normalizedReleaseUrl);
    void request
      .then((result) => {
        setReleasePrewarmDebug(
          result.tralbum ? 'ready' : 'empty',
          trigger,
          normalizedReleaseUrl,
          `retryable=${result.retryable ? 1 : 0} elapsedMs=${Date.now() - startedAt}`
        );
      })
      .finally(() => {
        releasePrewarmInFlightByUrl.delete(normalizedReleaseUrl);
      });
  };
  const playlistAnalysisCache = createPlaylistAnalysisCache({
    maxAttempts: DISCOVER_MAX_ANALYSIS_ATTEMPTS_PER_TRACK,
    normalizeKey: normalizeCacheKey
  });
  const playlistBpmByCacheKey = playlistAnalysisCache.bpmByCacheKey;
  const playlistConfidenceByCacheKey = new Map<string, number>();
  const playlistWaveformByCacheKey = playlistAnalysisCache.waveformByCacheKey;
  const playlistKeyAnalysisByCacheKey = playlistAnalysisCache.keyAnalysisByCacheKey;
  const playlistFailedCacheKeys = playlistAnalysisCache.failedCacheKeys;
  const playlistAttemptCountByCacheKey = playlistAnalysisCache.attemptCountByCacheKey;
  const playlistAnalyzingCacheKeys = playlistAnalysisCache.analyzingCacheKeys;
  const playlistAnalysisFacade = createPlaylistAnalysisCacheFacade(playlistAnalysisCache, normalizeCacheKey);
  const {
    resolvePreloadTargetKey,
    setTrackAnalyzing,
    registerAnalysisAttempt,
    canAttemptAnalysis,
    hasCachedBpm: hasCachedPlaylistBpm,
    setCachedBpm: setCachedPlaylistBpm,
    clearTrackAnalyzing
  } = playlistAnalysisFacade;
  const concurrency = deriveConcurrencyConfig(resolveWorkerCount());
  preloadCtrl = createDiscoverPreloadController({
    getPlaylistRunId: () => playlistRunId,
    getNowPlayingStreamUrl: () => String(nowPlaying.streamUrl || '').trim(),
    getPlaylistTracks: () => playlistState.tracks,
    getPlaylistCurrentIndex: () => playlistState.currentIndex,
    isPreloadTracksEnabled: () => settings.preloadTracksEnabled,
    isKeyAnalysisEnabled: () => settings.keyAnalysisEnabled,
    resolvePreloadStartupBlockReason: () => resolveDiscoverPreloadStartupBlockReason(),
    resolvePreloadTargetKey,
    hasCachedBpm: (cacheKey) => hasCachedPlaylistBpm(cacheKey),
    setCachedBpm: (cacheKey, bpm) => setCachedPlaylistBpm(cacheKey, bpm),
    canAttemptAnalysis: (cacheKey) => canAttemptAnalysis(cacheKey),
    registerAnalysisAttempt: (cacheKey) => registerAnalysisAttempt(cacheKey),
    setPlaylistTrackAnalyzing: (cacheKey, analyzing) => setTrackAnalyzing(cacheKey, analyzing),
    clearPlaylistTrackAnalyzing: () => clearTrackAnalyzing(),
    getPlaylistBpmByCacheKey: () => playlistBpmByCacheKey,
    getPlaylistKeyAnalysisByCacheKey: () => playlistKeyAnalysisByCacheKey,
    getPlaylistWaveformByCacheKey: () => playlistWaveformByCacheKey,
    getPlaylistAnalyzingCacheKeys: () => playlistAnalyzingCacheKeys,
    getPlaylistFailedCacheKeys: () => playlistFailedCacheKeys,
    getPlaylistAttemptCountByCacheKey: () => playlistAttemptCountByCacheKey,
    getPlaylistConfidenceByCacheKey: () => playlistConfidenceByCacheKey,
    getPlaylistAnalysisCache: () => playlistAnalysisCache,
    render: () => render(),
    setPlaylistState: (ps) => { playlistState = ps; },
    getPlaylistState: () => playlistState,
    getSettings: () => ({
      preloadTracksEnabled: settings.preloadTracksEnabled,
      keyAnalysisEnabled: settings.keyAnalysisEnabled,
      preloadSortKey: playlistState.sortKey || ''
    }),
    getAnalysis: () => analysis,
    getMaxAnalysisAttempts: () => DISCOVER_MAX_ANALYSIS_ATTEMPTS_PER_TRACK
  }, {
    maxConcurrentPreloads: concurrency.maxConcurrentPreloads,
    maxConcurrentKeyAnalyses: concurrency.maxConcurrentKeyAnalyses
  });
  // Forward-declared; assigned after all callback dependencies are defined.
  let analysisReqCtrl: ReturnType<typeof createAnalysisRequestController>;
  const transportDebug: DiscoverTransportDebugState = createDiscoverTransportDebugState();
  let handlePlaybackShortcutCommand: (action: KeyboardShortcutAction) => void = () => {};
  const appendJumpTrace = (stage: string, detail: string): void => {
    jumpTrace.push({ ts: Date.now(), stage, detail });
    if (jumpTrace.length > 80) {
      jumpTrace.splice(0, jumpTrace.length - 80);
    }
  };
  const playbackHandoff = createPlaybackHandoff({
    context: 'discover',
    onPauseRequested: () => {
      runtimeAudioController?.pause();
      sendDiscoverAudioCommand('pause');
    },
    onShortcutCommand: (action) => {
      handlePlaybackShortcutCommand(action);
    }
  });

  // Runtime audio engine and controller for Signalsmith stretching. Resolve the predecode policy
  // ONCE (single source of truth, matching the player) and inject it into the engine, so the engine
  // and this controller's window/worker math (windowTracks, maxConcurrentPredecode) agree. Discover
  // is at full parity with the player, including the Chrome-only Performance opt-in; the build-time
  // __BUILD_TARGET__ guard means Firefox dead-code-eliminates the flag and can never raise the tier.
  const runtimePredecodePolicy = resolveRuntimePredecodePolicy({
    performanceMode: __BUILD_TARGET__ === 'chrome' && settings.performanceModeEnabled
  });
  const runtimeAudioEngine = createRuntimeAudioEngine({
    storeDecodedBuffer: true,
    predecodePolicy: runtimePredecodePolicy
  });
  let runtimeAudioController: RuntimeAudioController | null = null;
  let runtimePlaylistWarmToken = 0;
  let runtimePlaylistWarmActive = false;
  let runtimePlaylistWarmSignature = '';
  const runtimePlaylistPrepareInFlight = new Set<string>();
  const albumIdByReleaseUrl = new Map<string, string>();
  const albumBandIdByReleaseUrl = new Map<string, string>();
  let lockedAlbumLikeIdentity: LikeIdentity | null = null;
  let lockedAlbumLikeIdentityPlaylistKey = '';
  // Discover can report the current item as /track/..., but only /album/...
  // identifies the multi-track playlist that owns preloaded BPM decorations.
  const normalizePlaylistAlbumReleaseUrl = (releaseUrlRaw: string): string => {
    const releaseUrl = normalizeReleaseUrl(String(releaseUrlRaw || '').trim());
    if (!releaseUrl) {
      return '';
    }
    try {
      const pathname = new URL(releaseUrl, window.location.href).pathname.toLowerCase();
      return pathname.startsWith('/album/') ? releaseUrl : '';
    } catch {
      return '';
    }
  };
  const normalizeCacheableAlbumReleaseUrl = (releaseUrlRaw: string): string => {
    const releaseUrl = toCanonicalLikeUrl(String(releaseUrlRaw || ''));
    if (!releaseUrl) {
      return '';
    }
    try {
      const pathname = new URL(releaseUrl).pathname.toLowerCase();
      if (pathname === '/discover' || pathname.startsWith('/discover/')) {
        return '';
      }
    } catch {
      return '';
    }
    return releaseUrl;
  };

  const normalizeAlbumLikeIdentity = (identity: LikeIdentity | null | undefined): LikeIdentity | null => {
    if (!identity || identity.itemType !== 'album') {
      return null;
    }
    const itemId = normalizeLikeId(identity.itemId || '');
    const bandId = normalizeLikeId(identity.bandId || '') || undefined;
    const pageUrl = String(identity.pageUrl || '').trim();
    if (!itemId && !pageUrl) {
      return null;
    }
    return {
      itemId,
      itemType: 'album',
      bandId,
      pageUrl
    };
  };

  const buildPlaylistAlbumIdentityLockKey = (): string => {
    if (!playlistState.tracks.length) {
      return '';
    }
    return playlistState.tracks
      .map((track, index) =>
        normalizeLikeId(track.trackId || readTrackIdFromUrl(track.streamUrl || '') || '') ||
        resolveTrackCacheKey(track) ||
        `idx:${index}`
      )
      .filter(Boolean)
      .join('|');
  };

  const isCurrentTrackRepresentedInPlaylist = (): boolean => {
    const currentTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );
    if (!currentTrackId) {
      return false;
    }
    return playlistState.tracks.some((track) => {
      const trackId = normalizeLikeId(track.trackId || readTrackIdFromUrl(track.streamUrl || '') || '');
      return Boolean(trackId && trackId === currentTrackId);
    });
  };

  const resolveReusableLockedAlbumLikeIdentity = (): LikeIdentity | null => {
    const playlistKey = buildPlaylistAlbumIdentityLockKey();
    if (!playlistKey) {
      lockedAlbumLikeIdentity = null;
      lockedAlbumLikeIdentityPlaylistKey = '';
      return null;
    }
    if (lockedAlbumLikeIdentityPlaylistKey && lockedAlbumLikeIdentityPlaylistKey !== playlistKey) {
      lockedAlbumLikeIdentity = null;
    }
    lockedAlbumLikeIdentityPlaylistKey = playlistKey;
    if (!isCurrentTrackRepresentedInPlaylist()) {
      return null;
    }
    return normalizeAlbumLikeIdentity(lockedAlbumLikeIdentity);
  };

  const updateLockedAlbumLikeIdentity = (identity: LikeIdentity | null | undefined): LikeIdentity | null => {
    const normalized = normalizeAlbumLikeIdentity(identity);
    const playlistKey = buildPlaylistAlbumIdentityLockKey();
    if (!playlistKey) {
      lockedAlbumLikeIdentity = null;
      lockedAlbumLikeIdentityPlaylistKey = '';
      return normalized;
    }
    lockedAlbumLikeIdentityPlaylistKey = playlistKey;
    if (!normalized || !normalizeLikeId(normalized.itemId || '')) {
      return normalized;
    }
    lockedAlbumLikeIdentity = normalized;
    return normalized;
  };

  const readCachedAlbumIdForRelease = (releaseUrlRaw: string): string => {
    const releaseUrl = normalizeCacheableAlbumReleaseUrl(releaseUrlRaw);
    if (!releaseUrl) {
      return '';
    }
    return normalizeLikeId(albumIdByReleaseUrl.get(releaseUrl) || '');
  };

  const readSnapshotAlbumIdentity = (): { itemId: string; bandId: string } => {
    const snapshot = nonReleaseSnapshot;
    if (!snapshot) {
      return { itemId: '', bandId: '' };
    }
    if (
      snapshot.source.identitySource === 'none' ||
      snapshot.source.staleTrack ||
      !snapshot.flags.strictPlaylistBinding
    ) {
      return { itemId: '', bandId: '' };
    }
    const snapshotSrc = normalizeUrl(String(snapshot.currentSrc || '').trim());
    const nowPlayingSrc = normalizeUrl(String(nowPlaying.streamUrl || '').trim());
    if (snapshotSrc && nowPlayingSrc && snapshotSrc !== nowPlayingSrc) {
      return { itemId: '', bandId: '' };
    }
    const nowPlayingTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );
    const sourceTrackId = normalizeLikeId(snapshot.activeTrack.sourceTrackId || '');
    const matchedTrackId = normalizeLikeId(snapshot.activeTrack.matchedTrackId || '');
    if (nowPlayingTrackId) {
      if (!sourceTrackId || sourceTrackId !== nowPlayingTrackId) {
        return { itemId: '', bandId: '' };
      }
      if (matchedTrackId && matchedTrackId !== nowPlayingTrackId) {
        return { itemId: '', bandId: '' };
      }
    }

    const tralbumRaw = snapshot.tralbum;
    if (!tralbumRaw || typeof tralbumRaw !== 'object') {
      return { itemId: '', bandId: '' };
    }
    const tralbum = tralbumRaw as Record<string, unknown>;
    const current = tralbum.current && typeof tralbum.current === 'object'
      ? (tralbum.current as Record<string, unknown>)
      : null;
    const firstTrack =
      Array.isArray(tralbum.trackinfo) && tralbum.trackinfo.length > 0 && typeof tralbum.trackinfo[0] === 'object'
        ? (tralbum.trackinfo[0] as Record<string, unknown>)
        : null;
    const itemCandidates = [
      tralbum.id,
      tralbum.tralbum_id,
      tralbum.item_id,
      tralbum.album_id,
      tralbum.collect_item_id,
      current?.id,
      current?.tralbum_id,
      current?.item_id,
      current?.album_id,
      firstTrack?.album_id
    ];
    let itemId = '';
    for (const candidate of itemCandidates) {
      const normalized = normalizeLikeId(candidate ?? '');
      if (normalized) {
        itemId = normalized;
        break;
      }
    }

    const bandCandidates = [
      tralbum.band_id,
      tralbum.selling_band_id,
      tralbum.collect_band_id,
      tralbum.account_id,
      current?.band_id,
      current?.selling_band_id
    ];
    let bandId = '';
    for (const candidate of bandCandidates) {
      const normalized = normalizeLikeId(candidate ?? '');
      if (normalized) {
        bandId = normalized;
        break;
      }
    }

    return { itemId, bandId };
  };

  const cacheAlbumIdForRelease = (releaseUrlRaw: string, albumIdRaw: string): void => {
    const releaseUrl = normalizeCacheableAlbumReleaseUrl(releaseUrlRaw);
    const albumId = normalizeLikeId(albumIdRaw || '');
    if (!releaseUrl || !albumId) {
      return;
    }
    albumIdByReleaseUrl.set(releaseUrl, albumId);
  };

  const readCachedAlbumBandIdForRelease = (releaseUrlRaw: string): string => {
    const releaseUrl = normalizeCacheableAlbumReleaseUrl(releaseUrlRaw);
    if (!releaseUrl) {
      return '';
    }
    return normalizeLikeId(albumBandIdByReleaseUrl.get(releaseUrl) || '');
  };

  const cacheAlbumBandIdForRelease = (releaseUrlRaw: string, albumBandIdRaw: string): void => {
    const releaseUrl = normalizeCacheableAlbumReleaseUrl(releaseUrlRaw);
    const albumBandId = normalizeLikeId(albumBandIdRaw || '');
    if (!releaseUrl || !albumBandId) {
      return;
    }
    albumBandIdByReleaseUrl.set(releaseUrl, albumBandId);
  };

  const readHintAlbumIdentity = (): { itemId: string; bandId: string } => {
    const hints = getRecentApiIdentityHints(5 * 60 * 1000);
    if (!hints.length) {
      return { itemId: '', bandId: '' };
    }
    const wantedTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );
    const wantedReleaseUrl = toCanonicalLikeUrl(String(nowPlaying.releaseUrl || ''));
    if (!wantedTrackId && !wantedReleaseUrl) {
      return { itemId: '', bandId: '' };
    }
    let bestScore = -1;
    let best: { itemId: string; bandId: string } = { itemId: '', bandId: '' };
    hints.forEach((hint) => {
      const hintType = hint.tralbumType === 'a' ? 'a' : hint.tralbumType === 't' ? 't' : '';
      if (hintType !== 'a') {
        return;
      }
      const itemId = normalizeLikeId(hint.tralbumId || '');
      const bandId = normalizeLikeId(hint.bandId || '');
      if (!itemId) {
        return;
      }
      const hintTrackId = normalizeLikeId(hint.trackId || '');
      const hintReleaseUrl = toCanonicalLikeUrl(String(hint.url || ''));
      const trackMatch = Boolean(wantedTrackId && hintTrackId && hintTrackId === wantedTrackId);
      const releaseMatch = Boolean(wantedReleaseUrl && hintReleaseUrl && hintReleaseUrl === wantedReleaseUrl);
      if (!trackMatch && !releaseMatch) {
        return;
      }
      let score = 0;
      if (trackMatch) {
        score += 8;
      }
      if (releaseMatch) {
        score += 6;
      }
      if (bandId) {
        score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { itemId, bandId };
      }
    });
    return best;
  };

  const buildAlbumLikeIdentityForRelease = (
    releaseUrlRaw: string,
    itemIdRaw: string,
    bandIdRaw: string
  ): LikeIdentity | null => {
    const itemId = normalizeLikeId(itemIdRaw || '');
    if (!itemId) {
      return null;
    }
    const releaseUrl = String(releaseUrlRaw || '').trim();
    cacheAlbumIdForRelease(releaseUrl, itemId);
    cacheAlbumBandIdForRelease(releaseUrl, bandIdRaw);
    return {
      itemId,
      itemType: 'album',
      bandId: normalizeLikeId(bandIdRaw || '') || undefined,
      pageUrl: releaseUrl
    };
  };

  const resolveAlbumIdentityFromResolvedTrack = (trackIdRaw: string, releaseUrlRaw: string): LikeIdentity | null => {
    const trackId = normalizeLikeId(trackIdRaw || '');
    if (!trackId) {
      return null;
    }
    const resolvedIdentity = getResolvedIdentityForTrack(trackId);
    if (resolvedIdentity?.tralbumType !== 'a') {
      return null;
    }
    return buildAlbumLikeIdentityForRelease(
      releaseUrlRaw,
      String(resolvedIdentity.tralbumId || ''),
      String(resolvedIdentity.bandId || '')
    );
  };

  const resolveApiOnlyAlbumLikeIdentity = (): LikeIdentity | null => {
    const releaseLikeUrl = String(nowPlaying.releaseUrl || '').trim();
    const cachedAlbumId = readCachedAlbumIdForRelease(releaseLikeUrl);
    if (cachedAlbumId) {
      const cachedBandId = readCachedAlbumBandIdForRelease(releaseLikeUrl);
      return {
        itemId: cachedAlbumId,
        itemType: 'album',
        bandId: cachedBandId || undefined,
        pageUrl: releaseLikeUrl
      };
    }

    const currentTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );

    const nowPlayingIdentity = nowPlaying.identity;
    const nowPlayingIdentityTrackId = normalizeLikeId(nowPlayingIdentity?.trackId || '');
    if (
      nowPlayingIdentity?.tralbumType === 'a' &&
      (!currentTrackId || !nowPlayingIdentityTrackId || nowPlayingIdentityTrackId === currentTrackId)
    ) {
      const fromNowPlaying = buildAlbumLikeIdentityForRelease(
        releaseLikeUrl,
        String(nowPlayingIdentity.tralbumId || ''),
        String(nowPlayingIdentity.bandId || '')
      );
      if (fromNowPlaying) {
        return fromNowPlaying;
      }
    }

    const fromResolvedTrack = resolveAlbumIdentityFromResolvedTrack(currentTrackId, releaseLikeUrl);
    if (fromResolvedTrack) {
      return fromResolvedTrack;
    }

    const snapshotAlbumIdentity = readSnapshotAlbumIdentity();
    const fromSnapshot = buildAlbumLikeIdentityForRelease(
      releaseLikeUrl,
      snapshotAlbumIdentity.itemId,
      snapshotAlbumIdentity.bandId
    );
    if (fromSnapshot) {
      return fromSnapshot;
    }

    const hintedAlbumIdentity = readHintAlbumIdentity();
    const fromHint = buildAlbumLikeIdentityForRelease(
      releaseLikeUrl,
      hintedAlbumIdentity.itemId,
      hintedAlbumIdentity.bandId
    );
    if (fromHint) {
      return fromHint;
    }

    return null;
  };

  const resolveAlbumLikeIdentity = (
    apiOnlyLikeIdentity = false,
    globalsInput: PageGlobals | null | undefined = undefined
  ): LikeIdentity | null => {
    const lockedIdentity = resolveReusableLockedAlbumLikeIdentity();
    if (apiOnlyLikeIdentity) {
      return updateLockedAlbumLikeIdentity(resolveApiOnlyAlbumLikeIdentity()) || lockedIdentity;
    }

    const globals = globalsInput ?? getLatestPageGlobals(15_000);
    const releaseLikeUrl = String(nowPlaying.releaseUrl || window.location.href);
    const resolveStrictFallback = (): LikeIdentity | null => {
      const strict = likesController.resolveStrictAlbumIdentityForUrl(releaseLikeUrl, playlistState.tracks);
      if (strict?.itemType === 'album') {
        cacheAlbumIdForRelease(releaseLikeUrl, String(strict.itemId || ''));
        cacheAlbumBandIdForRelease(releaseLikeUrl, String(strict.bandId || ''));
      }
      return strict;
    };

    const currentTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );
    const cachedAlbumId = readCachedAlbumIdForRelease(releaseLikeUrl);
    if (cachedAlbumId) {
      const cachedBandId = readCachedAlbumBandIdForRelease(releaseLikeUrl);
      return updateLockedAlbumLikeIdentity({
        itemId: cachedAlbumId,
        itemType: 'album',
        bandId: cachedBandId || undefined,
        pageUrl: releaseLikeUrl
      });
    }
    const fromGlobals = resolveReleaseLikeIdentityFromGlobals(globals, releaseLikeUrl);
    if (fromGlobals?.itemType === 'album') {
      cacheAlbumIdForRelease(releaseLikeUrl, String(fromGlobals.itemId || ''));
      cacheAlbumBandIdForRelease(releaseLikeUrl, String(fromGlobals.bandId || ''));
      return updateLockedAlbumLikeIdentity(fromGlobals);
    }
    const nowPlayingIdentity = nowPlaying.identity;
    if (nowPlayingIdentity?.tralbumType === 'a') {
      const fromNowPlaying = buildAlbumLikeIdentityForRelease(
        releaseLikeUrl,
        String(nowPlayingIdentity.tralbumId || ''),
        String(nowPlayingIdentity.bandId || '')
      );
      if (fromNowPlaying) {
        return updateLockedAlbumLikeIdentity(fromNowPlaying);
      }
    }
    const fromResolvedTrackFallback = resolveAlbumIdentityFromResolvedTrack(currentTrackId, releaseLikeUrl);
    if (fromResolvedTrackFallback) {
      return updateLockedAlbumLikeIdentity(fromResolvedTrackFallback);
    }
    const snapshotAlbumIdentity = readSnapshotAlbumIdentity();
    const fromSnapshotFallback = buildAlbumLikeIdentityForRelease(
      releaseLikeUrl,
      snapshotAlbumIdentity.itemId,
      snapshotAlbumIdentity.bandId
    );
    if (fromSnapshotFallback) {
      return updateLockedAlbumLikeIdentity(fromSnapshotFallback);
    }
    const hintedAlbumIdentity = readHintAlbumIdentity();
    const fromHintFallback = buildAlbumLikeIdentityForRelease(
      releaseLikeUrl,
      hintedAlbumIdentity.itemId,
      hintedAlbumIdentity.bandId
    );
    if (fromHintFallback) {
      return updateLockedAlbumLikeIdentity(fromHintFallback);
    }
    const resolved =
      resolveStrictFallback() ||
      (toCanonicalLikeUrl(releaseLikeUrl).includes('/album/')
        ? { itemId: '', itemType: 'album', pageUrl: releaseLikeUrl }
        : null);
    return updateLockedAlbumLikeIdentity(resolved) || lockedIdentity;
  };

  const resolveApiOnlyLikeIdentityMode = (
    globalsInput: PageGlobals | null | undefined = undefined
  ): boolean => {
    const globals = globalsInput ?? getLatestPageGlobals(15_000);
    return shouldUseApiOnlyLikeIdentity(detectPageContext({ pageGlobals: globals }));
  };

  const resolveTrackLikeIdentity = (index = playlistState.currentIndex): LikeIdentity | null => {
    const track = playlistState.tracks[index] || null;
    if (!track) {
      return null;
    }
    const fallbackTrack = playlistState.tracks[playlistState.currentIndex] || null;
    const trackId = normalizeLikeId(track.trackId || fallbackTrack?.trackId || nowPlaying.trackId || nowPlaying.identity?.trackId || '');
    if (!trackId) {
      return null;
    }
    const resolvedTrackIdentity = getResolvedIdentityForTrack(trackId);
    const apiOnlyLikeIdentity = resolveApiOnlyLikeIdentityMode();
    const albumIdentity = resolveAlbumLikeIdentity(apiOnlyLikeIdentity);
    const nowPlayingTrackId = normalizeLikeId(
      nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || nowPlaying.identity?.trackId || ''
    );
    const bandId = normalizeLikeId(
      resolvedTrackIdentity?.bandId ||
      (nowPlayingTrackId && nowPlayingTrackId === trackId ? nowPlaying.identity?.bandId : '') ||
      albumIdentity?.bandId ||
      ''
    );
    return {
      itemId: trackId,
      itemType: 'track',
      bandId: bandId || undefined,
      pageUrl: canonicalizeLikeIdentityPageUrl(
        'track',
        String(track.pageUrl || nowPlaying.releaseUrl || '')
      )
    };
  };
  const resolveFocusedTrackLikeIdentities = (): LikeIdentity[] => {
    const identities = new Map<string, LikeIdentity>();
    playlistState.tracks.forEach((_, index) => {
      const identity = resolveTrackLikeIdentity(index);
      const itemId = normalizeLikeId(identity?.itemId || '');
      if (!identity || !itemId || identities.has(itemId)) {
        return;
      }
      identities.set(itemId, identity);
    });
    return Array.from(identities.values());
  };

  const refreshLikeSnapshot = (): void => {
    const globals = getLatestPageGlobals(15_000);
    const activeTrack = playlistState.tracks[playlistState.currentIndex] || null;
    const preferredAlbumUrl = String(nowPlaying.releaseUrl || activeTrack?.pageUrl || window.location.href || '').trim();
    const strictResolverTrackBinding = Boolean(
      isTrustedPlaylistLikeSource(playlistSource) ||
      (
        nonReleaseSnapshot &&
        nonReleaseSnapshot.flags.strictPlaylistBinding &&
        nonReleaseSnapshot.source.identitySource !== 'none'
      )
    );
    const apiOnlyLikeIdentity = resolveApiOnlyLikeIdentityMode(globals);
    const albumIdentity = resolveAlbumLikeIdentity(apiOnlyLikeIdentity, globals);
    const resolved = likesController.resolveViewState(
      albumIdentity,
      playlistState.tracks,
      !likeCtrl.LIKE_WRITES_ENABLED || Boolean(likeCtrl.likeMutationController.isUiLocked()),
      playlistSource,
      strictResolverTrackBinding,
      preferredAlbumUrl
    );
    likeViewState = resolved.likeState;
    if (resolved.playlistTracks !== playlistState.tracks) {
      const previousTracks = playlistState.tracks;
      const previousByKey = new Map<string, PlaylistTrack>();
      previousTracks.forEach((track, index) => {
        const key = resolveTrackCacheKey(track) || String(track.trackId || '') || `idx:${index}`;
        if (!previousByKey.has(key)) {
          previousByKey.set(key, track);
        }
      });
      const mergedTracks = resolved.playlistTracks.map((track, index) => {
        const key = resolveTrackCacheKey(track) || String(track.trackId || '') || `idx:${index}`;
        const previous = previousByKey.get(key);
        if (!previous) {
          return track;
        }
        return {
          ...track,
          bpm: Number.isFinite(previous.bpm) ? Number(previous.bpm) : track.bpm,
          isAnalyzing: previous.isAnalyzing ?? track.isAnalyzing,
          analysisFailed: previous.analysisFailed ?? track.analysisFailed,
          key1: previous.key1 ?? track.key1,
          key2: previous.key2 ?? track.key2,
          key1Level: previous.key1Level ?? track.key1Level,
          key2Level: previous.key2Level ?? track.key2Level,
          key1Loading: previous.key1Loading ?? track.key1Loading,
          key2Loading: previous.key2Loading ?? track.key2Loading
        };
      });
      playlistState = {
        ...playlistState,
        tracks: mergedTracks
      };
    }
    likesController.applyDebug(likesDebug);
    const activeTrackIdentity = resolveTrackLikeIdentity(playlistState.currentIndex);
    const albumInventoryState = likesController.readInventoryLikeState(albumIdentity);
    const activeTrackInventoryState = likesController.readInventoryLikeState(activeTrackIdentity);
    const activeTrackViewState = likeViewState.trackStates[playlistState.currentIndex] || 'unknown';
    const inheritedLikedSurface =
      likeViewState.albumState === 'liked' &&
      albumInventoryState === 'liked' &&
      activeTrackViewState === 'liked';
    const inheritedBoughtSurface =
      likeViewState.albumState === 'bought' &&
      albumInventoryState === 'bought' &&
      activeTrackViewState === 'bought';
    const albumMismatch = albumInventoryState !== 'unknown' && albumInventoryState !== likeViewState.albumState;
    const trackMismatch =
      activeTrackInventoryState !== 'unknown' &&
      activeTrackInventoryState !== activeTrackViewState &&
      !inheritedLikedSurface &&
      !inheritedBoughtSurface;
    const mismatchCode = [
      albumMismatch ? 'album' : '',
      trackMismatch ? 'track' : ''
    ]
      .filter(Boolean)
      .join('+') || 'none';
    const trackProjection =
      inheritedBoughtSurface ? 'album-bought'
        : inheritedLikedSurface ? 'album-liked'
          : '-';
    likesDebug.truthAlbumState = albumInventoryState;
    likesDebug.truthActiveTrackState = activeTrackInventoryState === 'unknown' ? 'n/a' : activeTrackInventoryState;
    likesDebug.displayAlbumState = likeViewState.albumState;
    likesDebug.displayActiveTrackState = activeTrackViewState;
    likesDebug.trackProjection = trackProjection;
    pushDistinctLikeDebugEvent(
      'view.inventory.truth',
      [
        `album=${formatLikeIdentityDebug(albumIdentity)}`,
        `albumInventory=${albumInventoryState}`,
        `track=${formatLikeIdentityDebug(activeTrackIdentity)}`,
        `trackInventory=${activeTrackInventoryState}`,
        `viewAlbum=${likeViewState.albumState}`,
        `viewTrack=${activeTrackViewState}`,
        `projection=${trackProjection}`,
        `mismatch=${mismatchCode}`
      ].join(' ')
    );
    const activeTrackAfterResolve = playlistState.tracks[playlistState.currentIndex] || null;
    const trackIdentityTrust = evaluateTrackLikeIdentityTrust(activeTrackAfterResolve, playlistSource);
    const strictTrackIdentityReady = strictResolverTrackBinding && trackIdentityTrust.ready;
    const strictAlbumIdentityReady = Boolean(
      albumIdentity &&
      albumIdentity.itemType === 'album' &&
      normalizeLikeId(albumIdentity.itemId || '')
    );
    likesDebug.identityTrust = `album=${strictAlbumIdentityReady ? 'strict' : 'unknown'}, track=${strictTrackIdentityReady ? 'strict' : 'blocked'}`;
    const trackReason = strictResolverTrackBinding
      ? trackIdentityTrust.reason
      : `resolver=unbound; ${trackIdentityTrust.reason}`;
    likesDebug.identityReason = `album=${strictAlbumIdentityReady ? 'resolved' : 'missing-item-id'}; ${trackReason}`;
  };

  const likeCtrl = createDiscoverLikeController({
    getPlaylistState: () => playlistState,
    getPlaylistSource: () => playlistSource,
    getNowPlayingStreamUrl: () => String(nowPlaying.streamUrl || '').trim(),
    getLikeViewState: () => likeViewState,
    setLikeViewState: (view) => { likeViewState = view; },
    getLikeNoticeText: () => likeNoticeText,
    setLikeNoticeText: (text) => { likeNoticeText = text; },
    resolveAlbumLikeIdentity: (apiOnly, globals) => resolveAlbumLikeIdentity(apiOnly, globals),
    resolveApiOnlyLikeIdentityMode: (globals) => resolveApiOnlyLikeIdentityMode(globals),
    resolveTrackLikeIdentity: (index) => resolveTrackLikeIdentity(index),
    resolveFocusedTrackLikeIdentities: () => resolveFocusedTrackLikeIdentities(),
    isPlaylistSourceValid: () => playlistContainsSourceTrack(playlistState.tracks, nowPlaying.streamUrl, {
      normalizeUrlForCompare: normalizeUrl
    }),
    getLikesController: () => likesController,
    render: () => render(),
    refreshLikeSnapshot: () => refreshLikeSnapshot()
  }, likesDebug);
  let render: () => void = () => {};
  const appendResolverTrace = (stage: string, detail: string): void => {
    resolverTrace.push({ ts: Date.now(), stage, detail });
    if (resolverTrace.length > 120) {
      resolverTrace.splice(0, resolverTrace.length - 120);
    }
  };

  const clearAllTrackAnalyzing = (): void => {
    if (!playlistAnalyzingCacheKeys.size && !analysisReqCtrl.getActiveTempoTrackCacheKey()) {
      return;
    }
    clearTrackAnalyzing();
    analysisReqCtrl.setActiveTempoTrackCacheKey('');
  };

  const seedAnalysisFromSelectedDiscoverTrack = (
    track: PlaylistTrack | null,
    sourceUrl: string,
    reason = 'unknown'
  ): void => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!track || !normalizedSource) {
      appendKeyAnalysisTrace(keyAnalysisTrace, 'ui-seed-clear', `reason=${reason} source=${normalizedSource || '-'}`);
      analysis = null;
      return;
    }

    const cacheKey = resolveTrackCacheKey(track);
    const cachedBpm = cacheKey ? playlistBpmByCacheKey.get(cacheKey) : undefined;
    const cachedConfidence = cacheKey ? playlistConfidenceByCacheKey.get(cacheKey) : undefined;
    const cachedWaveform = cacheKey ? playlistWaveformByCacheKey.get(cacheKey) : undefined;
    const cachedKeyAnalysis = cacheKey && settings.keyAnalysisEnabled
      ? playlistKeyAnalysisByCacheKey.get(cacheKey)
      : undefined;
    const cachedKeyStatus = resolveKeyStatusFromResult(cachedKeyAnalysis);
    const hasCachedBpm = Number.isFinite(cachedBpm);
    appendKeyAnalysisTrace(
      keyAnalysisTrace,
      'ui-seed',
      `reason=${reason} key=${cacheKey || '-'} bpm=${hasCachedBpm ? Math.round(Number(cachedBpm)) : '-'} keyStatus=${cachedKeyStatus || '-'} waveform=${cachedWaveform ? '1' : '0'} source=${normalizedSource}`
    );

    analysis = {
      sourceUrl: normalizedSource,
      bpm: hasCachedBpm ? Number(cachedBpm) : undefined,
      ...buildBpmDebugFields(
        hasCachedBpm ? 'cache.analysis' : 'runtime.pending',
        cacheKey || undefined,
        hasCachedBpm
          ? 'discover track selection reused playlist cache'
          : 'discover track selection waiting for analysis',
        playlistBpmByCacheKey,
        normalizeCacheKey,
        hasCachedBpm ? Number(cachedBpm) : undefined
      ),
      confidence: hasCachedBpm && Number.isFinite(cachedConfidence) ? cachedConfidence : undefined,
      tempoDecisionConfidence: hasCachedBpm && Number.isFinite(cachedConfidence) ? cachedConfidence : undefined,
      tempoDebugBaseBpm: hasCachedBpm ? Number(cachedBpm) : undefined,
      tempoDebugSummary: hasCachedBpm ? `tempo-base bpm=${Math.round(Number(cachedBpm))} method=cache via=playlist` : undefined,
      tempoDebugGate: hasCachedBpm ? 'cache-hit' : undefined,
      tempoDebugCandidates: hasCachedBpm
        ? [{ bpm: Math.round(Number(cachedBpm)), label: 'base', score: 1 }]
        : undefined,
      beatTypeAuto: undefined,
      breakbeatScore: undefined,
      keyAnalysis: cachedKeyAnalysis,
      keyStatus: settings.keyAnalysisEnabled
        ? (cachedKeyStatus ?? (hasCachedBpm ? 'analyzing' : 'pending-bpm'))
        : 'disabled',
      analysisStatus: hasCachedBpm ? `BPM: ${Math.round(Number(cachedBpm))}` : 'Estimating BPM...',
      analysisMs: hasCachedBpm ? 0 : undefined,
      analysisFetchMs: hasCachedBpm ? 0 : undefined,
      analysisDecodeMs: hasCachedBpm ? 0 : undefined,
      analysisTempoMs: hasCachedBpm ? 0 : undefined,
      waveform: cachedWaveform || null,
      waveformStatus: '',
      waveformMs: cachedWaveform ? 0 : undefined,
      error: undefined,
      ts: Date.now()
    };
  };

  const isBpmAnalysisInProgressForCurrentSource = (): boolean =>
    isBpmAnalysisInProgressForSource(analysis, String(nowPlaying.streamUrl || ''));

  const resolveKeyStatusFromResult = (
    keyAnalysis: KeyAnalysisResult | null | undefined
  ): AnalysisResult['keyStatus'] =>
    resolveKeyStatusFromAnalysis(settings.keyAnalysisEnabled, keyAnalysis);
  const isNowPlayingMetadataReadyForAnalysis = (sourceUrl = nowPlaying.streamUrl): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource || !nonReleaseSnapshot) {
      return false;
    }
    return nonReleaseSnapshot.currentSrc === normalizedSource && nonReleaseSnapshot.flags.metadataAlignedWithSource;
  };
  const isNowPlayingPlaylistReadyForAnalysis = (sourceUrl = nowPlaying.streamUrl): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource || playlistState.loading) {
      return false;
    }

    const source = String(playlistSource || '').trim();
    if (!source || source === 'waiting-for-origin-play' || source.startsWith('switching')) {
      return false;
    }

    if (playlistContainsSourceTrack(playlistState.tracks, normalizedSource, {
      normalizeUrlForCompare: normalizeUrl
    })) {
      return true;
    }

    return source.includes('exhausted');
  };
  const isNowPlayingContextReadyForAnalysis = (sourceUrl = nowPlaying.streamUrl): boolean =>
    isNowPlayingMetadataReadyForAnalysis(sourceUrl) && isNowPlayingPlaylistReadyForAnalysis(sourceUrl);
  const isNowPlayingBpmSettled = (sourceUrl = nowPlaying.streamUrl): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, normalizedSource, {
      normalizeUrlForCompare: normalizeUrl,
      normalizeUrlForCache: normalizeUrl
    });
    if (hasCachedPlaylistBpm(sourceCacheKey || undefined)) {
      return true;
    }
    if (!analysis || String(analysis.sourceUrl || '').trim() !== normalizedSource) {
      return false;
    }
    return Number.isFinite(analysis.bpm) || Boolean(String(analysis.error || '').trim());
  };
  const shouldDeferDiscoverRuntimePrepare = (sourceUrl: string): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    const currentSource = String(nowPlaying.streamUrl || '').trim();
    if (!normalizedSource || normalizedSource !== currentSource) {
      return false;
    }
    if (discoverPlaybackMode !== 'origin' || runtimePlaybackOwned) {
      return false;
    }
    if (!isNowPlayingContextReadyForAnalysis(normalizedSource)) {
      return false;
    }
    return !isNowPlayingBpmSettled(normalizedSource);
  };
  const isNowPlayingWaveformSettled = (sourceUrl = nowPlaying.streamUrl): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, normalizedSource, {
      normalizeUrlForCompare: normalizeUrl,
      normalizeUrlForCache: normalizeUrl
    });
    if (sourceCacheKey && playlistWaveformByCacheKey.has(sourceCacheKey)) {
      return true;
    }
    if (!analysis || String(analysis.sourceUrl || '').trim() !== normalizedSource) {
      return false;
    }
    if (analysis.waveform) {
      return true;
    }
    const waveformStatus = String(analysis.waveformStatus || '').trim();
    return Boolean(waveformStatus);
  };
  const isNowPlayingKeySettled = (sourceUrl = nowPlaying.streamUrl): boolean => {
    if (!settings.keyAnalysisEnabled) {
      return true;
    }
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, normalizedSource, {
      normalizeUrlForCompare: normalizeUrl,
      normalizeUrlForCache: normalizeUrl
    });
    if (sourceCacheKey && playlistKeyAnalysisByCacheKey.has(sourceCacheKey)) {
      return true;
    }
    if (!analysis || String(analysis.sourceUrl || '').trim() !== normalizedSource) {
      return false;
    }
    const keyStatus = analysis.keyStatus;
    return keyStatus === 'ready' || keyStatus === 'empty' || keyStatus === 'error' || keyStatus === 'disabled';
  };
  const resolveDiscoverPreloadStartupBlockReason = (): string => {
    // Discover keeps waveform in the current-track gate so row rendering stays
    // visually aligned before background preload analysis begins.
    if (!String(nowPlaying.streamUrl || '').trim()) {
      return 'no-source';
    }
    if (!isNowPlayingContextReadyForAnalysis()) {
      return 'context';
    }
    if (!isNowPlayingBpmSettled()) {
      return 'current-bpm';
    }
    if (!isNowPlayingWaveformSettled()) {
      return 'waveform';
    }
    if (!isNowPlayingKeySettled()) {
      return 'current-key';
    }
    return '';
  };

  analysisReqCtrl = createAnalysisRequestController({
    getCurrentSourceUrl: () => String(nowPlaying.streamUrl || '').trim(),
    getRequestSeed: () => `${tempoRunId}`,
    isStale: (capturedSeed, sourceUrl) =>
      capturedSeed !== `${tempoRunId}`
      || String(nowPlaying.streamUrl || '').trim() !== sourceUrl,
    isKeyAnalysisEnabled: () => settings.keyAnalysisEnabled,
    isContextReadyForKeyAnalysis: (sourceUrl) => isNowPlayingContextReadyForAnalysis(sourceUrl),
    resolveSourceCacheKey: (sourceUrl) =>
      resolveSourceTrackCacheKey(playlistState.tracks, sourceUrl, {
        normalizeUrlForCompare: normalizeUrl,
        normalizeUrlForCache: normalizeUrl
      }),
    getCachedBpm: (cacheKey) => playlistBpmByCacheKey.get(cacheKey),
    getCachedConfidence: (cacheKey) => playlistConfidenceByCacheKey.get(cacheKey),
    getCachedKeyAnalysis: (cacheKey) => playlistKeyAnalysisByCacheKey.get(cacheKey),
    getCachedWaveform: (cacheKey) => playlistWaveformByCacheKey.get(cacheKey),
    setCachedBpm: (cacheKey, bpm) => setCachedPlaylistBpm(cacheKey, bpm),
    setCachedConfidence: (cacheKey, confidence) => playlistConfidenceByCacheKey.set(cacheKey, confidence),
    setCachedKeyAnalysis: (cacheKey, keyAnalysis) => playlistKeyAnalysisByCacheKey.set(cacheKey, keyAnalysis),
    setCachedWaveform: (cacheKey, waveform) => playlistWaveformByCacheKey.set(cacheKey, waveform),
    markFailed: (cacheKey) => playlistFailedCacheKeys.add(cacheKey),
    clearFailed: (cacheKey) => playlistFailedCacheKeys.delete(cacheKey),
    canAttemptAnalysis: () => true,
    registerAttempt: (cacheKey) => registerAnalysisAttempt(cacheKey),
    setTrackAnalyzing: (cacheKey, analyzing) => setTrackAnalyzing(cacheKey, analyzing),
    getTrace: () => keyAnalysisTrace,
    getAnalysis: () => analysis,
    setAnalysis: (a) => {
      analysis = a;
      applyTempoAdjustToPlayback();
    },
    getAnalysisRunId: () => analysisRunId,
    incrementAnalysisRunId: () => { analysisRunId += 1; return analysisRunId; },
    resolveKeyStatus: (keyAnalysis) => resolveKeyStatusFromResult(keyAnalysis),
    getBpmCacheMap: () => playlistBpmByCacheKey,
    render: () => render(),
    syncPreloadQueue: () => preloadCtrl.syncDiscoverPreloadQueue(),
    applyDecorations: () => preloadCtrl.applyPlaylistAnalysisDecorations(),
    onWaveformSettled: () => {
      const sourceUrl = String(nowPlaying.streamUrl || '').trim();
      if (!sourceUrl) {
        return;
      }
      syncRuntimeAudioSource(sourceUrl);
    },
    scheduleTempoRetry: (_sourceUrl, delayMs) => {
      const capturedRunId = tempoRunId;
      const capturedSource = String(nowPlaying.streamUrl || '').trim();
      window.setTimeout(() => {
        if (capturedRunId !== tempoRunId || String(nowPlaying.streamUrl || '').trim() !== capturedSource) {
          return;
        }
        analysisReqCtrl.requestTempo();
      }, delayMs);
    },
    onEmptySourceReset: () => {
      tempoRunId += 1;
      clearAllTrackAnalyzing();
      preloadCtrl.preloader.cancel();
      preloadCtrl.resetDiscoverPreloadBpmEpoch();
      preloadCtrl.clearPreloadKeyFailedCacheKeys();
      preloadCtrl.resetDiscoverPreloadFailureEpoch();
      preloadCtrl.cancelDiscoverPreloadKeyPass();
    }
  });

  const maybeStartNowPlayingAnalysis = (keySeed = `context:${playlistRunId}:${lastTrackKey}`): void => {
    const normalizedSource = String(nowPlaying.streamUrl || '').trim();
    if (!normalizedSource) {
      return;
    }
    if (!isNowPlayingContextReadyForAnalysis(normalizedSource)) {
      return;
    }
    analysisReqCtrl.requestTempo();
  };

  const resolveDiscoverTrackStream = (track: PlaylistTrack): { streamUrl: string; synthetic: boolean } => {
    const direct = mergeDiscoverPlaybackQuery(String(track.streamUrl || '').trim(), nowPlaying.streamUrl);
    if (direct) {
      return { streamUrl: direct, synthetic: false };
    }
    const synthetic = deriveSyntheticStreamUrl(nowPlaying.streamUrl, String(track.trackId || ''));
    if (synthetic) {
      return { streamUrl: synthetic, synthetic: true };
    }
    return { streamUrl: '', synthetic: false };
  };
  const buildRuntimePlaylistWarmTargets = (tracks: PlaylistTrack[], currentIndex: number): number[] => {
    const warmTargets: number[] = [];
    const windowSize = Math.min(tracks.length, runtimePredecodePolicy.windowTracks);
    for (let offset = 0; offset < windowSize; offset += 1) {
      const trackIndex = (currentIndex + offset + tracks.length) % tracks.length;
      if (isTrackPlayable(tracks[trackIndex])) {
        const { streamUrl } = resolveDiscoverTrackStream(tracks[trackIndex]);
        if (streamUrl && !runtimeAudioEngine.findPrepared(streamUrl)?.buffer) {
          warmTargets.push(trackIndex);
        }
      }
    }
    return warmTargets;
  };
  const isRuntimePlaylistWarmRunCurrent = (warmToken: number, trackIndex: number): boolean => {
    if (warmToken === runtimePlaylistWarmToken) {
      return true;
    }
    appendJumpTrace(
      'runtime-warm-stale',
      `token=${warmToken} latest=${runtimePlaylistWarmToken} stoppedAtIndex=${trackIndex}`
    );
    return false;
  };

  const warmRuntimeAudioForPlaylistTracks = (): void => {
    if (!settings.preloadTracksEnabled || !runtimeAudioController || playlistState.tracks.length === 0) {
      return;
    }

    const tracks = playlistState.tracks;
    const currentIndex = Number.isInteger(playlistState.currentIndex) ? playlistState.currentIndex : 0;
    const warmTargets = buildRuntimePlaylistWarmTargets(tracks, currentIndex);
    const warmSignature = `${currentIndex}|${tracks
      .map((track) => String(track.trackId || track.cacheKey || track.streamUrl || '').trim())
      .join('|')}`;
    if (!warmTargets.length) {
      runtimePlaylistWarmActive = false;
      runtimePlaylistWarmSignature = '';
      runtimePlaylistPrepareInFlight.clear();
      render();
      return;
    }
    if (runtimePlaylistWarmActive && runtimePlaylistWarmSignature === warmSignature) {
      appendJumpTrace(
        'runtime-warm-skip',
        `reason=active tracks=${warmTargets.length} currentIndex=${currentIndex}`
      );
      return;
    }

    const warmToken = ++runtimePlaylistWarmToken;
    runtimePlaylistWarmActive = true;
    runtimePlaylistWarmSignature = warmSignature;
    const sourceVersion = runtimeSourceVersion;
    appendJumpTrace(
      'runtime-warm-start',
      `token=${warmToken} sourceVersion=${sourceVersion} tracks=${warmTargets.length} currentIndex=${currentIndex}`
    );
    void (async () => {
      let nextWarmOffset = 0;
      const runNextWarmTarget = async (): Promise<void> => {
        while (true) {
          const trackIndex = warmTargets[nextWarmOffset];
          nextWarmOffset += 1;
          if (!Number.isFinite(trackIndex)) {
            return;
          }
          if (!isRuntimePlaylistWarmRunCurrent(warmToken, trackIndex)) {
            return;
          }
          const track = playlistState.tracks[trackIndex];
          if (!track) {
            continue;
          }
          const { streamUrl } = resolveDiscoverTrackStream(track);
          if (!streamUrl || runtimeAudioEngine.findPrepared(streamUrl)?.buffer) {
            continue;
          }
          const sourceCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, streamUrl, {
            normalizeUrlForCompare: normalizeUrl,
            normalizeUrlForCache: normalizeUrl
          });
          const inFlightKey = sourceCacheKey || normalizeUrl(streamUrl) || streamUrl;
          if (runtimePlaylistPrepareInFlight.has(inFlightKey)) {
            continue;
          }

          runtimePlaylistPrepareInFlight.add(inFlightKey);
          try {
            const preparePromise = runtimeAudioEngine.prepareTrack({
              url: streamUrl,
              cacheKey: sourceCacheKey || undefined,
              sourceVersion
            });
            render();
            const prepared = await preparePromise;
            if (prepared.ok) {
              recordTransportResult(transportDebug, 'runtime-predecode-ready', `index=${trackIndex} key=${inFlightKey}`);
              if (
                runtimeAudioController &&
                nowPlaying.streamUrl &&
                sourcesShareTrackIdentity(nowPlaying.streamUrl, streamUrl)
              ) {
                runtimeAudioController.onPreparedTrackReady();
              }
            } else {
              recordTransportResult(
                transportDebug,
                'runtime-predecode-failed',
                `index=${trackIndex} key=${inFlightKey} reason=${prepared.reason || 'unknown'}`
              );
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            recordTransportResult(
              transportDebug,
              'runtime-predecode-failed',
              `index=${trackIndex} key=${inFlightKey} reason=${reason || 'unknown'}`
            );
          } finally {
            runtimePlaylistPrepareInFlight.delete(inFlightKey);
            render();
          }
        }
      };
      try {
        const workerCount = Math.max(1, Math.min(runtimePredecodePolicy.maxConcurrentPredecode, warmTargets.length));
        await Promise.all(Array.from({ length: workerCount }, () => runNextWarmTarget()));
      } finally {
        if (warmToken === runtimePlaylistWarmToken) {
          runtimePlaylistWarmActive = false;
          runtimePlaylistWarmSignature = '';
          render();
        }
      }
    })();
  };

  const selectDiscoverPlaylistTrack = (index: number): void => {
    const target = playlistState.tracks[index];
    if (!target) {
      recordTransportResult(transportDebug, 'select-invalid-index', `index=${index}`);
      render();
      return;
    }
    if (!isTrackPlayable(target)) {
      recordTransportResult(transportDebug, 'select-unplayable', `index=${index} trackId=${target.trackId || '-'}`);
      render();
      return;
    }

    const { streamUrl, synthetic } = resolveDiscoverTrackStream(target);
    if (!streamUrl) {
      recordTransportResult(
        transportDebug,
        'fallback-unroutable',
        `index=${index} trackId=${target.trackId || '-'} stream=0`
      );
      render();
      return;
    }

    playlistState = withCurrentPlaylistIndex(playlistState, index);
    // Cancel in-flight analysis for the previous track and clear dedup keys so
    // analysisReqCtrl.requestTempo can start fresh for the new track immediately.
    analysisReqCtrl.cancelAll();
    analysisReqCtrl.resetRequestKeys();
    resetTempoAdjustSession('playlist-select', { applyToPlayback: false });
    nowPlaying = {
      ...nowPlaying,
      trackTitle: String(target.title || nowPlaying.trackTitle || '').trim(),
      artistName: String(target.artistName || nowPlaying.artistName || '').trim(),
      albumTitle: String(target.albumTitle || nowPlaying.albumTitle || '').trim(),
      releaseUrl: String(target.pageUrl || nowPlaying.releaseUrl || '').trim(),
      streamUrl,
      trackId: String(target.trackId || readTrackIdFromUrl(streamUrl) || nowPlaying.trackId || '').trim(),
      currentTimeSec: 0,
      durationSec: Number.isFinite(target.durationSec) ? Number(target.durationSec || 0) : 0,
      playbackTs: 0,
      isPlaying: false
    };
    // Make the selection authoritative immediately so bridge polling cannot
    // temporarily snap state back to the previous origin track.
    discoverPlaybackMode = 'detached';
    // Seed the visible current-track panel immediately from playlist cache so
    // discover jumps do not keep showing the previous track while bridge sync catches up.
    seedAnalysisFromSelectedDiscoverTrack(target, streamUrl, 'user-select');
    refreshMetadataPhase(playlistRunId, nowPlaying, false);
    analysisReqCtrl.requestTempo();
    pendingManualRuntimeSyncSourceUrl = streamUrl;
    syncRuntimeAudioSource(streamUrl);
    if (runtimeAudioController) {
      runtimeAudioController.loadTrack(streamUrl, { detached: true });
    } else {
      sendDiscoverAudioCommand('load-track', { streamUrl, detached: true });
    }
    warmRuntimeAudioForPlaylistTracks();
    recordTransportResult(
      transportDebug,
      synthetic ? 'load-track-synthetic' : 'load-track',
      `index=${index} trackId=${target.trackId || '-'} stream=${synthetic ? 'synthetic' : '1'} owner=detached`
    );
    render();
  };

  const jumpDiscoverRelative = (direction: 1 | -1): void => {
    const total = playlistState.tracks.length;
    if (total <= 1) {
      recordTransportResult(transportDebug, 'fallback-unroutable', `dir=${direction} tracks=${total}`);
      render();
      return;
    }
    const nextIndex = findDirectionalPlayableIndex(playlistState.tracks, playlistState.currentIndex, direction);
    if (nextIndex < 0) {
      recordTransportResult(transportDebug, 'fallback-unroutable', `dir=${direction} tracks=${total} no-playable-target`);
      render();
      return;
    }
    selectDiscoverPlaylistTrack(nextIndex);
  };

  const settleDiscoverPlaylistEnd = (): void => {
    const runtimeState = lastRuntimePlaybackState;
    const runtimeMatchesCurrent = Boolean(
      runtimeState?.src &&
      nowPlaying.streamUrl &&
      sourcesShareTrackIdentity(runtimeState.src, nowPlaying.streamUrl)
    );
    const playlistTrack = playlistState.tracks[playlistState.currentIndex] || null;
    const durationSec = [
      runtimeMatchesCurrent ? runtimeState?.durationSec : 0,
      nowPlaying.durationSec,
      playlistTrack?.durationSec
    ].find((value) => Number.isFinite(value) && Number(value) > 0);
    const finalDurationSec = Number(durationSec || 0);
    nowPlaying = {
      ...nowPlaying,
      isPlaying: false,
      currentTimeSec: finalDurationSec > 0 ? finalDurationSec : Math.max(0, Number(nowPlaying.currentTimeSec || 0)),
      durationSec: finalDurationSec || Number(nowPlaying.durationSec || 0),
      playbackTs: 0
    };
    playbackHandoff.reportPlaybackState(false, nowPlaying.streamUrl);
  };

  handlePlaybackShortcutCommand = (action): void => {
    if (action === 'toggle-play-pause') {
      recordTransportAction(transportDebug, 'media-key-toggle-play-pause', `playing=${nowPlaying.isPlaying ? '1' : '0'}`);
      if (runtimeAudioController) {
        runtimeAudioController.togglePlayPause();
        recordTransportResult(transportDebug, 'media-key-toggle-play-pause-dispatched', 'runtime-controller');
      } else {
        sendDiscoverAudioCommand('toggle-play-pause');
        recordTransportResult(transportDebug, 'media-key-toggle-play-pause-dispatched', 'origin-bridge');
      }
      return;
    }
    if (action === 'previous-track') {
      recordTransportAction(transportDebug, 'media-key-prev-track', `current=${playlistState.currentIndex}`);
      jumpDiscoverRelative(-1);
      return;
    }
    if (action === 'next-track') {
      recordTransportAction(transportDebug, 'media-key-next-track', `current=${playlistState.currentIndex}`);
      jumpDiscoverRelative(1);
    }
  };

  const maybeAutoAdvanceDiscoverPlaylist = (origin: 'origin-ended' | 'runtime-ended'): boolean => {
    if (!settings.autoPlayEnabled) {
      return false;
    }
    const autoAdvanceTrackKey = String(
      nowPlaying.trackId ||
      readTrackIdFromUrl(nowPlaying.streamUrl) ||
      playlistState.tracks[playlistState.currentIndex]?.trackId ||
      `${playlistState.currentIndex}`
    ).trim();
    const nowMs = Date.now();
    const nextIndex = findNextPlayableIndexWithoutWrap(playlistState.tracks, playlistState.currentIndex);
    if (nextIndex < 0) {
      settleDiscoverPlaylistEnd();
      recordTransportResult(transportDebug, 'auto-next-track-stop', `reason=end-of-playlist origin=${origin}`);
      lastAutoAdvanceTrackKey = autoAdvanceTrackKey;
      lastAutoAdvanceAtMs = nowMs;
      render();
      return true;
    }
    if (
      autoAdvanceTrackKey &&
      autoAdvanceTrackKey === lastAutoAdvanceTrackKey &&
      nowMs - lastAutoAdvanceAtMs < DISCOVER_AUTO_ADVANCE_DEDUP_MS
    ) {
      return true;
    }
    recordTransportResult(
      transportDebug,
      'auto-next-track',
      `from=${playlistState.currentIndex} to=${nextIndex} origin=${origin}`
    );
    lastAutoAdvanceTrackKey = autoAdvanceTrackKey;
    lastAutoAdvanceAtMs = nowMs;
    selectDiscoverPlaylistTrack(nextIndex);
    return true;
  };

  const applyTempoAdjustToPlayback = (): number => {
    return applyTempoAdjust(tempoAdjust, analysis, playlistState, {
      applyTempoAdjust(playbackRate, masterTempoEnabled) {
        // Route tempo adjust through runtime audio controller if available
        if (runtimeAudioController) {
          runtimeAudioController.applyTempoAdjust(playbackRate, masterTempoEnabled);
        } else {
          recordTransportResult(
            transportDebug,
            'tempo-adjust-runtime-unavailable',
            `rate=${playbackRate.toFixed(4)} masterTempo=${masterTempoEnabled ? '1' : '0'}`
          );
        }
      }
    });
  };

  const resetTempoAdjustSession = (reason: string, options: { applyToPlayback?: boolean } = {}): void => {
    const applyToPlayback = options.applyToPlayback !== false;
    resetSharedTempoAdjustSession(tempoAdjust);
    const rate = applyToPlayback ? applyTempoAdjustToPlayback() : 1;
    recordTransportResult(
      transportDebug,
      'tempo-adjust-session-reset',
      `reason=${reason} rate=${rate.toFixed(4)}`
    );
  };
  const syncRuntimeAudioSource = (sourceUrl: string, options: { prepareForUserIntent?: boolean } = {}): void => {
    if (!sourceUrl || !runtimeAudioController) {
      return;
    }
    const sameSyncedSource = Boolean(lastRuntimeSyncedSourceUrl) &&
      sourcesShareTrackIdentity(lastRuntimeSyncedSourceUrl, sourceUrl);
    if (sameSyncedSource && !options.prepareForUserIntent) {
      return;
    }
    if (!sameSyncedSource || runtimeSourceVersion <= 0) {
      runtimeSourceVersion += 1;
    }
    const expectedVersion = runtimeSourceVersion;
    lastRuntimeSyncedSourceUrl = sourceUrl;
    appendJumpTrace(
      'runtime-source-sync',
      `src=${sourceUrl} sourceVersion=${expectedVersion} playlistRun=${playlistRunId}`
    );
    const sourceCacheKey = resolveSourceTrackCacheKey(playlistState.tracks, sourceUrl, {
      normalizeUrlForCompare: normalizeUrl,
      normalizeUrlForCache: normalizeUrl
    });

    runtimeAudioController.setCurrentSource(sourceUrl, expectedVersion);
    if (discoverPlaybackMode === 'origin' && !runtimePlaybackOwned && !options.prepareForUserIntent) {
      appendJumpTrace(
        'runtime-source-defer',
        `src=${sourceUrl} sourceVersion=${expectedVersion} playlistRun=${playlistRunId} reason=origin-awaiting-user-intent`
      );
      return;
    }
    if (!options.prepareForUserIntent && shouldDeferDiscoverRuntimePrepare(sourceUrl)) {
      appendJumpTrace(
        'runtime-source-defer',
        `src=${sourceUrl} sourceVersion=${expectedVersion} playlistRun=${playlistRunId} reason=current-bpm-priority`
      );
      return;
    }

    const preparedTrack = runtimeAudioEngine.findPrepared(sourceUrl);
    if (preparedTrack?.buffer) {
      runtimeAudioController.onPreparedTrackReady();
      warmRuntimeAudioForPlaylistTracks();
      return;
    }
    const inFlightKey = sourceCacheKey || normalizeUrl(sourceUrl) || sourceUrl;
    if (runtimePlaylistPrepareInFlight.has(inFlightKey)) {
      recordTransportResult(
        transportDebug,
        'runtime-prepare-current-skip',
        `reason=playlist-predecode-in-flight key=${inFlightKey}`
      );
      return;
    }

    void runtimeAudioEngine.prepareTrack({
      url: sourceUrl,
      cacheKey: sourceCacheKey || undefined,
      sourceVersion: expectedVersion
    }).then((prepared) => {
      if (!prepared.ok || expectedVersion !== runtimeSourceVersion) {
        return;
      }
      runtimeAudioController?.onPreparedTrackReady();
      warmRuntimeAudioForPlaylistTracks();
    }).catch((error) => {
      console.warn('[DISCOVER] runtime audio prepare failed', { error, url: sourceUrl });
    });
  };

  const getOwnedRuntimePlaybackState = (sourceUrl: string): RuntimeAudioPlaybackState | null => {
    const runtimeState = lastRuntimePlaybackState;
    if (!runtimePlaybackOwned || !runtimeState?.src) {
      return null;
    }
    const expectedSource = String(sourceUrl || nowPlaying.streamUrl || '').trim();
    if (!expectedSource) {
      return runtimeState;
    }
    return sourcesShareTrackIdentity(runtimeState.src, expectedSource) ? runtimeState : null;
  };

  const mergeRuntimeOwnedNowPlaying = (candidate: DiscoverNowPlaying): DiscoverNowPlaying => {
    const runtimeState = getOwnedRuntimePlaybackState(candidate.streamUrl);
    if (!runtimeState) {
      return candidate;
    }
    return {
      ...candidate,
      streamUrl: String(candidate.streamUrl || runtimeState.src || '').trim(),
      currentTimeSec: runtimeState.currentTimeSec,
      durationSec: runtimeState.durationSec || candidate.durationSec,
      playbackTs: runtimeState.ts,
      isPlaying: !runtimeState.paused
    };
  };

  const mergeDetachedModeNowPlaying = (candidate: DiscoverNowPlaying): DiscoverNowPlaying => {
    if (discoverPlaybackMode !== 'detached') {
      return candidate;
    }

    // In detached mode, the manual playlist selection is authoritative until
    // origin explicitly takes over again.
    const preservedStreamUrl = String(nowPlaying.streamUrl || candidate.streamUrl || '').trim();
    if (!preservedStreamUrl) {
      return candidate;
    }

    const candidateMatchesPreserved = Boolean(
      candidate.streamUrl &&
      sourcesShareTrackIdentity(candidate.streamUrl, preservedStreamUrl)
    );
    const nowPlayingDurationSec = Number(nowPlaying.durationSec || 0);
    const nowPlayingPinnedAtEnd = Boolean(
      !nowPlaying.isPlaying &&
      nowPlayingDurationSec > 0 &&
      Number(nowPlaying.currentTimeSec || 0) >= nowPlayingDurationSec - 0.25
    );
    const useCandidatePlaybackState = candidateMatchesPreserved && !nowPlayingPinnedAtEnd;
    const runtimeState = lastRuntimePlaybackState;
    const runtimeMatchesPreserved = Boolean(
      runtimePlaybackOwned &&
      runtimeState?.src &&
      sourcesShareTrackIdentity(runtimeState.src, preservedStreamUrl)
    );
    const preservedRuntimeState = runtimeMatchesPreserved ? runtimeState : null;

    return {
      ...candidate,
      trackTitle: String(nowPlaying.trackTitle || candidate.trackTitle || '').trim(),
      artistName: String(nowPlaying.artistName || candidate.artistName || '').trim(),
      albumTitle: String(nowPlaying.albumTitle || candidate.albumTitle || '').trim(),
      releaseUrl: String(nowPlaying.releaseUrl || candidate.releaseUrl || '').trim(),
      streamUrl: preservedStreamUrl,
      trackId: String(nowPlaying.trackId || readTrackIdFromUrl(preservedStreamUrl) || candidate.trackId || '').trim(),
      currentTimeSec: preservedRuntimeState
        ? preservedRuntimeState.currentTimeSec
        : Number((useCandidatePlaybackState ? candidate.currentTimeSec : nowPlaying.currentTimeSec) || 0),
      durationSec: preservedRuntimeState
        ? Number(preservedRuntimeState.durationSec || nowPlaying.durationSec || candidate.durationSec || 0)
        : Number((useCandidatePlaybackState ? candidate.durationSec : nowPlaying.durationSec) || 0),
      playbackTs: preservedRuntimeState
        ? preservedRuntimeState.ts
        : Number((useCandidatePlaybackState ? candidate.playbackTs : nowPlaying.playbackTs) || 0),
      identity: nowPlaying.identity || candidate.identity,
      isPlaying: preservedRuntimeState
        ? !preservedRuntimeState.paused
        : Boolean(useCandidatePlaybackState ? candidate.isPlaying : nowPlaying.isPlaying)
    };
  };

  const isDisplayMetadataReadyForCurrentSource = (): boolean => {
    const currentSource = String(nowPlaying.streamUrl || '').trim();
    if (!currentSource || !nonReleaseSnapshot || nonReleaseSnapshot.currentSrc !== currentSource) {
      return false;
    }
    if (!nonReleaseSnapshot.flags.metadataAlignedWithSource) {
      return false;
    }
    return (
      !isMissingMetadataValue(metadata.trackTitle) &&
      !isMissingMetadataValue(metadata.artistName) &&
      !isMissingMetadataValue(metadata.albumTitle) &&
      isApiMetadataSource(metadata.sources.title) &&
      isApiMetadataSource(metadata.sources.artist) &&
      isApiMetadataSource(metadata.sources.album)
    );
  };

  const isDisplayMetadataLoading = (): boolean =>
    Boolean(String(nowPlaying.streamUrl || '').trim()) && !isDisplayMetadataReadyForCurrentSource();

  const buildPanelInput = (): PanelInput => {
    const input = buildInput(
      metadata,
      playlistState,
      nowPlaying.isPlaying,
      analysis,
      settings.preloadTracksEnabled,
      settings.keyAnalysisEnabled,
      settings.autoPlayEnabled,
      nowPlaying,
      likeViewState,
      likeNoticeText,
      tempoAdjust.tempoScale,
      buildTempoAdjustControlsUiState(tempoAdjust, analysis, playlistState),
      runtimePlaybackOwned ? 'continuous' : 'commit-on-release',
      settings.keyboardShortcuts,
      isDisplayMetadataLoading(),
      uiPerformanceDebug,
      settings.preloadTracksEnabled
        ? resolveRuntimePlaylistPreparationUiState(playlistState, runtimeAudioEngine.getDebugSnapshot())
        : undefined,
      runtimePlaylistSelectionPending,
      settings.performanceModeEnabled
    );

    if (pendingSeekFraction === null) {
      return input;
    }
    // input.playheadFraction is the raw observed position; once it reaches the
    // committed target (or the settle window lapses) release the hold and resume
    // live tracking. Otherwise keep the playhead and clock pinned to the target.
    const ageMs = pendingSeekAtMs > 0 ? Date.now() - pendingSeekAtMs : null;
    const settled = Math.abs(input.playheadFraction - pendingSeekFraction) <= SEEK_SETTLE_FRACTION_EPSILON;
    const expired = ageMs === null || ageMs > SEEK_SETTLE_WINDOW_MS;
    if (settled || expired) {
      pendingSeekFraction = null;
      pendingSeekAtMs = 0;
      return input;
    }
    const held = Math.max(0, Math.min(1, pendingSeekFraction));
    return {
      ...input,
      playheadFraction: held,
      currentTimeSec: input.durationSec > 0 ? held * input.durationSec : input.currentTimeSec
    };
  };

  refreshLikeSnapshot();
  let debugPanel: DebugPanelController | null = null;
  let resourceDiagnostics: ResourceDiagnosticsController | null = null;
  const panel = showResultsPanel(
    buildPanelInput(),
    {
    onTogglePlayPause() {
      recordTransportAction(transportDebug, 'toggle-play-pause', `playing=${nowPlaying.isPlaying ? '1' : '0'}`);
      if (runtimeAudioController) {
        runtimeAudioController.togglePlayPause();
        recordTransportResult(transportDebug, 'toggle-play-pause-dispatched', 'runtime-controller');
      } else {
        sendDiscoverAudioCommand('toggle-play-pause');
        recordTransportResult(transportDebug, 'toggle-play-pause-dispatched', 'origin-bridge');
      }
    },
    onSetVolume(volume: number) {
      const clamped = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      recordTransportAction(transportDebug, 'set-volume', `volume=${clamped.toFixed(3)}`);
      if (runtimeAudioController) {
        runtimeAudioController.setVolume(clamped);
      } else {
        sendDiscoverAudioCommand('set-volume', { volume: clamped });
      }
      recordTransportResult(transportDebug, 'set-volume-dispatched', `volume=${clamped.toFixed(3)}`);
    },
    onSeekToFraction(fraction: number) {
      const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
      recordTransportAction(transportDebug, 'seek', `fraction=${clamped.toFixed(3)}`);
      if (runtimeAudioController) {
        runtimeAudioController.seekToFraction(clamped);
      } else {
        sendDiscoverAudioCommand('seek-fraction', { fraction: clamped });
      }
      // Hold the playhead at the committed target until the observed position
      // reaches it (see buildPanelInput). Do NOT write the target into nowPlaying
      // here: that made the observed fraction report the target before the engine
      // had seeked, after which a stale runtime STATE snapped the playhead back to
      // the old position (the new->old->new jump).
      pendingSeekFraction = clamped;
      pendingSeekAtMs = Date.now();
      render();
      recordTransportResult(transportDebug, 'seek-dispatched', `fraction=${clamped.toFixed(3)}`);
    },
    onPrevTrack() {
      recordTransportAction(transportDebug, 'prev-track', `current=${playlistState.currentIndex}`);
      jumpDiscoverRelative(-1);
    },
    onNextTrack() {
      recordTransportAction(transportDebug, 'next-track', `current=${playlistState.currentIndex}`);
      jumpDiscoverRelative(1);
    },
    onSelectPlaylistTrack(index: number) {
      recordTransportAction(transportDebug, 'select-playlist-track', `index=${index} current=${playlistState.currentIndex}`);
      selectDiscoverPlaylistTrack(index);
    },
    onTogglePlaylistSort(key) {
      playlistState = togglePlaylistSort(playlistState, key);
      preloadCtrl.syncDiscoverPreloadQueue();
      render();
    },
    onTogglePlaylist() {
      recordTransportAction(transportDebug, 'toggle-playlist', `expanded=${!playlistState.expanded}`);
      recordTransportResult(transportDebug, 'toggle-playlist-ui-only', 'panel-local');
    },
    onToggleAlbumLike() {
      void likeCtrl.runWishlistToggle('album');
    },
    onToggleTrackLike(index: number) {
      void likeCtrl.runWishlistToggle('track', index);
    },
    onTogglePreloadTracks(enabled) {
      settings.setPreloadTracksEnabled(Boolean(enabled));
      if (enabled) {
        warmRuntimeAudioForPlaylistTracks();
      }
    },
    onToggleKeyAnalysis(enabled) {
      settings.setKeyAnalysisEnabled(Boolean(enabled));
    },
    onToggleAutoPlay(enabled) {
      settings.setAutoPlayEnabled(Boolean(enabled));
    },
    onTogglePerformanceMode(enabled) {
      // Persist the global Chrome-only player setting; Discover playback is unaffected.
      settings.setPerformanceModeEnabled(Boolean(enabled));
    },
    onKeyboardShortcutsChanged(shortcuts) {
      settings.setKeyboardShortcuts(shortcuts);
    },
    onOpenBackgroundTab(url: string) {
      const targetUrl = String(url || '').trim();
      recordTransportAction(transportDebug, 'open-background-tab', targetUrl || '-');
      void openBackgroundTab(targetUrl);
    },
    onSetTempoAdjustOffsetBpm(offsetBpm: number) {
      if (!isTempoAdjustReady(analysis, playlistState)) {
        recordTransportResult(transportDebug, 'tempo-adjust-offset-blocked', 'bpm-unavailable');
        render();
        return;
      }
      const changed = setTempoAdjustOffset(tempoAdjust, offsetBpm);
      const rate = applyTempoAdjustToPlayback();
      recordTransportResult(
        transportDebug,
        'tempo-adjust-offset',
        `offset=${tempoAdjust.offsetBpm} rate=${rate.toFixed(4)} changed=${changed ? '1' : '0'}`
      );
      render();
    },
    onSetTempoAdjustMasterTempoEnabled(enabled: boolean) {
      if (!isTempoAdjustReady(analysis, playlistState)) {
        recordTransportResult(transportDebug, 'tempo-adjust-master-tempo-blocked', 'bpm-unavailable');
        render();
        return;
      }
      const changed = setTempoAdjustMasterTempo(tempoAdjust, enabled);
      const rate = applyTempoAdjustToPlayback();
      recordTransportResult(
        transportDebug,
        'tempo-adjust-master-tempo',
        `enabled=${tempoAdjust.masterTempoEnabled ? '1' : '0'} rate=${rate.toFixed(4)} changed=${changed ? '1' : '0'}`
      );
      render();
    },
    onClosePanel() {
      deactivateExtension();
    }
  },
  {
    onWaveformPerformance(snapshot) {
      uiPerformanceDebug.waveformLoading = snapshot;
    },
    onOpenDebugger() {
      debugPanel?.open();
    }
  }
  );
  applyTempoAdjustToPlayback();

  // Initialize runtime audio controller for Signalsmith stretching
  runtimeAudioController = createDiscoverRuntimeAudioController({
    engine: runtimeAudioEngine,
    onPlaybackState(runtimeState) {
      lastRuntimePlaybackState = runtimeState;
      const runtimeMatchesCurrent = Boolean(
        runtimeState.src &&
        nowPlaying.streamUrl &&
        sourcesShareTrackIdentity(runtimeState.src, nowPlaying.streamUrl)
      );
      const shouldReflectRuntimeState = runtimePlaybackOwned || (discoverPlaybackMode === 'detached' && runtimeMatchesCurrent);

      if (shouldReflectRuntimeState) {
        nowPlaying = {
          ...nowPlaying,
          streamUrl: String(nowPlaying.streamUrl || runtimeState.src || '').trim(),
          isPlaying: !runtimeState.paused,
          currentTimeSec: runtimeState.currentTimeSec,
          durationSec: runtimeState.durationSec,
          playbackTs: runtimeState.ts
        };
      }
      playbackHandoff.reportPlaybackState(
        !runtimeState.paused,
        String(runtimeState.src || nowPlaying.streamUrl || '').trim()
      );
      render();
    },
    onPlaybackEnded: () => {
      if (maybeAutoAdvanceDiscoverPlaylist(runtimePlaybackOwned ? 'runtime-ended' : 'origin-ended')) {
        return;
      }
      settleDiscoverPlaylistEnd();
      render();
    },
    onSkipTrack: (dir) => jumpDiscoverRelative(dir),
    onOwnershipChange(owned, state) {
      runtimePlaybackOwned = owned;
      runtimeOwnershipDebug = state;
      if (!owned && lastRuntimePlaybackState?.src && sourcesShareTrackIdentity(lastRuntimePlaybackState.src, nowPlaying.streamUrl)) {
        nowPlaying = {
          ...nowPlaying,
          isPlaying: false,
          currentTimeSec: lastRuntimePlaybackState.currentTimeSec,
          durationSec: lastRuntimePlaybackState.durationSec || nowPlaying.durationSec,
          playbackTs: lastRuntimePlaybackState.ts
        };
      }
      recordTransportResult(
        transportDebug,
        'runtime-ownership',
        `owned=${owned ? '1' : '0'} state=${state.ownershipState} firstOrigin=${state.firstOriginAvailable ? '1' : '0'}`
      );
      render();
    },
    onRuntimeSourceChanged(src) {
      const sourceUrl = String(src || '').trim();
      if (!sourceUrl) {
        return;
      }
      lastRuntimeSyncedSourceUrl = sourceUrl;
      pendingManualRuntimeSyncSourceUrl = '';
      discoverPlaybackMode = 'detached';
      const playlistIndex = findPlaylistTrackIndexBySource(playlistState.tracks, sourceUrl, {
        normalizeUrlForCompare: normalizeUrl
      });
      if (playlistIndex >= 0 && playlistIndex !== playlistState.currentIndex) {
        playlistState = withCurrentPlaylistIndex(playlistState, playlistIndex);
      }
      nowPlaying = {
        ...nowPlaying,
        streamUrl: sourceUrl,
        isPlaying: false,
        currentTimeSec: 0,
        playbackTs: 0
      };
      recordTransportResult(transportDebug, 'runtime-source-changed', `src=${sourceUrl}`);
      warmRuntimeAudioForPlaylistTracks();
      render();
    },
    onTakeoverDebug(reason, stage) {
      recordTransportResult(transportDebug, `takeover:${reason}`, stage);
    },
    onPendingRuntimeSelectionChange(pending) {
      runtimePlaylistSelectionPending = pending;
      render();
    },
    requestCurrentRuntimePrepare(reason) {
      const sourceUrl = String(nowPlaying.streamUrl || '').trim();
      if (!sourceUrl) {
        recordTransportResult(transportDebug, 'runtime-prepare-current-skip', `reason=${reason} source=-`);
        return;
      }
      syncRuntimeAudioSource(sourceUrl, { prepareForUserIntent: true });
    }
  });

  const buildDebugSections = (): DebugSection[] =>
    buildDiscoverControllerDebugSections({
      metadata,
      playlistState,
      nowPlaying,
      analysis,
      preloadTracksEnabled: settings.preloadTracksEnabled,
      keyAnalysisEnabled: settings.keyAnalysisEnabled,
      likeViewState,
      likeNoticeText,
      likesDebug,
      playlistSource,
      runId: playlistRunId,
      apiPolicyLine: formatApiPolicyLine(),
      apiShadowPolicyLine: formatApiShadowPolicyLine({
        playlistSource,
        fetchGateDebug: getTrackFetchGateDebug(String(nowPlaying.trackId || readTrackIdFromUrl(nowPlaying.streamUrl) || ''))
      }),
      hintDebug,
      transportDebug,
      keyAnalysisTrace,
      jumpTrace,
      preloadTrace: preloadCtrl.getPreloadTrace(),
      preloadBpmBatchOpenTs: preloadCtrl.getPreloadBpmBatchOpenTs(),
      preloadKeyBatchOpenTs: preloadCtrl.getPreloadKeyBatchOpenTs(),
      resolverTrace,
      resolverSnapshot: nonReleaseSnapshot,
      discoverPreloadEpochTargets: preloadCtrl.getPreloadEpochTargets(),
      resolveTrackCacheKey,
      resolvePreloadTargetKey,
      playlistBpmByCacheKey,
      playlistKeyAnalysisByCacheKey,
      playlistAnalyzingCacheKeys,
      playlistFailedCacheKeys,
      playlistAttemptCountByCacheKey,
      preloadEpochFailedCacheKeys: preloadCtrl.getPreloadEpochFailedCacheKeys(),
      preloadKeyFailedCacheKeys: preloadCtrl.getPreloadKeyFailedCacheKeys(),
      preloadDeferredRetryUntilByCacheKey: preloadCtrl.getPreloadDeferredRetryUntilByCacheKey(),
      preloadDebug: preloadCtrl.preloader.getDebugState(),
      preloadBlockedReason: preloadCtrl.getPreloadBlockedReason(),
      preloadKeyBlockedReason: preloadCtrl.getPreloadKeyStartupBlockReason(),
      preloadBpmBatchSettled: preloadCtrl.getPreloadBpmBatchSettled(),
      preloadKeyQueueLength: preloadCtrl.getPreloadKeyQueueLength(),
      preloadKeyInFlightTargetKey: preloadCtrl.getPreloadKeyInFlightTargetKey(),
      metadataDebugLastDecision,
      releasePrewarmDebug,
      runtimeAudioEngineDebug: runtimeAudioEngine.getDebugSnapshot(),
      runtimePlaybackOwned,
      runtimeOwnershipDebug,
      discoverPlaybackMode,
      resourceDiagnostics: resourceDiagnostics?.getDebugState() ?? null,
      refreshLikeSnapshot
    });
  let pushDebug: (title: string, sectionsFactory: DebugSectionsFactory) => void = () => {};

  render = (): void => {
    if (extensionDeactivated) {
      return;
    }
    preloadCtrl.applyPlaylistAnalysisDecorations();
    refreshLikeSnapshot();
    const renderStartedAt = performance.now();
    const input = buildPanelInput();
    updateLikeDebugDocumentAttrs(likesDebug, input.likeState, input.playlist);
    const panelStartedAt = performance.now();
    panel.update(input);
    const panelUpdatedAt = performance.now();
    let debugSnapshotMs = 0;
    pushDebug(DISCOVER_DEBUG_PANEL_TITLE, () => {
      const debugStartedAt = performance.now();
      const sections = buildDebugSections();
      debugSnapshotMs = performance.now() - debugStartedAt;
      return sections;
    });
    const renderFinishedAt = performance.now();
    const previousRenderCount = uiPerformanceDebug.render?.renderCount || 0;
    uiPerformanceDebug.render = {
      panelUpdateMs: panelUpdatedAt - panelStartedAt,
      debugSnapshotMs,
      totalRenderMs: renderFinishedAt - renderStartedAt,
      renderCount: previousRenderCount + 1,
      lastRenderAt: Date.now()
    };
    preloadCtrl.syncDiscoverPreloadQueue();
    maybeStartNowPlayingAnalysis('render-context');
  };

  resourceDiagnostics = createResourceDiagnosticsController({
    setHostPerfSampling: (enabled) => runtimeAudioController?.setHostPerfSampling(enabled),
    collectHostPerfSnapshots: () =>
      runtimeAudioController?.collectHostPerfSnapshots() ?? Promise.resolve([])
  });
  debugPanel = createDebugPanel(
    () => ({
      title: DISCOVER_DEBUG_PANEL_TITLE,
      sections: buildDebugSections()
    }),
    { onVisibilityChange: (visible) => resourceDiagnostics?.setPanelOpen(visible) }
  );
  pushDebug = createThrottledDebugPush(debugPanel, 250);

  const cancelPlaylistRetries = (): void => {
    if (playlistPollId !== null) {
      window.clearTimeout(playlistPollId);
      playlistPollId = null;
    }
  };

  const resolveDiscoverSnapshot = (
    targetNowPlaying: DiscoverNowPlaying,
    allowApiFetch: boolean
  ): NonReleaseResolverSnapshot => {
    const currentSrc = String(targetNowPlaying.streamUrl || '').trim();
    const hintedTrackId = String(targetNowPlaying.trackId || '').trim();
    const hintedIdentity = targetNowPlaying.identity;
    if (hintedTrackId && hintedIdentity) {
      upsertResolvedIdentityForTrack(hintedTrackId, {
        bandId: hintedIdentity.bandId,
        tralbumId: hintedIdentity.tralbumId,
        tralbumType: hintedIdentity.tralbumType
      });
    }
    const canReuse =
      Boolean(
        nonReleaseSnapshot &&
        nonReleaseSnapshot.currentSrc === currentSrc &&
        (!allowApiFetch || nonReleaseSnapshot.source.allowApiFetch) &&
        nonReleaseSnapshot.source.tralbumSource !== 'none' &&
        !nonReleaseSnapshot.source.staleTrack &&
        nonReleaseSnapshot.playlist.tracks.length > 0 &&
        nonReleaseSnapshot.playlist.sortKey === playlistState.sortKey &&
        nonReleaseSnapshot.playlist.sortAsc === playlistState.sortAsc &&
        nonReleaseSnapshot.playlist.expanded === playlistState.expanded
      );
    if (canReuse && nonReleaseSnapshot) {
      return nonReleaseSnapshot;
    }
    nonReleaseSnapshot = resolveNonReleaseResolverSnapshot({
      context: 'discover',
      previous: playlistState,
      currentSrc,
      allowApiFetch,
      preferApi: true,
      includePageUrl: true
    });
    return nonReleaseSnapshot;
  };

  const refreshMetadataPhase = (runId: number, targetNowPlaying: DiscoverNowPlaying, allowApiFetch: boolean): void => {
    if (runId !== playlistRunId) {
      return;
    }

    const snapshot = resolveDiscoverSnapshot(targetNowPlaying, allowApiFetch);
    const phaseResult = runDiscoverMetadataPhase({
      snapshot,
      targetNowPlaying
    });
    metadata = phaseResult.metadata;
    metadataDebugLastDecision = phaseResult.metadataDebugLastDecision;
    maybeStartNowPlayingAnalysis(`metadata:${runId}`);
  };
  const resolvePlaylistAttemptGateReason = (input: {
    hasUsableTracks: boolean;
    hasTracks: boolean;
    playlistSource: string;
  }): string => {
    if (input.hasUsableTracks) {
      return 'strict-match';
    }
    if (input.playlistSource.includes('stale-track')) {
      return 'stale-track';
    }
    if (input.playlistSource.includes('none(no-stream)')) {
      return 'no-stream';
    }
    if (input.playlistSource.startsWith('none')) {
      return 'no-tralbum';
    }
    return input.hasTracks ? 'track-mismatch' : 'empty-tracklist';
  };

  const runPlaylistAttempt = (
    runId: number,
    attemptNowPlaying: DiscoverNowPlaying,
    allowApiFetch: boolean,
    isFinalAttempt = false,
    trigger: 'immediate' | 'poll' = 'immediate'
  ): void => {
    if (runId !== playlistRunId) {
      return;
    }

    const attemptStartTs = Date.now();
    const sourceTrackId = readTrackIdFromUrl(attemptNowPlaying.streamUrl) || String(attemptNowPlaying.trackId || '').trim();
    const cachedTralbum = getCachedApiTralbum(getLatestPageGlobals(), attemptNowPlaying.streamUrl);
    const cacheReadyAtStart = Boolean(
      cachedTralbum && sourceTrackId && tralbumMatchesCurrentTrack(cachedTralbum, sourceTrackId, attemptNowPlaying.streamUrl)
    );

    const snapshot = resolveDiscoverSnapshot(attemptNowPlaying, allowApiFetch);
    playlistState = applyPlaylistSort(snapshot.playlist);
    playlistSource = snapshot.playlistSource;
    hintDebug = buildHintDebug(attemptNowPlaying);
    refreshMetadataPhase(runId, attemptNowPlaying, allowApiFetch);

    const hasTracks = playlistState.tracks.length > 0;
    const hasCurrentTrack = playlistContainsSourceTrack(playlistState.tracks, attemptNowPlaying.streamUrl, {
      normalizeUrlForCompare: normalizeUrl
    });
    const hasUsableTracks = hasTracks && hasCurrentTrack;
    const unresolvedSource = isDiscoverPlaylistUnresolved(playlistSource, playlistState);
    const probe = getRootPlaylistProbeStatus(attemptNowPlaying.streamUrl);
    const fetchGateDebug = getTrackFetchGateDebug(sourceTrackId);
    const fetchGateReason = readFetchGateReason(fetchGateDebug);
    const fetchGateRetryDelayMs = readFetchGateRetryDelayMs(fetchGateDebug);
    const gateReason = resolvePlaylistAttemptGateReason({
      hasUsableTracks,
      hasTracks,
      playlistSource
    });
    appendResolverTrace(
      'attempt',
      `trigger=${trigger} allowApi=${allowApiFetch ? 1 : 0} cacheReady=${cacheReadyAtStart ? 1 : 0} trackId=${sourceTrackId || '-'} source=${playlistSource} tracks=${playlistState.tracks.length} current=${playlistState.currentIndex} usable=${hasUsableTracks ? 1 : 0} gate=${gateReason} probe=${probe.reason}:${probe.nextCheckMs} fetchGate=${fetchGateDebug} duration=${Date.now() - attemptStartTs}ms`
    );

    cancelPlaylistRetries();
    const hasTimedFetchGateRetry = !hasUsableTracks && unresolvedSource && fetchGateRetryDelayMs > 0;
    const usesTimedFetchGateRetry = hasTimedFetchGateRetry && !probe.pending;
    if (probe.pending || usesTimedFetchGateRetry) {
      const backpressured =
        fetchGateReason === 'request-start' ||
        fetchGateReason === 'in-flight';
      const nextPollDelayMs = usesTimedFetchGateRetry
        ? Math.max(180, fetchGateRetryDelayMs + 80)
        : backpressured
          ? Math.max(Math.max(180, probe.nextCheckMs || 450), DISCOVER_API_INFLIGHT_BACKPRESSURE_MS)
          : Math.max(180, probe.nextCheckMs || 450);
      const retryStreamUrl = String(attemptNowPlaying.streamUrl || '').trim();
      if (usesTimedFetchGateRetry) {
        appendResolverTrace(
          'timed-gate-retry',
          `reason=${fetchGateReason} delay=${nextPollDelayMs}ms trackId=${sourceTrackId || '-'}`
        );
      }
      playlistPollId = window.setTimeout(() => {
        if (runId !== playlistRunId) {
          return;
        }
        const latestNowPlaying = getDiscoverNowPlaying();
        if (
          usesTimedFetchGateRetry &&
          retryStreamUrl &&
          normalizeUrl(String(latestNowPlaying.streamUrl || '').trim()) !== normalizeUrl(retryStreamUrl)
        ) {
          appendResolverTrace(
            'timed-gate-drop',
            `reason=stale-stream expected=${retryStreamUrl} actual=${String(latestNowPlaying.streamUrl || '').trim() || '-'}`
          );
          playlistPollId = null;
          return;
        }
        const unresolved =
          isDiscoverPlaylistUnresolved(playlistSource, playlistState) ||
          !playlistContainsSourceTrack(playlistState.tracks, latestNowPlaying.streamUrl, {
            normalizeUrlForCompare: normalizeUrl
          });
        const now = Date.now();
        const fastPath = hasDiscoverApiFastPathHints(latestNowPlaying);
        const refreshIntervalMs = fastPath
          ? DISCOVER_PROBE_API_REFRESH_FAST_INTERVAL_MS
          : DISCOVER_PROBE_API_REFRESH_INTERVAL_MS;
        const latestTrackId =
          readTrackIdFromUrl(String(latestNowPlaying.streamUrl || '').trim()) ||
          String(latestNowPlaying.trackId || '').trim();
        const latestFetchGateReason = readFetchGateReason(getTrackFetchGateDebug(latestTrackId));
        const apiInFlight =
          latestFetchGateReason === 'request-start' ||
          latestFetchGateReason === 'in-flight';
        const allowApiFetch =
          unresolved &&
          !apiInFlight &&
          (usesTimedFetchGateRetry || fastPath || now - lastDiscoverProbeApiRefreshAt >= refreshIntervalMs);
        if (allowApiFetch) {
          lastDiscoverProbeApiRefreshAt = now;
        }
        runPlaylistAttempt(runId, latestNowPlaying, allowApiFetch, false, 'poll');
      }, nextPollDelayMs);
    }

    const hasPendingPoll = playlistPollId !== null;
    const exhausted =
      isFinalAttempt &&
      !hasUsableTracks &&
      !probe.pending &&
      !hasPendingPoll &&
      unresolvedSource;
    if (exhausted) {
      if (!playlistSource.includes('exhausted')) {
        playlistSource = playlistSource.startsWith('none') ? 'none(exhausted)' : `${playlistSource}|exhausted`;
      }
    }

    playlistState = {
      ...playlistState,
      loading: !hasUsableTracks && (probe.pending || hasPendingPoll || unresolvedSource)
    };

    if (hasUsableTracks && likeCtrl.getPendingLikeSyncAfterPlaylistReady()) {
      likeCtrl.requestLikeSyncIfActive();
    }

    if (hasUsableTracks) {
      const albumReleaseUrl = normalizePlaylistAlbumReleaseUrl(attemptNowPlaying.releaseUrl);
      if (albumReleaseUrl) {
        playlistAlbumReleaseUrl = albumReleaseUrl;
      }
      warmRuntimeAudioForPlaylistTracks();
    }

    maybeStartNowPlayingAnalysis(`playlist:${runId}`);
    render();
  };

  const startPlaylistRun = (triggerNowPlaying: DiscoverNowPlaying): void => {
    playlistRunId += 1;
    const runId = playlistRunId;
    appendJumpTrace(
      'playlist-run-start',
      `run=${runId} src=${String(triggerNowPlaying.streamUrl || '').trim() || '-'} release=${String(triggerNowPlaying.releaseUrl || '').trim() || '-'}`
    );
    lastDiscoverProbeApiRefreshAt = 0;
    playlistAlbumReleaseUrl = '';
    nonReleaseSnapshot = null;
    cancelPlaylistRetries();
    prewarmDiscoverRelease(triggerNowPlaying.releaseUrl, 'playlist-run');

    if (triggerNowPlaying.streamUrl) {
      notifyTrackSwitch(triggerNowPlaying.streamUrl);
      syncRuntimeAudioSource(triggerNowPlaying.streamUrl);
    }

    runPlaylistAttempt(runId, triggerNowPlaying, true, false, 'immediate');
  };
  const resolveDiscoverPlaylistReuseDecision = (
    next: DiscoverNowPlaying,
    previous: DiscoverNowPlaying
  ): {
    sourceInsideCurrentPlaylist: boolean;
    sameReleaseAsCurrent: boolean;
    releaseCompatibleWithPlaylist: boolean;
    canReuseExistingPlaylist: boolean;
  } => {
    const nextAlbumReleaseUrl = normalizePlaylistAlbumReleaseUrl(next.releaseUrl);
    const previousAlbumReleaseUrl = normalizePlaylistAlbumReleaseUrl(previous.releaseUrl);
    const hasComparablePlaylistRelease = Boolean(nextAlbumReleaseUrl && playlistAlbumReleaseUrl);
    const releaseCompatibleWithPlaylist =
      !hasComparablePlaylistRelease || nextAlbumReleaseUrl === playlistAlbumReleaseUrl;
    const sourceInsideCurrentPlaylist =
      releaseCompatibleWithPlaylist &&
      playlistState.tracks.length > 0 &&
      playlistContainsSourceTrack(playlistState.tracks, next.streamUrl, {
        normalizeUrlForCompare: normalizeUrl
      });
    const sameReleaseAsCurrent =
      releaseCompatibleWithPlaylist &&
      playlistState.tracks.length > 0 &&
      Boolean(nextAlbumReleaseUrl) &&
      nextAlbumReleaseUrl === previousAlbumReleaseUrl;

    return {
      sourceInsideCurrentPlaylist,
      sameReleaseAsCurrent,
      releaseCompatibleWithPlaylist,
      canReuseExistingPlaylist: sourceInsideCurrentPlaylist || sameReleaseAsCurrent
    };
  };

  const syncFromDiscover = (): void => {
    if (extensionDeactivated) {
      return;
    }
    const latestEndedEvent = getLatestObservedDiscoverAudioEnded(10_000);
    const expectedEndedSource = String(
      nowPlaying.streamUrl ||
      lastRuntimePlaybackState?.src ||
      playlistState.tracks[playlistState.currentIndex]?.streamUrl ||
      ''
    ).trim();
    const hasUnhandledEndedEvent = Boolean(
      latestEndedEvent &&
      latestEndedEvent.ts > lastHandledDiscoverEndedAt &&
      latestEndedEvent.src &&
      expectedEndedSource &&
      sourcesShareTrackIdentity(latestEndedEvent.src, expectedEndedSource)
    );
    if (hasUnhandledEndedEvent && latestEndedEvent) {
      lastHandledDiscoverEndedAt = latestEndedEvent.ts;
      if (maybeAutoAdvanceDiscoverPlaylist(runtimePlaybackOwned ? 'runtime-ended' : 'origin-ended')) {
        return;
      }
      nowPlaying = {
        ...nowPlaying,
        currentTimeSec: Number(nowPlaying.durationSec || latestEndedEvent.durationSec || nowPlaying.currentTimeSec || 0),
        durationSec: Number(nowPlaying.durationSec || latestEndedEvent.durationSec || 0),
        isPlaying: false,
        playbackTs: 0
      };
      render();
      return;
    }
    const nextNowPlaying = mergeDetachedModeNowPlaying(mergeRuntimeOwnedNowPlaying(getDiscoverNowPlaying()));
    const nextSourceInsideCurrentPlaylist = playlistContainsSourceTrack(playlistState.tracks, nextNowPlaying.streamUrl, {
      normalizeUrlForCompare: normalizeUrl
    });
    if (nextSourceInsideCurrentPlaylist) {
      setReleasePrewarmDebug('playlist-cache', 'sync', nextNowPlaying.releaseUrl);
    } else {
      prewarmDiscoverRelease(nextNowPlaying.releaseUrl, 'sync');
    }
    playbackHandoff.reportPlaybackState(Boolean(nextNowPlaying.isPlaying), nextNowPlaying.streamUrl);
    const gateOpen = Boolean(nextNowPlaying.streamUrl);
    if (!gateOpen) {
      // Discover idle gate: do not surface mediaSession leftovers after page refresh.
      // Until an origin-site play provides a real stream URL, keep panel in default idle state.
      cancelPlaylistRetries();
      playlistRunId += 1;
      analysisRunId += 1;
      tempoRunId += 1;
      analysisReqCtrl.cancelTempo();
      analysisReqCtrl.resetRequestKeys();
      clearAllTrackAnalyzing();
      preloadCtrl.preloader.cancel();
      preloadCtrl.resetDiscoverPreloadBpmEpoch();
      preloadCtrl.clearPreloadKeyFailedCacheKeys();
      preloadCtrl.resetDiscoverPreloadFailureEpoch();
      preloadCtrl.cancelDiscoverPreloadKeyPass();
      lastTrackKey = '';
      lastRuntimeSyncedSourceUrl = '';
      pendingManualRuntimeSyncSourceUrl = '';
      hintDebug = '-';
      resetTempoAdjustSession('idle-gate', { applyToPlayback: false });
      nowPlaying = nextNowPlaying;
      metadata = { ...DEFAULT_TRACK_METADATA };
      analysis = null;
      playlistState = {
        ...DEFAULT_PLAYLIST_STATE,
        tracks: [],
        expanded: playlistState.expanded,
        loading: false
      };
      playlistSource = 'waiting-for-origin-play';
      playlistAlbumReleaseUrl = '';
      nonReleaseSnapshot = null;
      appendJumpTrace('idle-gate', 'waiting-for-origin-play');
      render();
      return;
    }

    const prevNowPlaying = nowPlaying;
    const trackKey = buildDiscoverTrackKey(nextNowPlaying);

    if (trackKey !== lastTrackKey) {
      appendJumpTrace(
        'track-key-change',
        `from=${lastTrackKey || '-'} to=${trackKey} src=${String(nextNowPlaying.streamUrl || '').trim() || '-'}`
      );
      // A real track change invalidates any in-flight seek hold: its target
      // belonged to the previous track.
      pendingSeekFraction = null;
      pendingSeekAtMs = 0;
      analysisReqCtrl.cancelAll();
      analysisReqCtrl.resetRequestKeys();
      resetTempoAdjustSession('track-key-change', { applyToPlayback: false });
      const hadPriorTrack = Boolean(lastTrackKey);
      const {
        sourceInsideCurrentPlaylist,
        sameReleaseAsCurrent,
        releaseCompatibleWithPlaylist,
        canReuseExistingPlaylist
      } = resolveDiscoverPlaylistReuseDecision(nextNowPlaying, prevNowPlaying);
      const shouldResetLikesForOriginSwitch = hadPriorTrack && !canReuseExistingPlaylist;

      // Discover jumps within the same resolved playlist should only realign current track.
      // Full reset/re-resolve is reserved for origin switches outside the current playlist.
      if (canReuseExistingPlaylist) {
        appendJumpTrace(
          'track-jump-reuse',
          `src=${String(nextNowPlaying.streamUrl || '').trim() || '-'} sameRelease=${sameReleaseAsCurrent ? '1' : '0'} inPlaylist=${sourceInsideCurrentPlaylist ? '1' : '0'} releaseCompatible=${releaseCompatibleWithPlaylist ? '1' : '0'} playlistAlbumRelease=${playlistAlbumReleaseUrl || '-'}`
        );
        lastTrackKey = trackKey;
        nowPlaying = nextNowPlaying;
        metadata = { ...DEFAULT_TRACK_METADATA };
        const nextIndex = findPlaylistTrackIndexBySource(playlistState.tracks, nextNowPlaying.streamUrl, {
          normalizeUrlForCompare: normalizeUrl
        });
        if (nextIndex >= 0) {
          playlistState = withCurrentPlaylistIndex(playlistState, nextIndex);
          seedAnalysisFromSelectedDiscoverTrack(playlistState.tracks[nextIndex] || null, nextNowPlaying.streamUrl, 'bridge-sync');
        } else {
          analysis = null;
        }
        refreshMetadataPhase(playlistRunId, nextNowPlaying, false);
        const settledManualSelection = Boolean(
          pendingManualRuntimeSyncSourceUrl &&
          sourcesShareTrackIdentity(pendingManualRuntimeSyncSourceUrl, nextNowPlaying.streamUrl)
        );
        pendingManualRuntimeSyncSourceUrl = '';
        if (!settledManualSelection) {
          syncRuntimeAudioSource(nextNowPlaying.streamUrl);
        }
        playlistState = {
          ...playlistState,
          loading: false
        };
        if (likeCtrl.getPendingLikeSyncAfterPlaylistReady()) {
          likeCtrl.requestLikeSyncIfActive();
        }
        maybeStartNowPlayingAnalysis(trackKey);
        render();
        return;
      }

      appendJumpTrace(
        'track-jump-reset',
        `src=${String(nextNowPlaying.streamUrl || '').trim() || '-'} previousRelease=${String(prevNowPlaying.releaseUrl || '').trim() || '-'} nextRelease=${String(nextNowPlaying.releaseUrl || '').trim() || '-'}`
      );
      lastTrackKey = trackKey;
      pendingManualRuntimeSyncSourceUrl = '';
      nowPlaying = nextNowPlaying;
      metadata = { ...DEFAULT_TRACK_METADATA };
      analysis = null;
      preloadCtrl.preloader.cancel();
      preloadCtrl.resetDiscoverPreloadBpmEpoch();
      preloadCtrl.clearPreloadKeyFailedCacheKeys();
      preloadCtrl.resetDiscoverPreloadFailureEpoch();
      preloadCtrl.cancelDiscoverPreloadKeyPass();
      clearAllTrackAnalyzing();
      playlistBpmByCacheKey.clear();
      playlistWaveformByCacheKey.clear();
      playlistFailedCacheKeys.clear();
      playlistAttemptCountByCacheKey.clear();
      playlistState = {
        ...DEFAULT_PLAYLIST_STATE,
        tracks: [],
        expanded: playlistState.expanded,
        loading: true
      };
      playlistSource = 'switching(origin-track)';
      playlistAlbumReleaseUrl = '';
      nonReleaseSnapshot = null;
      if (shouldResetLikesForOriginSwitch) {
        // Reset after installing the next origin so the cleared like view is
        // computed against the new empty/switching state, not the previous album.
        likeCtrl.resetLikesForOriginJump('discover:origin-switch');
      }
      render();
      startPlaylistRun(nextNowPlaying);
      return;
    }

    nowPlaying = nextNowPlaying;

    const hasStaleTracks =
      playlistState.tracks.length > 0 &&
      !playlistContainsSourceTrack(playlistState.tracks, nextNowPlaying.streamUrl, {
        normalizeUrlForCompare: normalizeUrl
      });

    if (!playlistState.loading && (playlistState.tracks.length === 0 || hasStaleTracks)) {
      const nowMs = Date.now();
      if (nowMs - lastEmptyRecoveryAt >= DISCOVER_EMPTY_RECOVERY_INTERVAL_MS) {
        lastEmptyRecoveryAt = nowMs;
        startPlaylistRun(nextNowPlaying);
        return;
      }
    }

    render();
  };

  const stopWatch = watchDiscoverMetadata(() => {
    syncFromDiscover();
    likeCtrl.requestLikeSyncIfActive();
  });

  const stopDebugCacheReset = subscribeDebugClearCaches(() => {
    if (extensionDeactivated) {
      return;
    }
    clearMetadataRuntimeCaches();
    playlistBpmByCacheKey.clear();
    playlistWaveformByCacheKey.clear();
    playlistKeyAnalysisByCacheKey.clear();
    playlistFailedCacheKeys.clear();
    playlistAttemptCountByCacheKey.clear();
    cancelPlaylistRetries();
    preloadCtrl.preloader.cancel();
    preloadCtrl.resetDiscoverPreloadBpmEpoch();
    preloadCtrl.clearPreloadKeyFailedCacheKeys();
    preloadCtrl.resetDiscoverPreloadFailureEpoch();
    preloadCtrl.cancelDiscoverPreloadKeyPass();
    clearAllTrackAnalyzing();
    hintDebug = '-';
    metadataDebugLastDecision = '-';
    analysis = null;
    lastRuntimeSyncedSourceUrl = '';
    pendingManualRuntimeSyncSourceUrl = '';
    resetTempoAdjustSession('debug-cache-reset', { applyToPlayback: false });
    metadata = { ...DEFAULT_TRACK_METADATA };
    playlistState = {
      ...DEFAULT_PLAYLIST_STATE,
      tracks: [],
      expanded: playlistState.expanded,
      loading: true
    };
    playlistSource = 'debug-cache-reset';
    playlistAlbumReleaseUrl = '';
    nonReleaseSnapshot = null;
    lastTrackKey = '';
    likesController.resetMutationViewCaches('debug-cache-reset');
    render();
    startPlaylistRun(getDiscoverNowPlaying());
    likeCtrl.requestLikeSyncIfActive();
  });

  const statePollId = window.setInterval(() => {
    if (playlistSource === 'waiting-for-origin-play' && !nowPlaying.streamUrl) {
      return;
    }
    sendDiscoverAudioCommand('request-state');
    syncFromDiscover();
    likeCtrl.requestLikeSyncIfActive();
  }, 900);
  const preloadCoverageAuditId = window.setInterval(() => {
    if (playlistState.tracks.length <= 1) {
      return;
    }
    preloadCtrl.syncDiscoverPreloadQueue();
  }, DISCOVER_PRELOAD_AUDIT_INTERVAL_MS);
  const likesRefreshClockId = window.setInterval(() => {
    likeCtrl.maybeStartScheduledDeepLikeSync();
  }, LIKES_DEEP_SYNC_POLL_INTERVAL_MS);

  const deactivateExtension = (): void => {
    if (extensionDeactivated) {
      return;
    }
    extensionDeactivated = true;
    stopWatch();
    stopDebugCacheReset();
    window.clearInterval(statePollId);
    window.clearInterval(preloadCoverageAuditId);
    window.clearInterval(likesRefreshClockId);
    cancelPlaylistRetries();
    analysisReqCtrl.cancelTempo();
    likeCtrl.clearNoticeTimer();
    preloadCtrl.preloader.cancel();
    preloadCtrl.preloader.setEnabled(false);
    preloadCtrl.resetDiscoverPreloadBpmEpoch();
    preloadCtrl.clearPreloadKeyFailedCacheKeys();
    preloadCtrl.resetDiscoverPreloadFailureEpoch();
    preloadCtrl.cancelDiscoverPreloadKeyPass();
    tempoRunId += 1;
    analysisRunId += 1;
    playlistRunId += 1;
    runtimeSourceVersion += 1;
    runtimePlaylistWarmToken += 1;
    runtimePlaylistWarmActive = false;
    runtimePlaylistWarmSignature = '';
    runtimePlaylistPrepareInFlight.clear();
    runtimeAudioController?.destroy();
    runtimeAudioEngine.destroy();
    sendDiscoverAudioCommand('pause');
    playbackHandoff.reportPlaybackState(false, nowPlaying.streamUrl);
    playbackHandoff.destroy();
    panel.destroy();
    debugPanel?.destroy();
    resourceDiagnostics?.destroy();
    resourceDiagnostics = null;
  };

  window.addEventListener('beforeunload', () => {
    deactivateExtension();
  });

  syncFromDiscover();
  likeCtrl.requestLikeSyncIfActive();
}
