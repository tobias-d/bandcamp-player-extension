/**
 * Player orchestrator — runs on album/track/collection/fan pages.
 *
 * Structure:
 *   Header                  Imports and top-level constants
 *   init() setup            State, settings, runtime, likes, analysis, and panel wiring
 *   Like identity region    Album/track identity locking, trust checks, and view-state resets
 *   Analysis/render region  BPM/key/waveform callbacks, playlist decoration, and render scheduling
 *   Runtime audio region    Tempo Adjust preparation, SignalSmith predecode, and playback handoff
 *   applySourceChange()     Source-event application; classification lives in source-transition.ts
 *   syncBridgeAudioState()  Bridge polling, native/runtime ownership sync, timers, and cleanup
 */
import {
  notifyTrackSwitch,
  watchMetadataChanges
} from '@/content/metadata/extractor';
import { getCachedApiTralbum } from '@/content/metadata/extractor/api/cache';
import {
  DEFAULT_LIKE_VIEW_STATE,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import { resolveRuntimePredecodePolicy } from '@/shared/runtime-predecode-policy';
import type {
  AnalysisResult,
  KeyAnalysisResult,
  LikeIdentity,
  LikeState,
  LikeViewState,
  PanelHandlers,
  PlaylistTrack
} from '@/shared/types';
import {
  createThrottledDebugPush
} from '@/content/debug/debugger';
import {
  ensureOriginBridge,
  getLatestObservedDiscoverAudioState,
  getLatestOwnedPlaybackHostState,
  getLatestPageGlobals,
  requestOwnedPlaybackHostState,
  sendDiscoverAudioCommand
} from '@/content/discover/origin-bridge';
import { tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import type { TralbumLike } from '@/content/metadata/extractor/types';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import { findNextPlayableIndexWithoutWrap, isTrackPlayable } from '@/content/playlist/track-navigation';
import {
  isBpmAnalysisInProgressForSource,
  resolveKeyStatusFromAnalysis
} from '@/content/analysis/current-session-helpers';
import { createAnalysisRequestController } from '@/content/analysis/analysis-request-controller';
import { createAudioBridge, type AudioBridge } from '@/content/player/audio-bridge';
import {
  createRuntimeAudioController,
  type RuntimeAudioController
} from '@/content/player/runtime-audio/controller';
import { createRuntimeAudioEngine } from '@/content/player/runtime-audio/engine';
import { createBpmPrototypeController } from '@/content/player/bpm-prototype';
import { createKeyTuningController } from '@/content/player/key-tuning';
import {
  applyPlayerTempoAdjust,
  resetPlayerTempoAdjustSession
} from '@/content/player/tempo-adjust';
import { createPlaybackHandoff } from '@/content/playback-handoff';
import {
  createPlaylistAnalysisCache,
  createPlaylistAnalysisCacheFacade
} from '@/content/playlist/analysis-cache';
import {
  createLikeController,
  formatLikeIdentityDebug,
  cloneLikeViewState,
  summarizeLikeViewStateCounts,
  resolveActiveTrackIndexForLikeDebug,
  formatPlaylistTrackLikeDebug
} from '@/content/player/like-controller';
import { createPreloadController } from '@/content/player/preload-controller';
import { resolveWorkerCount, deriveConcurrencyConfig } from '@/shared/concurrency';
import {
  findPlaylistTrackIndexBySource,
  normalizeCacheKey,
  playlistContainsSourceTrack,
  resolveSourceTrackCacheKey,
  sourcesShareTrackIdentity
} from '@/content/playlist/track-identity';
import { detectPageContext, resolveLikeMutationRuntimeContext, shouldUseApiOnlyLikeIdentity } from '@/content/page-context';
import {
  armPlaylistJumpLock,
  createPlayerPanelHandlers
} from '@/content/player/panel-handlers';
import { createPlaylistProbeController } from '@/content/player/playlist-probe';
import { createDeferredRefreshController } from '@/content/player/deferred-refresh';
import {
  isAuthoritativeSourceEvent,
  resolveSourceEventAcceptance
} from '@/content/player/source-change-guards';
import { classifySourceTransition } from '@/content/player/source-transition';
import { buildDebugSections, scheduleRender } from '@/content/player/render';
import type { DebugSectionsFactory } from '@/shared/debug-trace';
import { PlayerState } from '@/content/player/state';
import {
  applyCurrentPlaylistTrackMetadata,
  applyPlaylistAlignment,
  applyPlaylistCurrentIndex,
  buildPanelInput,
  ensurePlaybackGateStarted,
  isMetadataResolutionAlignedWithSource,
  refreshMetadata,
  refreshPlaylist,
  setCurrentSource
} from '@/content/player/state-sync';
import {
  LikesStatusController,
  resolveReleaseLikeIdentityFromGlobals
} from '@/content/likes/inventory';
import { trackStatesEqual } from '@/content/likes/inventory-helpers';
import { pushLikeProcessEvent } from '@/content/likes/mutation-debug';
import {
  evaluateTrackLikeIdentityTrust,
  isTrustedPlaylistLikeSource,
  normalizeLikeId,
  toCanonicalLikeUrl
} from '@/content/likes/state';
import { getCachedAlbumIdentityForReleaseUrl, getResolvedIdentityForTrack } from '@/content/metadata/extractor/probe-state';
import { clearMetadataRuntimeCaches } from '@/content/metadata/extractor/state';
import { getNowPlayingDomReleaseIdentity, getNowPlayingLinkedReleaseUrl } from '@/content/metadata/release';
import { startRuntimeTimers } from '@/content/player/runtime-timers';
import {
  recordBridgeEvent,
  recordGuard,
  recordPlaylistAlign,
  recordSelection,
  recordUiAction
} from '@/content/player/transport-log';
import { createSettingsController } from '@/content/settings/settings-controller';
import { subscribeDebugClearCaches } from '@/shared/debug-cache-reset';
import { showResultsPanel, type ResultsPanelController } from '@/ui/panel';
import { appendKeyAnalysisTrace } from '@/content/debug/key-analysis-trace';
import { createDebugPanel, type DebugPanelController } from '@/ui/debug-panel';
import {
  createResourceDiagnosticsController,
  type ResourceDiagnosticsController
} from '@/content/debug/resource-diagnostics';

const METADATA_SWITCH_SETTLE_DELAY_MS = 220;
const ROOT_METADATA_FIRST_WINDOW_MS = 900;
const ROOT_PLAYLIST_RETRY_SEQUENCE_MS = [650, 1800, 4200] as const;
const EXTERNAL_SOURCE_GUARD_MS = 3_000;
const PAGE_RELEASE_CONFIRM_MS = 320;
const PRELOAD_AUDIT_INTERVAL_MS = 12_000;
const PLAYHEAD_TICK_INTERVAL_MS = 45;
const MAX_ANALYSIS_ATTEMPTS_PER_TRACK = 4;
const STALE_BRIDGE_SOURCE_GUARD_MS = 1200;
const ROOT_PROBE_API_REFRESH_INTERVAL_MS = 1800;
const STRICT_ORIGIN_REBIND_WINDOW_MS = 2500;
const AUTO_ADVANCE_DEDUP_MS = 1500;
// Runtime-start health signals surfaced as counted incident warnings so a fix can
// be judged by numbers, not by ear.
//
// NOTE: first-window `step` (max sample-to-sample delta) was tried as a crack
// detector and FALSIFIED: a clean but loud onset measures step≈0.5 while the real
// captured slow-machine crack was only step=0.186. Step tracks onset brightness,
// not discontinuity, so it is no longer a warning (the value is still printed in the
// host-first-window line for reference).
//
// peak>1.0 is genuine post-gain clipping and stays a warning. The real load-side
// risk is a stall in the load path (a GC/CPU pause), so a host-load-stall maxGapMs
// beyond what the protective fade+gate windows can hide is the actionable signal.
const RUNTIME_FIRST_WINDOW_PEAK_WARN = 1;
const RUNTIME_LOAD_STALL_WARN_MS = 400;

function init(): void {
  const pageContext = detectPageContext({
    pageGlobals: getLatestPageGlobals(60_000)
  });
  if (!pageContext.shouldRunPlayerScript) {
    return;
  }

  ensureOriginBridge();
  requestOwnedPlaybackHostState();
  const pageType = pageContext.pageType;
  const rootLikePage = pageContext.isRootLike;
  const feedLikePage = pageType === 'feed';
  const fanRootDecoupleMode = pageContext.isFanRoot;
  const fanRootApiMode = pageContext.isFanRoot;

  const state = new PlayerState();
  const settings = createSettingsController({
    onPreloadTracksChanged() {
      if (!settings.preloadTracksEnabled) {
        preloadCtrl.clearPreloadKeyFailedCacheKeys();
        resetPreloadFailureEpoch();
        cancelPreloadKeyPass();
      }
      syncPreloadQueue(state.sourceVersion);
    },
    onKeyAnalysisChanged(enabled) {
      if (!enabled) {
        playlistKeyAnalysisByCacheKey.clear();
        preloadCtrl.clearPreloadKeyFailedCacheKeys();
        resetPreloadFailureEpoch();
        cancelPreloadKeyPass();
        state.lastAnalysis = state.lastAnalysis
          ? { ...state.lastAnalysis, keyAnalysis: undefined, keyStatus: 'disabled', ts: Date.now() }
          : state.lastAnalysis;
      }
      analysisReqCtrl.cancelAll();
      analysisReqCtrl.resetRequestKeys();
      runtimePrepareInFlightKey = '';
      runtimePrepareInFlightSource = '';
      playlistWarmToken += 1;
      activePlaylistRuntimePredecodeSignature = '';
      playlistRuntimePredecodeInFlightKeys.clear();
      playlistRuntimePredecodeInFlightSources.clear();
      applyPlaylistAnalysisDecorations();
      syncPreloadQueue(state.sourceVersion);
      maybeStartCurrentSourceAnalysis(state.sourceVersion);
      requestRender();
    },
    onLiteModeChanged() {
      // Switching either direction re-kicks analysis for the current source: ON drops to the
      // waveform-only path (no BPM), OFF resumes the full tempo pass. Reset the dedup keys so the
      // re-kick is not swallowed as a duplicate of the prior request.
      analysisReqCtrl.cancelAll();
      analysisReqCtrl.resetRequestKeys();
      applyPlaylistAnalysisDecorations();
      syncPreloadQueue(state.sourceVersion);
      maybeStartCurrentSourceAnalysis(state.sourceVersion);
      requestRender();
    },
    onAutoPlayChanged() {
      requestRender();
    },
    onPerformanceModeChanged() {
      // Applies on next reload (the engine reads its predecode policy once at construction).
      requestRender();
    },
    onKeyboardShortcutsChanged() {
      requestRender();
    }
  });
  // Resolve the predecode policy once and inject it into the engine so both share one source of
  // truth. Performance mode is a Chrome-only opt-in: the build-time __BUILD_TARGET__ guard means
  // a persisted/synced `true` can never raise the tier on Firefox (gate enforced in code, not UI).
  const runtimePredecodePolicy = resolveRuntimePredecodePolicy({
    performanceMode: __BUILD_TARGET__ === 'chrome' && settings.performanceModeEnabled
  });
  const runtimeAudioEngine = createRuntimeAudioEngine({
    storeDecodedBuffer: true,
    predecodePolicy: runtimePredecodePolicy
  });
  let extensionDeactivated = false;
  let lastAutoAdvanceSourceVersion = -1;
  let lastAutoAdvanceAtMs = 0;
  state.likesDebug.context = pageContext.mode;
  state.likesDebug.contextFamily = pageContext.likeContextFamily;
  state.likesDebug.contextVariant = pageContext.likeContextVariant;
  const isRecommendationsLikeContext = (): boolean =>
    String(state.likesDebug.contextFamily || '').trim().toLowerCase() === 'recommendations';
  const resolveRuntimeLikeContext = (
    currentPageContext: ReturnType<typeof detectPageContext>,
    releaseUrl: string
  ) => resolveLikeMutationRuntimeContext(currentPageContext, releaseUrl, window.location.href);
  let bestKnownFanRootSyncContext: ReturnType<typeof detectPageContext> = pageContext;
  const maybePromoteFanRootSyncContext = (
    candidate: ReturnType<typeof detectPageContext>
  ): void => {
    if (!candidate.isFanRoot) {
      return;
    }
    if (candidate.likeContextVariant === 'fan-root-unknown') {
      return;
    }
    bestKnownFanRootSyncContext = candidate;
  };
  maybePromoteFanRootSyncContext(pageContext);
  const resolveFanRootSyncPageContext = (
    liveSyncContext: ReturnType<typeof detectPageContext>
  ): ReturnType<typeof detectPageContext> => {
    if (!pageContext.isFanRoot || !liveSyncContext.isFanRoot) {
      return liveSyncContext;
    }
    maybePromoteFanRootSyncContext(liveSyncContext);
    if (liveSyncContext.likeContextVariant !== 'fan-root-unknown') {
      return liveSyncContext;
    }
    if (bestKnownFanRootSyncContext.likeContextVariant !== 'fan-root-unknown') {
      return bestKnownFanRootSyncContext;
    }
    return liveSyncContext;
  };
  const likesController = new LikesStatusController(pageContext.mode);
  likesController.updateContext(
    pageContext.mode,
    pageContext.likeContextFamily,
    pageContext.likeContextVariant
  );
  let latestAlbumLikeIdentity: { itemId: string | number; itemType: 'album' | 'track'; bandId?: string | number; pageUrl?: string } | null = null;
  let lockedAlbumLikeIdentity: LikeIdentity | null = null;
  let lockedAlbumLikeIdentityKey = '';
  let lastSwitchAt = 0;
  let strictOriginRebindVersion = -1;
  let strictOriginRebindUntil = 0;
  const isStrictOriginRebindWindow = (): boolean =>
    rootLikePage &&
    strictOriginRebindVersion === state.sourceVersion &&
    Date.now() < strictOriginRebindUntil;
  const onAlign = (detail: string): void => {
    recordPlaylistAlign(state, detail);
  };
  const lastLikeDebugDetailByStage = new Map<string, string>();
  const pushDistinctLikeDebugEvent = (stage: string, detail: string): void => {
    const normalizedStage = String(stage || 'like-debug');
    const normalizedDetail = String(detail || '-');
    if (lastLikeDebugDetailByStage.get(normalizedStage) === normalizedDetail) {
      return;
    }
    lastLikeDebugDetailByStage.set(normalizedStage, normalizedDetail);
    pushLikeProcessEvent(state.likesDebug, normalizedStage, normalizedDetail);
  };
  const hasMaterialLikeResolutionChange = (
    previousState: LikeViewState,
    nextState: LikeViewState,
    totalTracks: number,
    activeIndex: number
  ): boolean => {
    const previousActiveTrackState = previousState.trackStates?.[activeIndex] || 'unknown';
    const nextActiveTrackState = nextState.trackStates?.[activeIndex] || 'unknown';
    return (
      previousState.albumState !== nextState.albumState ||
      previousActiveTrackState !== nextActiveTrackState ||
      !trackStatesEqual(previousState.trackStates || {}, nextState.trackStates || {}, totalTracks)
    );
  };
  const resolvePlaylistAllowApi = (requested: boolean): boolean => {
    if (isStrictOriginRebindWindow()) {
      return true;
    }
    if (fanRootApiMode) {
      return true;
    }
    return requested;
  };
  const resolveMetadataAllowApi = (requested: boolean): boolean => {
    if (pageType !== 'album' && pageType !== 'track') {
      return true;
    }
    if (rootLikePage) {
      return true;
    }
    return requested;
  };
  const isMetadataReadyForAnalysis = (): boolean =>
    Boolean(
      state.metadataResolution &&
      isMetadataResolutionAlignedWithSource(state.metadataResolution, state.currentSrc)
    );
  const isPlaylistReadyForAnalysis = (): boolean => {
    const currentSource = String(state.currentSrc || '').trim();
    if (!currentSource || state.playlist.loading) {
      return false;
    }

    const source = String(state.playlistSource || '').trim();
    if (!source || source === 'waiting-for-origin-play' || source.startsWith('switching')) {
      return false;
    }

    if (playlistContainsSourceTrack(state.playlist.tracks, currentSource)) {
      return true;
    }

    return source.includes('exhausted') || source.startsWith('none(');
  };
  const isCurrentSourceContextReadyForAnalysis = (): boolean =>
    isMetadataReadyForAnalysis() && isPlaylistReadyForAnalysis();
  const isCurrentSourceReadyForTempoBootstrap = (): boolean => {
    if (isCurrentSourceContextReadyForAnalysis()) {
      return true;
    }

    if (!rootLikePage) {
      return false;
    }

    const sourceUrl = String(state.currentSrc || '').trim();
    if (!sourceUrl || !state.hasPlaybackStarted) {
      return false;
    }

    const sourceTrackId = String(readTrackIdFromUrl(sourceUrl) || '').trim();
    if (!sourceTrackId) {
      return false;
    }

    return Boolean(resolveCurrentTrackAnalysisFetchUrl());
  };
  const isCurrentSourceBpmSettled = (): boolean => {
    const sourceUrl = String(state.currentSrc || '').trim();
    if (!sourceUrl) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, sourceUrl, {
      includePageUrl: true
    });
    if (hasCachedPlaylistBpm(sourceCacheKey || undefined)) {
      return true;
    }
    const currentAnalysis = state.lastAnalysis;
    if (!currentAnalysis || String(currentAnalysis.sourceUrl || '').trim() !== sourceUrl) {
      return false;
    }
    return Number.isFinite(currentAnalysis.bpm) || Boolean(String(currentAnalysis.error || '').trim());
  };
  const shouldDeferCurrentRuntimePrepare = (sourceUrl: string): boolean => {
    const normalizedSource = String(sourceUrl || '').trim();
    const currentSource = String(state.currentSrc || '').trim();
    if (!normalizedSource || normalizedSource !== currentSource) {
      return false;
    }
    if (state.runtimePlaybackOwned) {
      return false;
    }
    if (!isCurrentSourceReadyForTempoBootstrap()) {
      return false;
    }
    return !isCurrentSourceBpmSettled();
  };
  const isCurrentSourceWaveformSettled = (): boolean => {
    const sourceUrl = String(state.currentSrc || '').trim();
    if (!sourceUrl) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, sourceUrl, {
      includePageUrl: true
    });
    if (sourceCacheKey && playlistWaveformByCacheKey.has(sourceCacheKey)) {
      return true;
    }
    const currentAnalysis = state.lastAnalysis;
    if (!currentAnalysis || String(currentAnalysis.sourceUrl || '').trim() !== sourceUrl) {
      return false;
    }
    if (currentAnalysis.waveform) {
      return true;
    }
    const waveformStatus = String(currentAnalysis.waveformStatus || '').trim();
    return Boolean(waveformStatus);
  };
  const isCurrentSourceKeySettled = (): boolean => {
    if (!settings.keyAnalysisEnabled) {
      return true;
    }
    const sourceUrl = String(state.currentSrc || '').trim();
    if (!sourceUrl) {
      return false;
    }
    const sourceCacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, sourceUrl, {
      includePageUrl: true
    });
    if (sourceCacheKey && playlistKeyAnalysisByCacheKey.has(sourceCacheKey)) {
      return true;
    }
    const currentAnalysis = state.lastAnalysis;
    if (!currentAnalysis || String(currentAnalysis.sourceUrl || '').trim() !== sourceUrl) {
      return false;
    }
    const keyStatus = currentAnalysis.keyStatus;
    return keyStatus === 'ready' || keyStatus === 'empty' || keyStatus === 'error' || keyStatus === 'disabled';
  };
  const isCurrentSourcePreloadPhaseReady = (): boolean => {
    // Preload is the background audio-analysis branch. Keep it behind the
    // current track's BPM and key path so current playback remains highest
    // priority. Waveform hydration can continue in parallel after BPM settles.
    if (!String(state.currentSrc || '').trim()) {
      return false;
    }
    if (!isCurrentSourceContextReadyForAnalysis()) {
      return false;
    }
    if (!isCurrentSourceBpmSettled()) {
      return false;
    }
    if (!isCurrentSourceKeySettled()) {
      return false;
    }
    if (!isCurrentSourceWaveformSettled()) {
      return false;
    }
    return true;
  };
  const resolvePreloadStartupBlockReason = (): string => {
    if (!String(state.currentSrc || '').trim()) {
      return 'no-source';
    }
    if (!isCurrentSourceContextReadyForAnalysis()) {
      return 'context';
    }
    if (!isCurrentSourceBpmSettled()) {
      return 'current-bpm';
    }
    if (!isCurrentSourceKeySettled()) {
      return 'current-key';
    }
    if (!isCurrentSourceWaveformSettled()) {
      return 'current-waveform';
    }
    return '';
  };
  const maybeStartCurrentSourceAnalysis = (expectedSourceVersion = state.sourceVersion): void => {
    if (expectedSourceVersion !== state.sourceVersion) {
      return;
    }
    if (!String(state.currentSrc || '').trim()) {
      return;
    }
    if (!isCurrentSourceReadyForTempoBootstrap()) {
      return;
    }
    // Lite mode disables BPM analysis: paint the waveform without ever requesting tempo.
    if (settings.liteModeEnabled) {
      analysisReqCtrl.requestWaveformOnly();
      return;
    }
    analysisReqCtrl.requestTempo();
  };
  const isCurrentSourceInLoadedPlaylist = (): boolean =>
    Boolean(state.currentSrc && state.playlist.tracks.length > 0) &&
    findPlaylistTrackIndexBySource(state.playlist.tracks, state.currentSrc) >= 0 &&
    !state.playlistSource.startsWith('none') &&
    !state.playlistSource.startsWith('switching');
  const applyLoadedPlaylistMetadataPolicy = (reason: string): boolean => {
    if (isStrictOriginRebindWindow() || !isCurrentSourceInLoadedPlaylist()) {
      return false;
    }
    const applied = applyCurrentPlaylistTrackMetadata(state, onAlign);
    pushDistinctLikeDebugEvent(
      'metadata.playlist-track-switch',
      `reason=${reason} applied=${applied ? '1' : '0'} track=${normalizeLikeId(readTrackIdFromUrl(state.currentSrc) || '') || '-'}`
    );
    return true;
  };
  const refreshMetadataWithPolicy = (
    expectedSourceVersion = state.sourceVersion,
    allowApiFetchRequested = true
  ): void => {
    if (expectedSourceVersion !== state.sourceVersion) {
      return;
    }
    if (applyLoadedPlaylistMetadataPolicy('metadata-policy')) {
      maybeStartCurrentSourceAnalysis(expectedSourceVersion);
      return;
    }
    refreshMetadata(
      state,
      expectedSourceVersion,
      resolveMetadataAllowApi(allowApiFetchRequested)
    );
    maybeStartCurrentSourceAnalysis(expectedSourceVersion);
  };
  const isMetadataReadyForPlaylist = (): boolean =>
    Boolean(
      state.metadataResolution &&
      isMetadataResolutionAlignedWithSource(state.metadataResolution, state.currentSrc)
    );
  const shouldHoldPlaylistForMetadata = (): boolean => {
    if (isStrictOriginRebindWindow()) {
      return false;
    }
    if (!rootLikePage || isMetadataReadyForPlaylist()) {
      return false;
    }
    if (!lastSwitchAt) {
      return false;
    }
    const elapsedMs = Date.now() - lastSwitchAt;
    return elapsedMs >= 0 && elapsedMs <= ROOT_METADATA_FIRST_WINDOW_MS;
  };
  const refreshPlaylistWithPolicy = (allowApiFetchRequested = true): void => {
    if (applyLoadedPlaylistMetadataPolicy('playlist-policy')) {
      runtimeAudioController?.setCurrentSource(state.currentSrc, state.sourceVersion);
      maybeStartCurrentSourceAnalysis(state.sourceVersion);
      return;
    }
    if (shouldHoldPlaylistForMetadata()) {
      if (!state.playlist.tracks.length && !state.playlist.loading) {
        state.playlist = {
          ...state.playlist,
          loading: true
        };
      }
      return;
    }
    const syncContext = detectPageContext({
      pageGlobals: getLatestPageGlobals(60_000),
      viewerFanIdHint: state.likesDebug.fanId
    });
    const activeReleaseUrlForContext = getNowPlayingLinkedReleaseUrl() || window.location.href;
    const runtimeContext = resolveRuntimeLikeContext(syncContext, activeReleaseUrlForContext);
    state.forceUnifiedNonReleaseSnapshot = runtimeContext.family === 'recommendations';
    refreshPlaylist(state, onAlign, resolvePlaylistAllowApi(allowApiFetchRequested));
    runtimeAudioController?.setCurrentSource(state.currentSrc, state.sourceVersion);
    maybeStartCurrentSourceAnalysis(state.sourceVersion);
  };
  const shouldUseApiPlaylistRefreshForRoot = (): boolean => {
    if (isStrictOriginRebindWindow()) {
      return true;
    }
    if (fanRootApiMode) {
      return true;
    }
    if (!rootLikePage) {
      return false;
    }
    const currentTrackId = readTrackIdFromUrl(state.currentSrc);
    if (currentTrackId) {
      const currentTrackPresent = state.playlist.tracks.some(
        (track) => String(track.trackId || '').trim() === currentTrackId
      );
      if (!currentTrackPresent) {
        return true;
      }
    }
    return (
      state.playlist.tracks.length === 0 ||
      state.playlistSource.startsWith('none') ||
      state.playlistSource.startsWith('switching')
    );
  };

  const finishSourceChangeScheduling = (version: number): void => {
    deferredRefresh.schedulePlaylistRetries(version);
    maybeStartCurrentSourceAnalysis(version);
    syncPreloadQueue(version);
  };

  const finishPlaylistTrackSwitch = (version: number, reason: string): void => {
    applyLoadedPlaylistMetadataPolicy(reason);
    maybeStartCurrentSourceAnalysis(version);
    syncPreloadQueue(version);
    likeCtrl.maybeStartCurrentSourceLikePhases();
    requestRender();
  };

  const scheduleOutsidePlaylistSourceRefresh = (version: number): void => {
    if (rootLikePage) {
      playlistProbe.start(version);
      playlistProbe.sync(version);
      deferredRefresh.scheduleMetadataRefresh({ delayMs: 80, expectedSourceVersion: version, allowApiFetch: true });
      deferredRefresh.schedulePlaylistRefresh({ delayMs: 120, expectedSourceVersion: version, allowApiFetch: true });
    } else {
      deferredRefresh.scheduleMetadataRefresh({ delayMs: 80, expectedSourceVersion: version, allowApiFetch: true });
      deferredRefresh.schedulePlaylistRefresh({ delayMs: 100, expectedSourceVersion: version, allowApiFetch: true });
    }

    finishSourceChangeScheduling(version);
  };

  const scheduleAcceptedSourceRefresh = (version: number): void => {
    if (rootLikePage) {
      // Root/feed: resolve header first, then fetch playlist.
      refreshMetadataWithPolicy(version, true);
      refreshPlaylistWithPolicy(true);
      playlistProbe.start(version);
      if (state.playlist.tracks.length > 1) {
        playlistProbe.finish(version);
      } else {
        playlistProbe.sync(version);
      }
      deferredRefresh.scheduleMetadataRefresh({ delayMs: 120, expectedSourceVersion: version, allowApiFetch: true });
      deferredRefresh.schedulePlaylistRefresh({
        delayMs: 180,
        expectedSourceVersion: version,
        allowApiFetch: true
      });
    } else {
      refreshMetadataWithPolicy(version, true);
      refreshPlaylistWithPolicy(false);
      deferredRefresh.schedulePlaylistRefresh({ delayMs: 100, expectedSourceVersion: version, allowApiFetch: true });
    }

    finishSourceChangeScheduling(version);
  };

  const isBandcampStreamRedirectUrl = (url: string): boolean => /\/stream_redirect\b/i.test(String(url || '').trim());

  const readRuntimeTrackStreamUrl = (trackRaw: unknown): string => {
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
  };

  const resolveStableRuntimeLoadSource = (sourceUrl: string): string => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return '';
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
        if (sourcesShareTrackIdentity(streamUrl, normalizedSource)) {
          return streamUrl;
        }
      }
    }

    return '';
  };
  const resolveMatchingPlaylistStreamUrl = (sourceUrl: string): string => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return '';
    }

    const sourceTrackId = readTrackIdFromUrl(normalizedSource);
    for (const track of state.playlist.tracks) {
      const streamUrl = String(track.streamUrl || '').trim();
      if (!streamUrl) {
        continue;
      }
      if (sourceTrackId && String(track.trackId || '').trim() === sourceTrackId) {
        return streamUrl;
      }
      if (sourcesShareTrackIdentity(streamUrl, normalizedSource)) {
        return streamUrl;
      }
    }

    return '';
  };
  const resolveCanonicalPlaybackFetchTarget = (
    sourceUrl: string
  ): { url: string; strategy: 'direct' | 'metadata-resolved' | 'playlist' | 'tralbum' | 'analysis-resolved' | 'source' } => {
    const normalizedSource = String(sourceUrl || '').trim();
    if (!normalizedSource) {
      return { url: '', strategy: 'source' };
    }

    if (!isBandcampStreamRedirectUrl(normalizedSource)) {
      return { url: normalizedSource, strategy: 'direct' };
    }

    const metadataResolvedUrl =
      state.metadataResolution &&
      isMetadataResolutionAlignedWithSource(state.metadataResolution, normalizedSource)
        ? String(state.metadataResolution.matchedStreamUrl || '').trim()
        : '';
    if (metadataResolvedUrl) {
      return { url: metadataResolvedUrl, strategy: 'metadata-resolved' };
    }

    const playlistUrl = resolveMatchingPlaylistStreamUrl(normalizedSource);
    if (playlistUrl) {
      return { url: playlistUrl, strategy: 'playlist' };
    }

    const stableRuntimeUrl = resolveStableRuntimeLoadSource(normalizedSource);
    if (stableRuntimeUrl) {
      return { url: stableRuntimeUrl, strategy: 'tralbum' };
    }

    // Analysis can still rescue the current track when metadata and playlist
    // hydration have not surfaced a runtime-safe URL yet.
    const analysisResolvedUrl =
      state.lastAnalysis && String(state.lastAnalysis.sourceUrl || '').trim() === normalizedSource
        ? String(state.lastAnalysis.resolvedAudioUrl || '').trim()
        : '';
    if (analysisResolvedUrl && !isBandcampStreamRedirectUrl(analysisResolvedUrl)) {
      return { url: analysisResolvedUrl, strategy: 'analysis-resolved' };
    }

    // The runtime loader and analysis fetch path both support Bandcamp's
    // redirecting stream URLs. When no canonical CDN URL is available yet, the
    // redirect URL itself becomes the deterministic fetch target.
    return { url: normalizedSource, strategy: 'source' };
  };

  let bridge: AudioBridge | null = null;
  let playbackBridge: AudioBridge | null = null;
  let runtimeAudioController: RuntimeAudioController | null = null;
  const getPlaybackBridge = (): AudioBridge | null => playbackBridge || bridge;
  let panel: ResultsPanelController | null = null;
  let debugPanel: DebugPanelController | null = null;
  let resourceDiagnostics: ResourceDiagnosticsController | null = null;

  refreshMetadataWithPolicy(state.sourceVersion, rootLikePage);
  refreshPlaylistWithPolicy(shouldUseApiPlaylistRefreshForRoot());
  const resolveCurrentTrackPageUrl = (): string => {
    const currentTrack = state.playlist.tracks[state.playlist.currentIndex];
    const pageUrl = String(currentTrack?.pageUrl || '').trim();
    if (pageUrl) {
      return pageUrl;
    }

    const currentSrc = String(state.currentSrc || '').trim();
    const fromSourceMap = String(releaseUrlBySource.get(currentSrc) || '').trim();
    if (fromSourceMap) {
      return fromSourceMap;
    }

    return String(window.location.href || '').trim();
  };
  const resolveCurrentTrackAnalysisUrl = (): string => {
    const currentTrack = state.playlist.tracks[state.playlist.currentIndex];
    const streamUrl = String(currentTrack?.streamUrl || '').trim();
    if (streamUrl) {
      return streamUrl;
    }

    const currentSrc = String(state.currentSrc || '').trim();
    if (currentSrc) {
      return currentSrc;
    }

    const pageUrl = String(currentTrack?.pageUrl || '').trim();
    if (pageUrl) {
      return pageUrl;
    }

    const fromSourceMap = String(releaseUrlBySource.get(currentSrc) || '').trim();
    if (fromSourceMap) {
      return fromSourceMap;
    }

    return String(window.location.href || '').trim();
  };
  const resolveCurrentTrackAnalysisFetchUrl = (): string => {
    const sourceUrl = String(state.currentSrc || '').trim();
    if (!sourceUrl) {
      return '';
    }
    // BPM analysis can fetch Bandcamp's redirect URL directly. Unlike runtime
    // predecode, it does not need to wait for a stable CDN URL from metadata or
    // playlist hydration before starting.
    return resolveCanonicalPlaybackFetchTarget(sourceUrl).url;
  };
  const bpmPrototypeController = createBpmPrototypeController({
    getCurrentAnalysisUrl: resolveCurrentTrackAnalysisUrl,
    getCurrentSaveUrl: resolveCurrentTrackPageUrl,
    getCurrentMetadata: () => ({
      artistName: state.metadata.artistName,
      trackTitle: state.metadata.trackTitle,
      albumTitle: state.metadata.albumTitle
    })
  });
  const keyTuningController = createKeyTuningController({
    getCurrentUrl: () => {
      const currentSrc = String(state.currentSrc || '').trim();
      if (currentSrc) {
        return currentSrc;
      }

      const currentTrack = state.playlist.tracks[state.playlist.currentIndex];
      const pageUrl = String(currentTrack?.pageUrl || '').trim();
      if (pageUrl) {
        return pageUrl;
      }

      const fromSourceMap = String(releaseUrlBySource.get(currentSrc) || '').trim();
      if (fromSourceMap) {
        return fromSourceMap;
      }

      return String(window.location.href || '').trim();
    },
    getCurrentBpm: () => state.lastAnalysis?.bpm,
    getCurrentMetadata: () => ({
      artistName: state.metadata.artistName,
      trackTitle: state.metadata.trackTitle,
      albumTitle: state.metadata.albumTitle,
      confidence: state.metadata.confidence
    })
  });
  let pushDebug: (title: string, sectionsFactory: DebugSectionsFactory) => void = () => {};
  const playlistAnalysisCache = createPlaylistAnalysisCache({
    maxAttempts: MAX_ANALYSIS_ATTEMPTS_PER_TRACK,
    normalizeKey: normalizeCacheKey
  });
  const playlistBpmByCacheKey = playlistAnalysisCache.bpmByCacheKey;
  const playlistConfidenceByCacheKey = new Map<string, number>();
  const playlistWaveformByCacheKey = playlistAnalysisCache.waveformByCacheKey;
  const playlistKeyAnalysisByCacheKey = playlistAnalysisCache.keyAnalysisByCacheKey;
  const playlistFailedCacheKeys = playlistAnalysisCache.failedCacheKeys;
  const playlistAttemptCountByCacheKey = playlistAnalysisCache.attemptCountByCacheKey;
  const playlistAnalyzingCacheKeys = playlistAnalysisCache.analyzingCacheKeys;
  const releaseUrlBySource = new Map<string, string>();
  const playlistAnalysisFacade = createPlaylistAnalysisCacheFacade(playlistAnalysisCache, normalizeCacheKey);
  const {
    resolvePreloadTargetKey,
    setTrackAnalyzing: setPlaylistTrackAnalyzing,
    registerAnalysisAttempt,
    canAttemptAnalysis,
    hasCachedBpm: hasCachedPlaylistBpm,
    setCachedBpm: setCachedPlaylistBpm,
    clearTrackAnalyzing: clearPlaylistTrackAnalyzing
  } = playlistAnalysisFacade;
  // Forward-declared; assigned after all callback dependencies are defined.
  let analysisReqCtrl: ReturnType<typeof createAnalysisRequestController>;
  let lastAuthoritativeSource = '';
  let lastAuthoritativeSourceAt = 0;
  let lastAuthoritativeSourceVersion = state.sourceVersion;

  const clearAllPlaylistAnalyzing = (): void => {
    if (!playlistAnalyzingCacheKeys.size && !analysisReqCtrl.getActiveTempoTrackCacheKey()) {
      return;
    }
    clearPlaylistTrackAnalyzing();
    analysisReqCtrl.setActiveTempoTrackCacheKey('');
  };

  const recordLikeViewStateChange = (
    source: string,
    previousState: LikeViewState,
    nextState: LikeViewState
  ): void => {
    const activeIndex = Number.isInteger(state.playlist.currentIndex) ? state.playlist.currentIndex : 0;
    const previousTrackState = previousState.trackStates?.[activeIndex] || 'unknown';
    const nextTrackState = nextState.trackStates?.[activeIndex] || 'unknown';
    const changedTrackIndices: number[] = [];
    const maxTrackStates = Math.max(
      Object.keys(previousState.trackStates || {}).length,
      Object.keys(nextState.trackStates || {}).length,
      state.playlist.tracks.length
    );
    for (let index = 0; index < maxTrackStates; index += 1) {
      const previous = previousState.trackStates?.[index] || 'unknown';
      const next = nextState.trackStates?.[index] || 'unknown';
      if (previous !== next) {
        changedTrackIndices.push(index);
        if (changedTrackIndices.length >= 6) {
          break;
        }
      }
    }
    const changedTopLevelState =
      previousState.albumState !== nextState.albumState ||
      previousTrackState !== nextTrackState ||
      previousState.loading !== nextState.loading ||
      previousState.disabled !== nextState.disabled;
    if (!changedTopLevelState && changedTrackIndices.length === 0) {
      return;
    }
    const changedTrackText = changedTrackIndices.length ? changedTrackIndices.join(',') : '-';
    const detail =
      `src=${source}` +
      ` album=${previousState.albumState}->${nextState.albumState}` +
      ` active[${activeIndex}]=${previousTrackState}->${nextTrackState}` +
      ` loading=${previousState.loading ? '1' : '0'}->${nextState.loading ? '1' : '0'}` +
      ` disabled=${previousState.disabled ? '1' : '0'}->${nextState.disabled ? '1' : '0'}` +
      ` tracksChanged=${changedTrackText}`;
    pushLikeProcessEvent(state.likesDebug, 'view.state.change', detail);
  };
  const clearLockedAlbumLikeIdentity = (): void => {
    latestAlbumLikeIdentity = null;
    lockedAlbumLikeIdentity = null;
    lockedAlbumLikeIdentityKey = '';
  };
  const clearLikeViewStateForSourceSwitch = (source: string): void => {
    const previousLikeViewState = cloneLikeViewState(state.likeViewState);
    state.likeViewState = {
      ...DEFAULT_LIKE_VIEW_STATE,
      disabled: true,
      trackStates: {}
    };
    recordLikeViewStateChange(source, previousLikeViewState, state.likeViewState);
  };
  const clearSourceBoundPanelState = (source: string): void => {
    clearLockedAlbumLikeIdentity();
    clearLikeViewStateForSourceSwitch(source);
    state.playlistSelectionRunId += 1;
    state.playlistJumpLockTrackId = '';
    state.playlistJumpLockUntil = 0;
    state.metadata = { ...DEFAULT_TRACK_METADATA };
    state.metadataResolution = null;
    state.nonReleaseSnapshot = null;
    state.nonReleaseSnapshotVersion = -1;
  };
  const resetPlaylistForSourceSwitch = (): void => {
    playlistWarmToken += 1;
    activePlaylistRuntimePredecodeSignature = '';
    playlistRuntimePredecodeInFlightKeys.clear();
    playlistRuntimePredecodeInFlightSources.clear();
    state.playlist = {
      ...DEFAULT_PLAYLIST_STATE,
      expanded: state.playlist.expanded,
      tracks: [],
      currentIndex: 0,
      loading: true
    };
    state.playlistSource = 'switching(origin-track)';
  };
  const resetSourceScopedWork = (cancelRuntimePreparation: boolean): void => {
    deferredRefresh.cancelAll();
    analysisReqCtrl.cancelAll();
    analysisReqCtrl.resetRequestKeys();
    runtimePrepareInFlightKey = '';
    runtimePrepareInFlightSource = '';
    if (cancelRuntimePreparation) {
      runtimeAudioEngine.clearPreparedTrack();
    }
    state.lastAnalysis = null;
    resetPlayerTempoAdjustSession(state);
    applyPlayerTempoAdjust(state, getPlaybackBridge());
    clearAllPlaylistAnalyzing();
    preloader.cancel();
    preloadCtrl.resetPreloadQueueSignature();
    resetPreloadBpmBatchGate();
    preloadCtrl.clearPreloadKeyFailedCacheKeys();
    resetPreloadFailureEpoch();
    cancelPreloadKeyPass();
  };
  const maybeResetLikesForSourceChange = (input: {
    sourceChanged: boolean;
    sourceOutsideCurrentPlaylist: boolean;
    origin: string;
    candidateTrackId: string;
  }): void => {
    if (!input.sourceChanged || !input.sourceOutsideCurrentPlaylist) {
      return;
    }

    const hasCompleteLikeInventory = likesController.isInventoryReady();
    if (!state.forceUnifiedNonReleaseSnapshot && !hasCompleteLikeInventory) {
      pushDistinctLikeDebugEvent(
        'source.change.like-reset',
        `reason=outside-playlist origin=${input.origin} to=${normalizeLikeId(input.candidateTrackId || '') || '-'}`
      );
      likeCtrl.resetLikesForOriginJump(`player:${input.origin}`);
      return;
    }

    if (hasCompleteLikeInventory) {
      pushDistinctLikeDebugEvent(
        'source.change.like-reset-skip',
        `reason=inventory-ready origin=${input.origin} to=${normalizeLikeId(input.candidateTrackId || '') || '-'}`
      );
    }
  };
  const looksLikeReleaseUrl = (url: string): boolean => /\/(album|track)\//.test(url);
  const resolveReleaseUrlForLikeState = (
    activeTrackReleaseUrl: string,
    currentSrc: string,
    domReleaseUrl: string
  ): string => {
    let releaseUrl = '';
    if (activeTrackReleaseUrl && looksLikeReleaseUrl(activeTrackReleaseUrl)) {
      releaseUrl = activeTrackReleaseUrl;
    }
    if (currentSrc) {
      if (!releaseUrl) {
        releaseUrl = String(releaseUrlBySource.get(currentSrc) || '').trim();
      }
      if (!releaseUrl && domReleaseUrl && looksLikeReleaseUrl(domReleaseUrl)) {
        releaseUrlBySource.set(currentSrc, domReleaseUrl);
        releaseUrl = domReleaseUrl;
      }
    }
    if (!releaseUrl) {
      releaseUrl = domReleaseUrl || window.location.href;
    }
    if (releaseUrlBySource.size > 120) {
      const oldestKey = releaseUrlBySource.keys().next().value;
      if (typeof oldestKey === 'string' && oldestKey) {
        releaseUrlBySource.delete(oldestKey);
      }
    }
    return releaseUrl;
  };
  const resolveIdentityLockState = (input: {
    unresolvedNonReleaseIdentity: boolean;
    releaseCanonicalUrl: string;
    strictAlbumCandidateId: string;
    allowUnresolvedLockReuse: boolean;
  }): {
    nextLockedIdentity: LikeIdentity | null;
    nextLockKey: string;
  } => {
    const canReuseUnresolvedLock = Boolean(
      input.allowUnresolvedLockReuse &&
      input.unresolvedNonReleaseIdentity &&
      lockedAlbumLikeIdentity
    );
    const lockedIdentityForReuse = canReuseUnresolvedLock ? lockedAlbumLikeIdentity : null;
    const identityLockKey = canReuseUnresolvedLock
      ? toCanonicalLikeUrl(String(lockedIdentityForReuse?.pageUrl || '')) || lockedAlbumLikeIdentityKey || '-'
      : input.releaseCanonicalUrl || '-';
    let nextLockedIdentity = lockedAlbumLikeIdentity;
    if (!input.allowUnresolvedLockReuse && input.unresolvedNonReleaseIdentity && !input.strictAlbumCandidateId) {
      nextLockedIdentity = null;
    }
    if (identityLockKey !== lockedAlbumLikeIdentityKey && Boolean(input.strictAlbumCandidateId)) {
      nextLockedIdentity = null;
    }
    return {
      nextLockedIdentity,
      nextLockKey: identityLockKey
    };
  };
  const normalizeAlbumLikeIdentity = (
    identity: LikeIdentity | null | undefined,
    fallbackPageUrl: string
  ): LikeIdentity | null => {
    if (!identity || identity.itemType !== 'album') {
      return null;
    }
    const itemId = normalizeLikeId(identity.itemId || '');
    const bandId = normalizeLikeId(identity.bandId || '') || undefined;
    const urlCandidates = [
      toCanonicalLikeUrl(String(identity.pageUrl || '')),
      toCanonicalLikeUrl(String(fallbackPageUrl || '')),
      toCanonicalLikeUrl(window.location.href)
    ].filter(Boolean);
    const pageUrl =
      urlCandidates.find((url) => url.includes('/album/')) ||
      urlCandidates[0] ||
      '';
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
  const resolveAlbumIdentityForLikeState = (input: {
    unresolvedNonReleaseIdentity: boolean;
    allowUnresolvedLockReuse: boolean;
    releaseDiffersFromPage: boolean;
    releaseCanonicalUrl: string;
    pageCanonicalUrl: string;
    releaseUrl: string;
    resolvedTrackAlbumIdentity: LikeIdentity | null;
    cachedReleaseAlbumIdentity: LikeIdentity | null;
    domReleaseAlbumIdentity: LikeIdentity | null;
    globalsIdentity: LikeIdentity | null;
    allowFallbackFromUrlOrGlobals: boolean;
  }): {
    albumIdentity: LikeIdentity | null;
    nextLockedAlbumLikeIdentity: LikeIdentity | null;
  } => {
    let nextLockedAlbumLikeIdentity = lockedAlbumLikeIdentity;
    const primaryAlbumIdentity =
      input.resolvedTrackAlbumIdentity || input.cachedReleaseAlbumIdentity || input.domReleaseAlbumIdentity;
    let albumIdentity: LikeIdentity | null =
      input.allowUnresolvedLockReuse && input.unresolvedNonReleaseIdentity && nextLockedAlbumLikeIdentity
        ? {
            ...nextLockedAlbumLikeIdentity,
            pageUrl: nextLockedAlbumLikeIdentity.pageUrl || input.releaseUrl || window.location.href
          }
        : primaryAlbumIdentity;
    albumIdentity = normalizeAlbumLikeIdentity(albumIdentity, input.releaseUrl);
    nextLockedAlbumLikeIdentity = normalizeAlbumLikeIdentity(nextLockedAlbumLikeIdentity, input.releaseUrl);
    // While identity is unresolved on fan-root pages, keep the existing lock authoritative.
    // Promoting a "fresh" candidate here can be cross-release stale data during jumps.
    const isTrackVsAlbumSameReleaseContext = Boolean(
      input.releaseDiffersFromPage &&
      input.releaseCanonicalUrl.includes('/track/') &&
      input.pageCanonicalUrl.includes('/album/')
    );
    if (input.allowFallbackFromUrlOrGlobals && !albumIdentity && input.globalsIdentity?.itemType === 'album') {
      if (!input.releaseDiffersFromPage || isTrackVsAlbumSameReleaseContext) {
        albumIdentity = {
          ...input.globalsIdentity,
          pageUrl: input.pageCanonicalUrl.includes('/album/')
            ? window.location.href
            : (input.globalsIdentity.pageUrl || input.releaseUrl || window.location.href)
        };
        albumIdentity = normalizeAlbumLikeIdentity(albumIdentity, input.releaseUrl);
      }
    }
    if (
      input.allowFallbackFromUrlOrGlobals &&
      (!albumIdentity || albumIdentity.itemType !== 'album') &&
      input.releaseCanonicalUrl.includes('/album/')
    ) {
      albumIdentity = {
        itemId: '',
        itemType: 'album',
        pageUrl: input.releaseUrl
      };
      albumIdentity = normalizeAlbumLikeIdentity(albumIdentity, input.releaseUrl);
    }
    const lockableAlbumId = normalizeLikeId(albumIdentity?.itemId || '');
    if (!nextLockedAlbumLikeIdentity && lockableAlbumId) {
      nextLockedAlbumLikeIdentity = {
        itemId: lockableAlbumId,
        itemType: 'album',
        bandId: normalizeLikeId(albumIdentity?.bandId || '') || undefined,
        pageUrl: albumIdentity?.pageUrl || input.releaseUrl || window.location.href
      };
      nextLockedAlbumLikeIdentity = normalizeAlbumLikeIdentity(nextLockedAlbumLikeIdentity, input.releaseUrl);
    }
    const activeAlbumId = normalizeLikeId(albumIdentity?.itemId || '');
    const lockedAlbumId = normalizeLikeId(nextLockedAlbumLikeIdentity?.itemId || '');
    if (nextLockedAlbumLikeIdentity && activeAlbumId && activeAlbumId !== lockedAlbumId) {
      nextLockedAlbumLikeIdentity = {
        itemId: activeAlbumId,
        itemType: 'album',
        bandId: normalizeLikeId(albumIdentity?.bandId || '') || undefined,
        pageUrl: albumIdentity?.pageUrl || input.releaseUrl || window.location.href
      };
      nextLockedAlbumLikeIdentity = normalizeAlbumLikeIdentity(nextLockedAlbumLikeIdentity, input.releaseUrl);
    }
    if (input.allowUnresolvedLockReuse && nextLockedAlbumLikeIdentity && !activeAlbumId) {
      albumIdentity = {
        ...nextLockedAlbumLikeIdentity,
        pageUrl: nextLockedAlbumLikeIdentity.pageUrl || input.releaseUrl || window.location.href
      };
      albumIdentity = normalizeAlbumLikeIdentity(albumIdentity, input.releaseUrl);
    }
    return {
      albumIdentity,
      nextLockedAlbumLikeIdentity
    };
  };
  const buildLikeIdentityDebugReason = (input: {
    strictAlbumIdentityReady: boolean;
    trackReason: string;
    releaseDiffersFromPage: boolean;
    albumIdentity: LikeIdentity | null;
    globalsIdentity: LikeIdentity | null;
  }): string =>
    `album=${input.strictAlbumIdentityReady ? 'resolved' : 'missing-item-id'}; ${input.trackReason}` +
    `; releaseDiffers=${input.releaseDiffersFromPage ? '1' : '0'}` +
    `; lock=${lockedAlbumLikeIdentity ? '1' : '0'}` +
    `; active=${formatLikeIdentityDebug(input.albumIdentity)}` +
    `; locked=${formatLikeIdentityDebug(lockedAlbumLikeIdentity)}` +
    `; releaseGlobals=${formatLikeIdentityDebug(input.globalsIdentity)}`;

  const requestRender = (): void => {
    if (extensionDeactivated || !panel) {
      return;
    }
    // Coalesce to one execution per pending animation frame. requestRender runs heavy
    // synchronous work (engine-debug sync, like-view recompute, page-globals/identity
    // resolution, playlist decorations) before scheduling the rAF render. It is called once
    // per debug event, so a burst (e.g. scrubbing an unprepared track emits many seek/prepare
    // events) would otherwise run all that work dozens of times per frame — which, with the
    // debug panel open and rebuilding each frame, stalls the main thread. The rAF render reads
    // the latest state when it fires, so skipping the redundant pre-work is safe.
    if (state.renderScheduled) {
      return;
    }
    syncRuntimeAudioEngineDebug();
    const hasTracksLoaded = state.playlist.tracks.length > 0;
    if (!hasTracksLoaded) {
      const previousLikeViewState = cloneLikeViewState(state.likeViewState);
      state.likeViewState = {
        ...state.likeViewState,
        loading: false,
        disabled: true
      };
      recordLikeViewStateChange('idle-no-tracks', previousLikeViewState, state.likeViewState);
      likesController.applyDebug(state.likesDebug);
      state.likesDebug.identityTrust = 'album=idle, track=idle';
      state.likesDebug.identityReason = 'player=idle; tracks=0; using-stale-like-view';
      // No current track is resolved during the transition, so neutralize the
      // inventory-truth readout — otherwise it carries the previous track's
      // truth (e.g. track[0]=bought) until the next resolve pass. Safe here: the
      // truth-vs-display mismatch check only runs in the resolve pass (tracks
      // loaded), so there is nothing to mask while tracks=0.
      state.likesDebug.truthAlbumState = 'unknown';
      state.likesDebug.truthActiveTrackState = 'n/a';
      applyPlaylistAnalysisDecorations();
      scheduleRender(state, settings, panel, pushDebug);
      return;
    }
    const globals = getLatestPageGlobals(15_000);
    const currentSrc = String(state.currentSrc || '').trim();
    const domReleaseUrl = String(getNowPlayingLinkedReleaseUrl() || '').trim();
    const toAlbumLikeIdentity = (
      candidate: { tralbumType?: string; tralbumId?: string | number; bandId?: string | number } | null | undefined,
      pageUrlForIdentity: string
    ): LikeIdentity | null => {
      if (candidate?.tralbumType !== 'a') {
        return null;
      }
      const itemId = normalizeLikeId(candidate.tralbumId || '');
      if (!itemId) {
        return null;
      }
      return {
        itemId,
        itemType: 'album',
        bandId: candidate.bandId,
        pageUrl: pageUrlForIdentity
      };
    };
    const identityMatches = (a: LikeIdentity | null, b: LikeIdentity | null): boolean => {
      if (!a || !b) {
        return false;
      }
      const aType = a.itemType === 'track' ? 'track' : 'album';
      const bType = b.itemType === 'track' ? 'track' : 'album';
      if (aType !== bType) {
        return false;
      }
      const aId = normalizeLikeId(a.itemId || '');
      const bId = normalizeLikeId(b.itemId || '');
      if (aId && bId) {
        return aId === bId;
      }
      const aUrl = toCanonicalLikeUrl(String(a.pageUrl || ''));
      const bUrl = toCanonicalLikeUrl(String(b.pageUrl || ''));
      return Boolean(aUrl && bUrl && aUrl === bUrl);
    };
    const activeTrack = state.playlist.tracks[state.playlist.currentIndex] || null;
    const activeTrackReleaseUrl = String(activeTrack?.pageUrl || '').trim();
    const releaseUrl = resolveReleaseUrlForLikeState(activeTrackReleaseUrl, currentSrc, domReleaseUrl);
    // Source-first track identity prevents stale metadata resolutions from
    // pinning likes to the previous track during rapid playlist jumps.
    const currentTrackId = normalizeLikeId(
      readTrackIdFromUrl(state.currentSrc) || state.metadataResolution?.matchedTrackId
    );
    const strictResolverTrackBinding =
      isTrustedPlaylistLikeSource(state.playlistSource) ||
      Boolean(
        state.nonReleaseSnapshot &&
        state.nonReleaseSnapshot.flags.strictPlaylistBinding &&
        state.nonReleaseSnapshot.source.identitySource !== 'none'
    );
    const pageCanonicalUrl = toCanonicalLikeUrl(window.location.href);
    const releaseCanonicalUrl = toCanonicalLikeUrl(releaseUrl);
    const livePageContext = detectPageContext({
      pageGlobals: globals,
      viewerFanIdHint: state.likesDebug.fanId
    });
    const effectiveLivePageContext = resolveFanRootSyncPageContext(livePageContext);
    const allowUnresolvedLockReuse = !(
      livePageContext.group === 'foreign' &&
      livePageContext.section === 'collection'
    );
    const apiOnlyLikeIdentity = shouldUseApiOnlyLikeIdentity(livePageContext);
    const resolvedTrackAlbumIdentity = currentTrackId
      ? toAlbumLikeIdentity(getResolvedIdentityForTrack(currentTrackId), releaseUrl)
      : null;
    const cachedReleaseAlbumIdentity = apiOnlyLikeIdentity
      ? null
      : toAlbumLikeIdentity(
          getCachedAlbumIdentityForReleaseUrl(releaseUrl),
          releaseUrl
        );
    const domReleaseAlbumIdentity = apiOnlyLikeIdentity
      ? null
      : toAlbumLikeIdentity(getNowPlayingDomReleaseIdentity(releaseUrl), releaseUrl);
    const runtimeLikeContext = resolveRuntimeLikeContext(effectiveLivePageContext, releaseUrl);
    likesController.updateContext(
      effectiveLivePageContext.mode,
      runtimeLikeContext.family,
      runtimeLikeContext.variant
    );
    state.likesDebug.context = effectiveLivePageContext.mode;
    state.likesDebug.contextFamily = runtimeLikeContext.family;
    state.likesDebug.contextVariant = runtimeLikeContext.variant;
    const pageIsReleaseContext = /\/(album|track)\//.test(pageCanonicalUrl);
    const unresolvedNonReleaseIdentity = Boolean(
      !pageIsReleaseContext &&
      state.nonReleaseSnapshot &&
      state.nonReleaseSnapshot.source.identitySource === 'none'
    );
    const releaseDiffersFromPage = Boolean(
      pageIsReleaseContext &&
      releaseCanonicalUrl &&
      pageCanonicalUrl &&
      releaseCanonicalUrl !== pageCanonicalUrl
    );
    const strictAlbumCandidateId = normalizeLikeId(
      resolvedTrackAlbumIdentity?.itemId ||
      cachedReleaseAlbumIdentity?.itemId ||
      ''
    );
    const previousLockedIdentityForDebug = lockedAlbumLikeIdentity;
    const previousLockKeyForDebug = lockedAlbumLikeIdentityKey;
    pushDistinctLikeDebugEvent(
      'identity.resolve.candidates',
      [
        `track=${currentTrackId || '-'}`,
        `source=${state.playlistSource || '-'}`,
        `apiOnly=${apiOnlyLikeIdentity ? '1' : '0'}`,
        `strictTrack=${strictResolverTrackBinding ? '1' : '0'}`,
        `release=${toCanonicalLikeUrl(releaseUrl) || '-'}`,
        `resolved=${formatLikeIdentityDebug(resolvedTrackAlbumIdentity)}`,
        `cached=${formatLikeIdentityDebug(cachedReleaseAlbumIdentity)}`,
        `dom=${formatLikeIdentityDebug(domReleaseAlbumIdentity)}`,
        `lockPrev=${formatLikeIdentityDebug(previousLockedIdentityForDebug)}`,
        `lockKeyPrev=${previousLockKeyForDebug || '-'}`
      ].join(' ')
    );
    const identityLockState = resolveIdentityLockState({
      unresolvedNonReleaseIdentity,
      releaseCanonicalUrl,
      strictAlbumCandidateId,
      allowUnresolvedLockReuse
    });
    lockedAlbumLikeIdentity = normalizeAlbumLikeIdentity(identityLockState.nextLockedIdentity, releaseUrl);
    lockedAlbumLikeIdentityKey = identityLockState.nextLockKey;
    pushDistinctLikeDebugEvent(
      'identity.resolve.lock',
      [
        `unresolved=${unresolvedNonReleaseIdentity ? '1' : '0'}`,
        `candidate=${strictAlbumCandidateId || '-'}`,
        `prev=${formatLikeIdentityDebug(previousLockedIdentityForDebug)}`,
        `next=${formatLikeIdentityDebug(lockedAlbumLikeIdentity)}`,
        `key=${previousLockKeyForDebug || '-'}->${lockedAlbumLikeIdentityKey || '-'}`
      ].join(' ')
    );

    const globalsIdentity = apiOnlyLikeIdentity ? null : resolveReleaseLikeIdentityFromGlobals(globals, releaseUrl);
    const albumIdentityState = resolveAlbumIdentityForLikeState({
      unresolvedNonReleaseIdentity,
      allowUnresolvedLockReuse,
      releaseDiffersFromPage,
      releaseCanonicalUrl,
      pageCanonicalUrl,
      releaseUrl,
      resolvedTrackAlbumIdentity,
      cachedReleaseAlbumIdentity,
      domReleaseAlbumIdentity,
      globalsIdentity,
      allowFallbackFromUrlOrGlobals: !apiOnlyLikeIdentity
    });
    let albumIdentity = albumIdentityState.albumIdentity;
    lockedAlbumLikeIdentity = albumIdentityState.nextLockedAlbumLikeIdentity;
    latestAlbumLikeIdentity = albumIdentity;
    const resolvedSource = (() => {
      if (identityMatches(albumIdentity, resolvedTrackAlbumIdentity)) {
        return 'resolved-track';
      }
      if (identityMatches(albumIdentity, cachedReleaseAlbumIdentity)) {
        return 'cached-release';
      }
      if (identityMatches(albumIdentity, domReleaseAlbumIdentity)) {
        return 'dom-release';
      }
      if (identityMatches(albumIdentity, globalsIdentity)) {
        return 'globals';
      }
      if (identityMatches(albumIdentity, lockedAlbumLikeIdentity)) {
        return 'lock';
      }
      if (albumIdentity && !normalizeLikeId(albumIdentity.itemId || '') && toCanonicalLikeUrl(String(albumIdentity.pageUrl || ''))) {
        return 'url-fallback';
      }
      return albumIdentity ? 'other' : 'none';
    })();
    pushDistinctLikeDebugEvent(
      'identity.resolve.result',
      [
        `selected=${formatLikeIdentityDebug(albumIdentity)}`,
        `source=${resolvedSource}`,
        `apiOnly=${apiOnlyLikeIdentity ? '1' : '0'}`,
        `allowFallback=${apiOnlyLikeIdentity ? '0' : '1'}`,
        `globals=${formatLikeIdentityDebug(globalsIdentity)}`
      ].join(' ')
    );
    const globalsAlbumIdentity = resolveReleaseLikeIdentityFromGlobals(globals, window.location.href);
    const likeViewBeforeResolve = cloneLikeViewState(state.likeViewState);
    pushDistinctLikeDebugEvent(
      'view.resolve.context',
      [
        `srcTrack=${normalizeLikeId(readTrackIdFromUrl(currentSrc) || '') || '-'}`,
        `playlistSource=${state.playlistSource || '-'}`,
        `tracks=${state.playlist.tracks.length}`,
        `album=${formatLikeIdentityDebug(albumIdentity)}`,
        `locked=${formatLikeIdentityDebug(lockedAlbumLikeIdentity)}`,
        `strictTrack=${strictResolverTrackBinding ? '1' : '0'}`,
        `unresolved=${unresolvedNonReleaseIdentity ? '1' : '0'}`,
        `resolver=inventory-truth`
      ].join(' ')
    );
    const likeResolved = likesController.resolveViewState(
      albumIdentity,
      state.playlist.tracks,
      !likeCtrl.LIKE_WRITES_ENABLED || Boolean(likeCtrl.likeMutationController.isUiLocked()),
      state.playlistSource,
      strictResolverTrackBinding,
      String(albumIdentity?.pageUrl || releaseUrl || '').trim()
    );
    state.likeViewState = likeResolved.likeState;
    recordLikeViewStateChange('resolve-view-state', likeViewBeforeResolve, state.likeViewState);
    const resolvedPlaylistTracks = likeResolved.playlistTracks;
    const resolvedActiveIndex = resolveActiveTrackIndexForLikeDebug(state.playlist);
    if (hasMaterialLikeResolutionChange(
      likeViewBeforeResolve,
      state.likeViewState,
      state.playlist.tracks.length,
      resolvedActiveIndex
    )) {
      pushDistinctLikeDebugEvent(
        'view.resolve.player-output',
        [
          `album=${likeViewBeforeResolve.albumState}->${state.likeViewState.albumState}`,
          `before=${formatPlaylistTrackLikeDebug(state.playlist, likeViewBeforeResolve, resolvedActiveIndex)}`,
          `after=${formatPlaylistTrackLikeDebug(state.playlist, state.likeViewState, resolvedActiveIndex)}`,
          `counts=${summarizeLikeViewStateCounts(state.likeViewState, state.playlist.tracks.length)}`
        ].join(' ')
      );
    }
    if (resolvedPlaylistTracks !== state.playlist.tracks) {
      state.playlist = {
        ...state.playlist,
        tracks: resolvedPlaylistTracks
      };
    }
    likesController.applyDebug(state.likesDebug);
    const trackIdentityTrust = evaluateTrackLikeIdentityTrust(activeTrack, state.playlistSource);
    const strictTrackIdentityReady = strictResolverTrackBinding && trackIdentityTrust.ready;
    const strictAlbumIdentityReady = Boolean(
      albumIdentity &&
      albumIdentity.itemType === 'album' &&
      normalizeLikeId(albumIdentity.itemId || '')
    );
    const activeTrackIdentity = likeCtrl.resolveTrackLikeIdentityByIndex(state.playlist.currentIndex);
    const albumInventoryState = likesController.readInventoryLikeState(albumIdentity);
    const activeTrackInventoryState = likesController.readInventoryLikeState(activeTrackIdentity);
    const activeTrackViewState = state.likeViewState.trackStates[state.playlist.currentIndex] || 'unknown';
    const inheritedLikedSurface =
      state.likeViewState.albumState === 'liked' &&
      albumInventoryState === 'liked' &&
      activeTrackViewState === 'liked';
    const inheritedBoughtSurface =
      state.likeViewState.albumState === 'bought' &&
      albumInventoryState === 'bought' &&
      activeTrackViewState === 'bought';
    const albumMismatch = albumInventoryState !== 'unknown' && albumInventoryState !== state.likeViewState.albumState;
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
    state.likesDebug.truthAlbumState = albumInventoryState;
    state.likesDebug.truthActiveTrackState = activeTrackInventoryState === 'unknown' ? 'n/a' : activeTrackInventoryState;
    state.likesDebug.displayAlbumState = state.likeViewState.albumState;
    state.likesDebug.displayActiveTrackState = activeTrackViewState;
    state.likesDebug.trackProjection = trackProjection;
    pushDistinctLikeDebugEvent(
      'view.inventory.truth',
      [
        `album=${formatLikeIdentityDebug(albumIdentity)}`,
        `albumInventory=${albumInventoryState}`,
        `track=${formatLikeIdentityDebug(activeTrackIdentity)}`,
        `trackInventory=${activeTrackInventoryState}`,
        `viewAlbum=${state.likeViewState.albumState}`,
        `viewTrack=${activeTrackViewState}`,
        `projection=${trackProjection}`,
        `mismatch=${mismatchCode}`
      ].join(' ')
    );
    state.likesDebug.identityTrust = `album=${strictAlbumIdentityReady ? 'strict' : 'unknown'}, track=${strictTrackIdentityReady ? 'strict' : 'blocked'}`;
    const trackReason = strictResolverTrackBinding
      ? trackIdentityTrust.reason
      : `resolver=unbound; ${trackIdentityTrust.reason}`;
    state.likesDebug.identityReason = buildLikeIdentityDebugReason({
      strictAlbumIdentityReady,
      trackReason,
      releaseDiffersFromPage,
      albumIdentity,
      globalsIdentity
    });
    applyPlaylistAnalysisDecorations();
    scheduleRender(state, settings, panel, pushDebug);
  };

  // maybeStartCurrentSourceBackgroundPhase is provided by preloadCtrl

  const isPlayheadTickEligible = (): boolean => {
    if (extensionDeactivated || !panel || !state.hasPlaybackStarted) {
      return false;
    }
    if (state.playlist.tracks.length === 0) {
      return false;
    }

    const currentSrc = String(state.currentSrc || '').trim();
    const audio = state.activeAudio;
    const audioSrc = String(audio?.currentSrc || audio?.src || '').trim();
    if (
      audio &&
      !audio.paused &&
      !audio.ended &&
      currentSrc &&
      audioSrc &&
      sourcesShareTrackIdentity(audioSrc, currentSrc)
    ) {
      return true;
    }

    const bridgeAudioState = state.bridgeAudioState;
    if (!bridgeAudioState) {
      return false;
    }
    const bridgeFresh = Date.now() - bridgeAudioState.ts <= 3000;
    const bridgeAuthoritative = bridgeFresh || (state.runtimePlaybackOwned && bridgeAudioState.origin === 'runtime');
    if (!bridgeAuthoritative || bridgeAudioState.paused) {
      return false;
    }
    const bridgeSrc = String(bridgeAudioState.src || '').trim();
    return Boolean(currentSrc && bridgeSrc && sourcesShareTrackIdentity(bridgeSrc, currentSrc));
  };

  const requestPlayheadRender = (): void => {
    if (!panel || !isPlayheadTickEligible()) {
      return;
    }
    scheduleRender(state, settings, panel, pushDebug);
  };

  const readAudioBufferedAheadSec = (audio: HTMLAudioElement | null): number | null => {
    if (!audio || !Number.isFinite(audio.currentTime) || audio.buffered.length <= 0) {
      return null;
    }
    const currentTime = Number(audio.currentTime || 0);
    for (let index = 0; index < audio.buffered.length; index += 1) {
      const start = audio.buffered.start(index);
      const end = audio.buffered.end(index);
      if (currentTime >= start && currentTime <= end) {
        return Math.max(0, end - currentTime);
      }
    }
    return null;
  };

  const updateNativeSeekLifecycle = (audio: HTMLAudioElement | null, eventType: string): void => {
    if (!audio || !state.nativeSeekDebug.requestAt) {
      return;
    }
    const now = Date.now();
    if (now - state.nativeSeekDebug.requestAt > 8_000) {
      return;
    }
    if (eventType !== 'seeking' && eventType !== 'seeked' && eventType !== 'timeupdate') {
      return;
    }

    const currentTimeSec = Number.isFinite(audio.currentTime) ? Number(audio.currentTime || 0) : null;
    const durationSec = Number.isFinite(audio.duration) ? Number(audio.duration || 0) : null;
    const readyState = Number(audio.readyState);
    const networkState = Number(audio.networkState);
    const bufferedAheadSec = readAudioBufferedAheadSec(audio);

    state.nativeSeekDebug.lastEvent = eventType;
    state.nativeSeekDebug.lastEventAt = now;
    state.nativeSeekDebug.eventCurrentTimeSec = currentTimeSec;
    state.nativeSeekDebug.eventDurationSec = durationSec;
    state.nativeSeekDebug.eventReadyState = readyState;
    state.nativeSeekDebug.eventNetworkState = networkState;
    state.nativeSeekDebug.eventBufferedAheadSec = bufferedAheadSec;
    state.nativeSeekDebug.lastEventDetail =
      `t=${currentTimeSec !== null ? currentTimeSec.toFixed(2) : '-'}`
      + `/${durationSec !== null ? durationSec.toFixed(2) : '-'}`
      + ` ready=${readyState} network=${networkState} bufferedAhead=${bufferedAheadSec !== null ? bufferedAheadSec.toFixed(2) : '-'}`;

    if (eventType === 'seeking') {
      state.nativeSeekDebug.seekingAt = now;
      return;
    }
    if (eventType === 'seeked') {
      state.nativeSeekDebug.seekedAt = now;
      return;
    }
    if (
      eventType === 'timeupdate'
      && state.nativeSeekDebug.firstTimeupdateAt === 0
      && (state.nativeSeekDebug.seekingAt > 0 || state.nativeSeekDebug.seekedAt > 0)
    ) {
      state.nativeSeekDebug.firstTimeupdateAt = now;
    }
  };

  let shortcutPanelHandlers: PanelHandlers | null = null;
  const playbackHandoff = createPlaybackHandoff({
    context: 'player',
    onPauseRequested: () => {
      getPlaybackBridge()?.pause();
    },
    onShortcutCommand: (action) => {
      if (action === 'toggle-play-pause') {
        shortcutPanelHandlers?.onTogglePlayPause();
        return;
      }
      if (action === 'previous-track') {
        shortcutPanelHandlers?.onPrevTrack();
        return;
      }
      if (action === 'next-track') {
        shortcutPanelHandlers?.onNextTrack();
      }
    }
  });

  let externalSourceGuardUntil = 0;
  let pendingPageReleaseConfirmationSrc = '';
  let pendingPageReleaseConfirmationAt = 0;
  let pauseSourceGuardUntil = 0;
  let lastProbeApiRefreshAt = 0;
  let runtimePrepareInFlightKey = '';
  let runtimePrepareInFlightSource = '';
  let activePlaylistRuntimePredecodeSignature = '';
  const playlistRuntimePredecodeInFlightKeys = new Set<string>();
  const playlistRuntimePredecodeInFlightSources = new Set<string>();
  let playlistWarmToken = 0;
  const confirmPageReleaseSourceChange = (input: {
    previousSource: string;
    candidateSrc: string;
    candidateIsPageRelease: boolean;
    bridgeFresh: boolean;
    bridgeSrc: string;
    now: number;
  }): boolean => {
    const previousIsPageRelease = input.previousSource ? isPageReleaseSource(input.previousSource) : false;
    if (input.previousSource && !previousIsPageRelease && input.candidateIsPageRelease) {
      const bridgeMatchesCandidate = Boolean(input.bridgeFresh && input.bridgeSrc && input.bridgeSrc === input.candidateSrc);
      const samePendingCandidate = pendingPageReleaseConfirmationSrc === input.candidateSrc;
      if (!samePendingCandidate) {
        pendingPageReleaseConfirmationSrc = input.candidateSrc;
        pendingPageReleaseConfirmationAt = input.now;
      }
      const pendingAgeMs = samePendingCandidate ? input.now - pendingPageReleaseConfirmationAt : 0;
      const confirmedByStability = samePendingCandidate && pendingAgeMs >= PAGE_RELEASE_CONFIRM_MS;
      if (!bridgeMatchesCandidate && !confirmedByStability) {
        recordGuard(
          state,
          'source-change-delayed-page-confirm',
          `candidate=${input.candidateSrc} bridge=${input.bridgeSrc || '-'} ageMs=${pendingAgeMs}`
        );
        return false;
      }
    } else {
      pendingPageReleaseConfirmationSrc = '';
      pendingPageReleaseConfirmationAt = 0;
    }

    return true;
  };
  const shouldIgnoreReleaseFlash = (input: {
    bridgePlaying: boolean;
    candidateSrc: string;
    bridgeSrc: string;
  }): boolean => {
    if (!input.bridgePlaying || !input.candidateSrc || !input.bridgeSrc || input.candidateSrc === input.bridgeSrc) {
      return false;
    }

    const globals = getLatestPageGlobals(60_000);
    const pageTralbum = globals?.tralbum && typeof globals.tralbum === 'object'
      ? (globals.tralbum as TralbumLike)
      : null;
    if (!pageTralbum) {
      return false;
    }

    const candidateTrackId = readTrackIdFromUrl(input.candidateSrc);
    const bridgeTrackId = readTrackIdFromUrl(input.bridgeSrc);
    const candidateIsPageRelease = tralbumMatchesCurrentTrack(pageTralbum, candidateTrackId, input.candidateSrc);
    const bridgeIsPageRelease = tralbumMatchesCurrentTrack(pageTralbum, bridgeTrackId, input.bridgeSrc);
    if (candidateIsPageRelease && !bridgeIsPageRelease) {
      recordGuard(state, 'source-change-ignored-release-flash', `candidate=${input.candidateSrc} bridge=${input.bridgeSrc}`);
      return true;
    }

    return false;
  };
  const shouldIgnoreExternalGuardedRelease = (input: {
    now: number;
    candidateSrc: string;
    candidateIsPageRelease: boolean;
    bridgeFresh: boolean;
    bridgePaused: boolean;
    bridgeSrc: string;
  }): boolean => {
    const bridgeConfirmsCandidatePlayback = Boolean(
      input.bridgeFresh &&
      !input.bridgePaused &&
      input.bridgeSrc &&
      input.bridgeSrc === input.candidateSrc
    );

    if (input.now <= externalSourceGuardUntil && input.candidateIsPageRelease && !bridgeConfirmsCandidatePlayback) {
      recordGuard(state, 'source-change-ignored-external-guard', `candidate=${input.candidateSrc}`);
      return true;
    }

    return false;
  };
  const createRuntimeAudioDebugDefaults = (
    runtimeOwned = state.runtimePlaybackOwned
  ): NonNullable<PlayerState['runtimeAudioDebug']> => ({
    takeoverStage: 'idle',
    takeoverReason: '-',
    takeoverDetail: '-',
    takeoverTrace: [],
    armDetail: '-',
    prepareStage: 'idle',
    prepareReason: '-',
    prepareDetail: '-',
    prepareRequestKey: '',
    prepareSourceCacheKey: '',
    prepareFetchUrl: '',
    prepareInFlight: false,
    prepareHasPreparedTrack: false,
    prepareTrace: [],
    ownershipState: runtimeOwned ? 'runtime' : 'origin-started',
    firstOriginAvailable: !runtimeOwned,
    runtimeActive: false,
    runtimeOwned,
    runtimeSrc: '',
    runtimeReportedSrc: '',
    runtimePaused: true,
    runtimeTimeSec: 0,
    runtimeDurationSec: 0,
    handoverOriginSnapshotTimeSec: null,
    handoverSeekTargetTimeSec: null,
    handoverFirstRuntimeTimeSec: null,
    handoverFirstRuntimeDeltaSec: null,
    originMuteDetail: '-',
    hostLoadDetail: '-',
    hostResampleDetail: '-',
    hostLatencyDetail: '-',
    hostChurnDetail: '-',
    hostScheduleDetail: '-',
    hostFirstWindowDetail: '-',
    hostPairDetail: '-',
    awaitingFirstRuntimeSample: false,
    ts: Date.now()
  });
  const ensureRuntimeAudioDebug = (): NonNullable<PlayerState['runtimeAudioDebug']> => {
    if (!state.runtimeAudioDebug) {
      state.runtimeAudioDebug = createRuntimeAudioDebugDefaults();
    }
    return state.runtimeAudioDebug;
  };
  const resetRuntimeAudioDebugForSourceChange = (): void => {
    if (!state.runtimeAudioDebug) {
      return;
    }
    Object.assign(state.runtimeAudioDebug, createRuntimeAudioDebugDefaults(false));
  };
  const appendRuntimeDebugTrace = (trace: string[], entry: string): void => {
    if (!entry) {
      return;
    }
    if (trace[trace.length - 1] === entry) {
      return;
    }
    trace.push(entry);
    if (trace.length > 30) {
      trace.splice(0, trace.length - 30);
    }
  };
  const sanitizeRuntimeIncidentSource = (src: string): string => {
    const value = String(src || '').trim();
    if (!value) {
      return '-';
    }
    try {
      const url = new URL(value);
      const trackId = url.searchParams.get('track_id') || '';
      const pathTail = url.pathname.split('/').filter(Boolean).slice(-2).join('/') || url.hostname;
      return `${trackId ? `track=${trackId} ` : ''}${url.hostname}/${pathTail}`;
    } catch {
      return value.length > 48 ? `${value.slice(0, 18)}...${value.slice(-18)}` : value;
    }
  };
  const appendRuntimeIncidentEntry = (
    bucket: typeof state.runtimeAudioIncidentDebug.events,
    stage: string,
    detail: string
  ): void => {
    bucket.push({
      ts: Date.now(),
      transitionId: state.runtimeAudioIncidentDebug.currentTransitionId,
      stage: stage || '-',
      detail: detail || '-'
    });
    if (bucket.length > 80) {
      bucket.splice(0, bucket.length - 80);
    }
  };
  const updateRuntimeIncidentSummary = (): void => {
    const snapshot = state.runtimeAudioIncidentDebug;
    const transitionId = snapshot.currentTransitionId;
    if (!transitionId || transitionId === '-') {
      return;
    }
    const now = Date.now();
    let summary = snapshot.recentIncidents.find((entry) => entry.transitionId === transitionId);
    if (!summary) {
      summary = {
        transitionId,
        reason: snapshot.currentReason || '-',
        targetSrc: snapshot.targetSrc || '-',
        targetStage: snapshot.targetStage || 'idle',
        browserAudio: snapshot.browserAudio || '-',
        startedAt: now,
        updatedAt: now
      };
      snapshot.recentIncidents.push(summary);
      if (snapshot.recentIncidents.length > 6) {
        snapshot.recentIncidents.splice(0, snapshot.recentIncidents.length - 6);
      }
    }
    summary.reason = snapshot.currentReason || summary.reason || '-';
    summary.targetSrc = snapshot.targetSrc || summary.targetSrc || '-';
    summary.targetStage = snapshot.targetStage || summary.targetStage || 'idle';
    summary.browserAudio = snapshot.browserAudio || summary.browserAudio || '-';
    summary.updatedAt = now;
  };
  const appendRuntimeIncidentWarning = (stage: string, detail: string): void => {
    const warnings = state.runtimeAudioIncidentDebug.warnings;
    const last = warnings[warnings.length - 1];
    if (
      last &&
      last.transitionId === state.runtimeAudioIncidentDebug.currentTransitionId &&
      last.stage === stage &&
      last.detail === detail
    ) {
      return;
    }
    appendRuntimeIncidentEntry(warnings, stage, detail);
  };
  const startRuntimeIncidentTransition = (reason: string, targetSrc = state.currentSrc): void => {
    state.runtimeAudioIncidentDebug.transitionSeq += 1;
    state.runtimeAudioIncidentDebug.currentTransitionId = `audio-${state.runtimeAudioIncidentDebug.transitionSeq}`;
    state.runtimeAudioIncidentDebug.currentReason = reason || '-';
    state.runtimeAudioIncidentDebug.targetSrc = sanitizeRuntimeIncidentSource(targetSrc);
    state.runtimeAudioIncidentDebug.targetStage = 'requested';
    state.runtimeAudioIncidentDebug.browserAudio = '-';
    updateRuntimeIncidentSummary();
  };
  const ensureRuntimeIncidentTransition = (reason: string): void => {
    if (state.runtimeAudioIncidentDebug.currentTransitionId === '-') {
      startRuntimeIncidentTransition(reason);
      return;
    }
    state.runtimeAudioIncidentDebug.currentReason = state.runtimeAudioIncidentDebug.currentReason || reason || '-';
  };
  const countCurrentRuntimeIncidentStage = (stage: string): number =>
    state.runtimeAudioIncidentDebug.events.filter((event) =>
      event.transitionId === state.runtimeAudioIncidentDebug.currentTransitionId &&
      event.stage === stage
    ).length;
  const updateRuntimeIncidentStage = (reason: string, stage: string, detail = '-'): void => {
    const nextTargetSrc = sanitizeRuntimeIncidentSource(state.currentSrc);
    const startsTempoAdjustLoadIncident =
      stage === 'loading-track' &&
      reason === 'tempo-adjust' &&
      state.runtimeAudioIncidentDebug.targetSrc !== nextTargetSrc;
    if (
      stage === 'runtime-playlist-load-enqueued' ||
      stage === 'runtime-waiting-for-prepared' ||
      stage === 'seek-dispatch' ||
      startsTempoAdjustLoadIncident
    ) {
      startRuntimeIncidentTransition(reason);
    } else {
      ensureRuntimeIncidentTransition(reason);
    }

    if (stage === 'runtime-waiting-for-prepared') {
      state.runtimeAudioIncidentDebug.targetStage = 'runtime-pending';
    } else if (stage === 'loading-track') {
      if (countCurrentRuntimeIncidentStage('loading-track') > 0) {
        appendRuntimeIncidentWarning(
          'duplicate-host-load-detected',
          `${reason} loaded after another transition load`
        );
      }
      state.runtimeAudioIncidentDebug.targetStage = 'host-loading';
    } else if (stage === 'host-load') {
      state.runtimeAudioIncidentDebug.targetStage = 'host-loaded';
    } else if (stage === 'host-play-scheduled') {
      state.runtimeAudioIncidentDebug.targetStage = 'schedule-ready';
    } else if (stage === 'host-first-window') {
      state.runtimeAudioIncidentDebug.targetStage = 'playing';
      const peakMatch = /peak=([0-9.]+)/.exec(detail);
      const firstWindowPeak = peakMatch ? Number(peakMatch[1]) : NaN;
      if (Number.isFinite(firstWindowPeak) && firstWindowPeak > RUNTIME_FIRST_WINDOW_PEAK_WARN) {
        appendRuntimeIncidentWarning(
          'host-first-window-clip',
          `peak=${firstWindowPeak.toFixed(4)} threshold=${RUNTIME_FIRST_WINDOW_PEAK_WARN}`
        );
      }
    } else if (stage === 'host-load-stall') {
      const gapMatch = /maxGapMs=([0-9]+)/.exec(detail);
      const maxGapMs = gapMatch ? Number(gapMatch[1]) : NaN;
      if (Number.isFinite(maxGapMs) && maxGapMs > RUNTIME_LOAD_STALL_WARN_MS) {
        appendRuntimeIncidentWarning('host-load-stall', `${detail} threshold=${RUNTIME_LOAD_STALL_WARN_MS}`);
      }
    } else if (stage === 'runtime-seek-skipped') {
      state.runtimeAudioIncidentDebug.targetStage = 'native-seek';
    } else if (stage === 'ownership-transferred' || stage === 'runtime-playlist-ownership-taken') {
      state.runtimeAudioIncidentDebug.targetStage = 'playing';
    } else if (stage.startsWith('origin-muted-before-')) {
      const targetStage = state.runtimeAudioIncidentDebug.targetStage;
      const isProtectedRuntimeHandover = stage === 'origin-muted-before-runtime-work';
      if (
        !isProtectedRuntimeHandover &&
        targetStage !== 'host-loaded' &&
        targetStage !== 'schedule-ready' &&
        targetStage !== 'playing'
      ) {
        appendRuntimeIncidentWarning('origin-muted-before-host-ready', `stage=${targetStage}`);
      }
    } else if (stage === 'host-player-stop-ack' || stage === 'host-stop-timing') {
      const targetStage = state.runtimeAudioIncidentDebug.targetStage;
      if (targetStage === 'host-loaded' || targetStage === 'schedule-ready') {
        appendRuntimeIncidentWarning('stop-dropped-target-buffer', `stage=${targetStage}`);
      }
    } else if (stage === 'host-context-stats') {
      state.runtimeAudioIncidentDebug.browserAudio = detail || '-';
    }
    updateRuntimeIncidentSummary();
  };
  const recordRuntimeIncidentDebug = (reason: string, stage: string, detail: string): void => {
    updateRuntimeIncidentStage(reason, stage, detail);
    appendRuntimeIncidentEntry(state.runtimeAudioIncidentDebug.events, stage, detail || '-');
    if (
      stage.includes('timing') ||
      stage.startsWith('host-player-') ||
      stage === 'host-context-stats'
    ) {
      appendRuntimeIncidentEntry(state.runtimeAudioIncidentDebug.timings, stage, detail || '-');
    }
  };
  const recordRuntimePrepareDebug = (
    reason: string,
    stage: string,
    detail: string,
    info?: {
      requestKey?: string;
      sourceCacheKey?: string;
      fetchUrl?: string;
      hasPreparedTrack?: boolean;
      inFlight?: boolean;
    }
  ): void => {
    const debug = ensureRuntimeAudioDebug();
    debug.prepareStage = stage;
    debug.prepareReason = reason;
    debug.prepareDetail = detail || '-';
    if (typeof info?.requestKey === 'string') {
      debug.prepareRequestKey = info.requestKey;
    }
    if (typeof info?.sourceCacheKey === 'string') {
      debug.prepareSourceCacheKey = info.sourceCacheKey;
    }
    if (typeof info?.fetchUrl === 'string') {
      debug.prepareFetchUrl = info.fetchUrl;
    }
    if (typeof info?.hasPreparedTrack === 'boolean') {
      debug.prepareHasPreparedTrack = info.hasPreparedTrack;
    }
    if (typeof info?.inFlight === 'boolean') {
      debug.prepareInFlight = info.inFlight;
    }
    debug.ts = Date.now();
    appendRuntimeDebugTrace(debug.prepareTrace, `${reason}→${stage}${detail ? `(${detail})` : ''}`);
    if (reason !== 'playlist-runtime-predecode') {
      recordRuntimeIncidentDebug(reason, `prepare-${stage}`, detail || '-');
    }
    syncRuntimeAudioEngineDebug();
    requestRender();
  };
  const syncRuntimeAudioEngineDebug = (): void => {
    state.runtimeAudioEngineDebug = runtimeAudioEngine.getDebugSnapshot();
  };
  const setRuntimeTempoAdjustReady = (ready: boolean): void => {
    if (state.runtimeTempoAdjustReady === ready) {
      return;
    }
    state.runtimeTempoAdjustReady = ready;
    requestRender();
  };
  const syncRuntimeTempoAdjustReady = (): void => {
    const currentSrc = String(state.currentSrc || '').trim();
    const capabilityReady = Boolean(state.runtimeStretchCapability?.supported);
    const preparedMatch = currentSrc ? runtimeAudioEngine.findPrepared(currentSrc) : null;
    const preparedReady = Boolean(preparedMatch);
    setRuntimeTempoAdjustReady(capabilityReady && preparedReady);
  };
  const shouldPrepareRuntimeForTempoAdjust = (): boolean =>
    !state.runtimePlaybackOwned && state.tempoAdjustOffsetBpm !== 0;
  const shouldPrepareRuntimeForPlaybackHandoff = (reason: string): boolean =>
    reason === 'seek-intent' || reason === 'runtime-playlist-selection-intent';
  const buildPlaylistRuntimePredecodeSignature = (tracks: PlaylistTrack[], startIndex: number): string =>
    `${startIndex}|${tracks
      .map((track) => String(track.trackId || track.cacheKey || track.streamUrl || '').trim())
      .filter(Boolean)
      .join('|')}`;
  // Predecode window = current + N-ahead + a small look-behind, so jumping BACK to a
  // recently-played track is instant too (not just forward). Built in priority order —
  // current first, then ahead (the likely next), then behind — because predecode is
  // concurrency-limited and the earliest entries are prepared first.
  const PLAYLIST_PREDECODE_LOOKBEHIND = 2;
  const buildPlaylistRuntimePredecodeQueue = (tracks: PlaylistTrack[], startIndex: number): number[] => {
    const total = tracks.length;
    const windowSize = Math.min(total, runtimePredecodePolicy.windowTracks);
    if (windowSize <= 0) {
      return [];
    }
    const lookbehind = Math.min(PLAYLIST_PREDECODE_LOOKBEHIND, Math.max(0, windowSize - 1));
    const lookahead = windowSize - 1 - lookbehind;
    const ordered: number[] = [startIndex];
    for (let offset = 1; offset <= lookahead; offset += 1) {
      ordered.push((startIndex + offset) % total);
    }
    for (let offset = 1; offset <= lookbehind; offset += 1) {
      ordered.push(((startIndex - offset) % total + total) % total);
    }
    const seen = new Set<number>();
    const queue: number[] = [];
    for (const index of ordered) {
      if (seen.has(index)) {
        continue; // small playlists wrap; avoid preparing the same track twice
      }
      seen.add(index);
      if (isTrackPlayable(tracks[index])) {
        queue.push(index);
      }
    }
    return queue;
  };
  const buildMissingPlaylistRuntimePredecodeQueue = (tracks: PlaylistTrack[], startIndex: number): number[] =>
    buildPlaylistRuntimePredecodeQueue(tracks, startIndex)
      .filter((index) => {
        const streamUrl = String(tracks[index]?.streamUrl || '').trim();
        return Boolean(streamUrl) && !runtimeAudioEngine.findPrepared(streamUrl);
      });
  const resolveRuntimePredecodeInFlightKey = (
    sourceCacheKey: string,
    fetchUrl: string,
    sourceUrl: string
  ): string =>
    sourceCacheKey || normalizeCacheKey(fetchUrl || sourceUrl) || String(fetchUrl || sourceUrl || '').trim();
  const isPlaylistRuntimePredecodeInFlightFor = (input: {
    sourceCacheKey: string;
    redirectUrl: string;
    fetchUrl: string;
  }): boolean => {
    const requestKey = resolveRuntimePredecodeInFlightKey(input.sourceCacheKey, input.fetchUrl, input.redirectUrl);
    if (requestKey && playlistRuntimePredecodeInFlightKeys.has(requestKey)) {
      return true;
    }
    const candidateSources = [input.redirectUrl, input.fetchUrl].filter(Boolean);
    return candidateSources.some((candidate) =>
      Array.from(playlistRuntimePredecodeInFlightSources).some((activeSource) =>
        sourcesShareTrackIdentity(candidate, activeSource)
      )
    );
  };
  type RuntimePrepareDecision =
    | { action: 'prepare' }
    | { action: 'defer'; detail: string }
    | { action: 'skip'; stage: 'skip' | 'skip-prepared' | 'skip-in-flight'; detail: string };
  const resolveCurrentRuntimePrepareDecision = (input: {
    redirectUrl: string;
    fetchUrl: string;
    fetchStrategy: string;
    requestKey: string;
    inFlightSource: string;
    hasPreparedRuntimeTrack: boolean;
    prepareForPlaybackHandoff: boolean;
  }): RuntimePrepareDecision => {
    const runtimePrepareNeeded = shouldPrepareRuntimeForTempoAdjust() || input.prepareForPlaybackHandoff;

    // Idle prewarm can wait for a canonical CDN URL, but once the user is
    // actively adjusting tempo we should prepare from the live redirect URL
    // immediately so takeover is ready for the current track.
    const runtimePrepareBlockedReason =
      !runtimePrepareNeeded
      && input.fetchStrategy === 'source'
      && isBandcampStreamRedirectUrl(input.fetchUrl)
        ? 'source-redirect-pending-resolution'
        : '';
    if (runtimePrepareBlockedReason) {
      return { action: 'skip', stage: 'skip', detail: runtimePrepareBlockedReason };
    }

    if (input.hasPreparedRuntimeTrack) {
      return { action: 'skip', stage: 'skip-prepared', detail: 'prepared-track-ready' };
    }

    const matchingInFlightSource = Boolean(
      input.inFlightSource &&
      (
        sourcesShareTrackIdentity(input.redirectUrl, input.inFlightSource) ||
        sourcesShareTrackIdentity(input.fetchUrl, input.inFlightSource)
      )
    );
    if (input.requestKey === runtimePrepareInFlightKey || matchingInFlightSource) {
      return { action: 'skip', stage: 'skip-in-flight', detail: 'matching-prepare-in-flight' };
    }

    if (!input.prepareForPlaybackHandoff && shouldDeferCurrentRuntimePrepare(input.redirectUrl)) {
      return { action: 'defer', detail: 'current-bpm-priority' };
    }

    return { action: 'prepare' };
  };
  const isPlaylistRuntimePredecodeRunCurrent = (token: number): boolean =>
    token === playlistWarmToken;

  const warmDecodeForCurrentSource = (
    reason: string,
    expectedSourceVersion = state.sourceVersion
  ): void => {
    // Ownership contract:
    // - first play stays on Bandcamp/native audio
    // - a resolved playlist prepares a rolling current-plus-next-nine window
    // - an unresolved origin track starts current-track work only for an
    //   explicit seek or tempo intent
    const prepareForPlaybackHandoff = shouldPrepareRuntimeForPlaybackHandoff(reason);
    if (reason !== 'tempo-adjust-intent' && !prepareForPlaybackHandoff) {
      warmDecodeForPlaylistTracks();
      return;
    }

    if (reason === 'tempo-adjust-intent' && state.runtimePlaybackOwned) {
      recordRuntimePrepareDebug(reason, 'skip', 'runtime-already-owned', {
        requestKey: '',
        sourceCacheKey: '',
        fetchUrl: state.currentSrc,
        hasPreparedTrack: Boolean(state.currentSrc && runtimeAudioEngine.findPrepared(state.currentSrc)),
        inFlight: false
      });
      return;
    }

    const redirectUrl = String(state.currentSrc || '').trim();
    if (!redirectUrl) {
      runtimePrepareInFlightKey = '';
      runtimePrepareInFlightSource = '';
      recordRuntimePrepareDebug(reason, 'clear', 'missing-current-src', {
        requestKey: '',
        sourceCacheKey: '',
        fetchUrl: '',
        hasPreparedTrack: false,
        inFlight: false
      });
      setRuntimeTempoAdjustReady(false);
      return;
    }
    const fetchTarget = resolveCanonicalPlaybackFetchTarget(redirectUrl);
    const fetchUrl = fetchTarget.url;
    const sourceCacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, redirectUrl, {
      includePageUrl: true
    });
    // Deduplicate runtime prep by stable track identity first. Bandcamp stream URLs
    // carry short-lived tokens, so keying by fetchUrl causes unnecessary re-prepare
    // work when the same track is rediscovered through a fresher CDN URL.
    const requestKey = `${expectedSourceVersion}|${sourceCacheKey || fetchUrl || redirectUrl}`;

    const preparedMatch = runtimeAudioEngine.findPrepared(redirectUrl);
    const hasPreparedRuntimeTrack = Boolean(preparedMatch);
    const playlistPredecodeInFlight = isPlaylistRuntimePredecodeInFlightFor({
      sourceCacheKey,
      redirectUrl,
      fetchUrl
    });
    const matchingRuntimePrepareInFlight = Boolean(
      runtimePrepareInFlightKey &&
      (
        requestKey === runtimePrepareInFlightKey ||
        (
          runtimePrepareInFlightSource &&
          (
            sourcesShareTrackIdentity(redirectUrl, runtimePrepareInFlightSource) ||
            sourcesShareTrackIdentity(fetchUrl, runtimePrepareInFlightSource)
          )
        )
      )
    );

    if (playlistPredecodeInFlight && !hasPreparedRuntimeTrack) {
      recordRuntimePrepareDebug(reason, 'skip-in-flight', 'playlist-predecode-in-flight', {
        requestKey,
        sourceCacheKey,
        fetchUrl,
        hasPreparedTrack: false,
        inFlight: true
      });
      return;
    }

    const prepareDecision = resolveCurrentRuntimePrepareDecision({
      redirectUrl,
      fetchUrl,
      fetchStrategy: fetchTarget.strategy,
      requestKey,
      inFlightSource: runtimePrepareInFlightSource,
      hasPreparedRuntimeTrack,
      prepareForPlaybackHandoff
    });

    if (prepareDecision.action === 'defer') {
      recordRuntimePrepareDebug(
        reason,
        'defer',
        prepareDecision.detail,
        {
          requestKey,
          sourceCacheKey,
          fetchUrl,
          hasPreparedTrack: hasPreparedRuntimeTrack,
          inFlight: matchingRuntimePrepareInFlight
        }
      );
      return;
    }

    if (prepareDecision.action === 'skip') {
      recordRuntimePrepareDebug(
        reason,
        prepareDecision.stage,
        prepareDecision.detail,
        {
          requestKey,
          sourceCacheKey,
          fetchUrl,
          hasPreparedTrack: hasPreparedRuntimeTrack,
          inFlight: matchingRuntimePrepareInFlight
        }
      );
      if (hasPreparedRuntimeTrack) {
        warmDecodeForPlaylistTracks();
      }
      return;
    }

    runtimePrepareInFlightKey = requestKey;
    runtimePrepareInFlightSource = fetchUrl || redirectUrl;
    setRuntimeTempoAdjustReady(false);
    recordRuntimePrepareDebug(reason, 'start', `runtime-prepare-requested:${fetchTarget.strategy}`, {
      requestKey,
      sourceCacheKey,
      fetchUrl,
      hasPreparedTrack: hasPreparedRuntimeTrack,
      inFlight: true
    });
    // Runtime prepare is the only playback-side owner here. Current-track BPM and
    // waveform hydration stay on the analysis request path so we do not open a
    // separate background warm-decode branch for the same track.
    const prepareKey = requestKey;
    const preparePromise = runtimeAudioEngine.prepareTrack({
      url: fetchUrl,
      cacheKey: sourceCacheKey || undefined,
      sourceVersion: expectedSourceVersion
    });
    syncRuntimeAudioEngineDebug();
    requestRender();
    void preparePromise.then((prepared) => {
        if (runtimePrepareInFlightKey === prepareKey) {
          runtimePrepareInFlightKey = '';
          runtimePrepareInFlightSource = '';
        }
        if (!prepared.ok) {
          recordRuntimePrepareDebug(reason, 'failed', String(prepared.reason || 'prepare-failed'), {
            requestKey: prepareKey,
            sourceCacheKey,
            fetchUrl,
            hasPreparedTrack: false,
            inFlight: false
          });
          syncRuntimeTempoAdjustReady();
          return;
        }
        recordRuntimePrepareDebug(reason, 'ready', 'prepared-track-ready', {
          requestKey: prepareKey,
          sourceCacheKey,
          fetchUrl,
          hasPreparedTrack: true,
          inFlight: false
        });
        syncRuntimeTempoAdjustReady();
        runtimeAudioController?.onPreparedTrackReady();
        warmDecodeForPlaylistTracks();
      }).catch((error) => {
        if (runtimePrepareInFlightKey === prepareKey) {
          runtimePrepareInFlightKey = '';
          runtimePrepareInFlightSource = '';
        }
        recordRuntimePrepareDebug(
          reason,
          'failed',
          error instanceof Error ? error.message : String(error),
          {
            requestKey: prepareKey,
            sourceCacheKey,
            fetchUrl,
            hasPreparedTrack: false,
            inFlight: false
          }
        );
        syncRuntimeTempoAdjustReady();
        console.warn('[PLAYER] runtime audio prepare failed', {
          error,
          url: fetchUrl,
          cacheKey: sourceCacheKey
        });
      });
  };

  // Lever (2): the lookahead predecode is non-urgent — the current track plays
  // via origin and runtime takeover is idle — so hold it until the current
  // track's waveform has settled (its audio download+decode is done). That gives
  // the current waveform the fetch pipe to itself instead of competing with a
  // full-playlist predecode burst on a new-album switch. onWaveformSettled
  // re-invokes warmDecodeForPlaylistTracks, and a max-wait timer guarantees the
  // lookahead still runs if analysis is disabled, fails, or stalls.
  const LOOKAHEAD_PREDECODE_MAX_WAIT_MS = 3000;
  let lookaheadPredecodeGateVersion = -1;
  // Source version for which the max-wait elapsed and the gate was forced open,
  // so lookahead predecode runs even if the current waveform never settles.
  let lookaheadPredecodeGateExpiredVersion = -1;
  let lookaheadPredecodeGateTimer: number | null = null;
  const isCurrentSourceWaveformReady = (): boolean => {
    const currentSrc = String(state.currentSrc || '').trim();
    if (!currentSrc) {
      return true;
    }
    const analysis = state.lastAnalysis;
    if (analysis && String(analysis.sourceUrl || '').trim() === currentSrc && analysis.waveform) {
      return true;
    }
    const cacheKey = resolveSourceTrackCacheKey(state.playlist.tracks, currentSrc, { includePageUrl: true });
    return Boolean(cacheKey && playlistWaveformByCacheKey.get(cacheKey));
  };
  const isLookaheadPredecodeGateOpen = (): boolean =>
    lookaheadPredecodeGateExpiredVersion === state.sourceVersion || isCurrentSourceWaveformReady();
  const clearLookaheadPredecodeGateTimer = (): void => {
    if (lookaheadPredecodeGateTimer !== null) {
      window.clearTimeout(lookaheadPredecodeGateTimer);
      lookaheadPredecodeGateTimer = null;
    }
  };

  const warmDecodeForPlaylistTracks = (): void => {
    if (!settings.preloadTracksEnabled) {
      return;
    }
    const tracks = state.playlist.tracks;
    if (tracks.length === 0) {
      return;
    }
    // Hold lookahead predecode until the current track's waveform has settled,
    // or until the max-wait timer forces the gate open (so a failed/disabled
    // waveform can't strand the rest of the playlist's predecode).
    if (!isLookaheadPredecodeGateOpen()) {
      if (lookaheadPredecodeGateVersion !== state.sourceVersion) {
        lookaheadPredecodeGateVersion = state.sourceVersion;
        clearLookaheadPredecodeGateTimer();
        const gateVersion = state.sourceVersion;
        lookaheadPredecodeGateTimer = window.setTimeout(() => {
          lookaheadPredecodeGateTimer = null;
          if (gateVersion === state.sourceVersion) {
            lookaheadPredecodeGateExpiredVersion = gateVersion;
            warmDecodeForPlaylistTracks();
          }
        }, LOOKAHEAD_PREDECODE_MAX_WAIT_MS);
      }
      recordRuntimePrepareDebug('playlist-runtime-predecode', 'defer', 'await-current-waveform', {
        hasPreparedTrack: false
      });
      return;
    }
    clearLookaheadPredecodeGateTimer();
    const startIndex = state.playlist.currentIndex;
    const playlistSignature = buildPlaylistRuntimePredecodeSignature(tracks, startIndex);
    if (!playlistSignature) {
      return;
    }
    const queue = buildMissingPlaylistRuntimePredecodeQueue(tracks, startIndex);
    if (queue.length === 0) {
      playlistRuntimePredecodeInFlightKeys.clear();
      playlistRuntimePredecodeInFlightSources.clear();
      recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'playlist-predecode-complete', {
        hasPreparedTrack: false
      });
      return;
    }
    const predecodeSignature = playlistSignature;
    if (predecodeSignature === activePlaylistRuntimePredecodeSignature) {
      recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'playlist-predecode-in-flight', {
        hasPreparedTrack: false,
        inFlight: true
      });
      return;
    }

    activePlaylistRuntimePredecodeSignature = predecodeSignature;
    const token = ++playlistWarmToken;
    const startSourceVersion = state.sourceVersion;

    void (async () => {
      let nextQueueOffset = 0;
      const runNextPredecode = async (): Promise<void> => {
        while (isPlaylistRuntimePredecodeRunCurrent(token)) {
          const trackIndex = queue[nextQueueOffset];
          nextQueueOffset += 1;
          if (!Number.isFinite(trackIndex)) {
            return;
          }
          const track = state.playlist.tracks[trackIndex];
          const streamUrl = String(track?.streamUrl || '').trim();
          if (!streamUrl) {
            recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'no-stream-url', {
              hasPreparedTrack: false
            });
            continue;
          }
          if (runtimeAudioEngine.findPrepared(streamUrl)) {
            recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'already-prepared', {
              fetchUrl: streamUrl,
              hasPreparedTrack: true
            });
            continue;
          }
          const fetchTarget = resolveCanonicalPlaybackFetchTarget(streamUrl);
          const fetchUrl = fetchTarget.url;
          if (!fetchUrl) {
            recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'no-fetch-url', {
              fetchUrl: streamUrl,
              hasPreparedTrack: false
            });
            continue;
          }
          const sourceCacheKey = resolveSourceTrackCacheKey(tracks, streamUrl, {
            includePageUrl: true
          });
          const inFlightKey = resolveRuntimePredecodeInFlightKey(sourceCacheKey, fetchUrl, streamUrl);
          const currentPrepareInFlight = Boolean(
            runtimePrepareInFlightSource &&
            (
              sourcesShareTrackIdentity(streamUrl, runtimePrepareInFlightSource) ||
              sourcesShareTrackIdentity(fetchUrl, runtimePrepareInFlightSource)
            )
          );
          if (
            currentPrepareInFlight ||
            (
              inFlightKey &&
              (
                playlistRuntimePredecodeInFlightKeys.has(inFlightKey) ||
                isPlaylistRuntimePredecodeInFlightFor({
                  sourceCacheKey,
                  redirectUrl: streamUrl,
                  fetchUrl
                })
              )
            )
          ) {
            recordRuntimePrepareDebug('playlist-runtime-predecode', 'skip', 'playlist-track-in-flight', {
              sourceCacheKey,
              fetchUrl,
              hasPreparedTrack: false,
              inFlight: true
            });
            continue;
          }
          recordRuntimePrepareDebug(
            'playlist-runtime-predecode',
            'start',
            `predecode-playlist-track-${trackIndex}:${fetchTarget.strategy}`,
            {
              sourceCacheKey,
              fetchUrl,
              hasPreparedTrack: false
            }
          );
          if (inFlightKey) {
            playlistRuntimePredecodeInFlightKeys.add(inFlightKey);
          }
          playlistRuntimePredecodeInFlightSources.add(streamUrl);
          playlistRuntimePredecodeInFlightSources.add(fetchUrl);
          try {
            const preparePromise = runtimeAudioEngine.prepareTrack({
              url: fetchUrl,
              cacheKey: sourceCacheKey || undefined,
              sourceVersion: startSourceVersion
            });
            syncRuntimeAudioEngineDebug();
            requestRender();
            const prepared = await preparePromise;
            if (
              prepared.ok &&
              runtimeAudioController &&
              state.currentSrc &&
              (
                sourcesShareTrackIdentity(state.currentSrc, streamUrl) ||
                sourcesShareTrackIdentity(state.currentSrc, fetchUrl)
              )
            ) {
              // A user may select a track already being decoded by this older
              // warm-up run. Notify the pending runtime owner before stale-run
              // bookkeeping exits so the selected track can begin playback.
              runtimeAudioController.onPreparedTrackReady();
            }
            if (!isPlaylistRuntimePredecodeRunCurrent(token)) {
              return;
            }
            if (!prepared.ok) {
              recordRuntimePrepareDebug('playlist-runtime-predecode', 'failed', String(prepared.reason || 'prepare-failed'), {
                fetchUrl,
                hasPreparedTrack: false
              });
              continue;
            }
            recordRuntimePrepareDebug('playlist-runtime-predecode', 'ready', `playlist-track-prepared-${trackIndex}`, {
              sourceCacheKey,
              fetchUrl,
              hasPreparedTrack: true
            });
          } catch (error) {
            if (!isPlaylistRuntimePredecodeRunCurrent(token)) {
              return;
            }
            recordRuntimePrepareDebug(
              'playlist-runtime-predecode',
              'failed',
              error instanceof Error ? error.message : String(error),
              {
                fetchUrl,
                hasPreparedTrack: false
              }
            );
          } finally {
            if (inFlightKey) {
              playlistRuntimePredecodeInFlightKeys.delete(inFlightKey);
            }
            playlistRuntimePredecodeInFlightSources.delete(streamUrl);
            playlistRuntimePredecodeInFlightSources.delete(fetchUrl);
          }
        }
      };
      try {
        const workerCount = Math.max(1, Math.min(runtimePredecodePolicy.maxConcurrentPredecode, queue.length));
        await Promise.all(Array.from({ length: workerCount }, () => runNextPredecode()));
      } finally {
        if (activePlaylistRuntimePredecodeSignature === predecodeSignature) {
          activePlaylistRuntimePredecodeSignature = '';
          playlistRuntimePredecodeInFlightKeys.clear();
          playlistRuntimePredecodeInFlightSources.clear();
        }
      }
    })();
  };

  const isBpmAnalysisInProgressForCurrentSource = (): boolean =>
    isBpmAnalysisInProgressForSource(state.lastAnalysis, String(state.currentSrc || ''));

  const resolveKeyStatusFromResult = (
    keyAnalysis: KeyAnalysisResult | null | undefined
  ): AnalysisResult['keyStatus'] =>
    resolveKeyStatusFromAnalysis(settings.keyAnalysisEnabled, keyAnalysis);

  const likeCtrl = createLikeController({
    getState: () => state,
    getCurrentSrc: () => String(state.currentSrc || '').trim(),
    getPlaylistTracks: () => state.playlist.tracks,
    getPlaylistCurrentIndex: () => state.playlist.currentIndex,
    getSourceVersion: () => state.sourceVersion,
    hasPlaybackStarted: () => state.hasPlaybackStarted,
    isCurrentSourceContextReadyForAnalysis,
    getLockedAlbumLikeIdentity: () => lockedAlbumLikeIdentity,
    getLatestAlbumLikeIdentity: () => latestAlbumLikeIdentity,
    getLikesController: () => likesController,
    resolveFanRootSyncPageContext,
    resolveRuntimeLikeContext,
    requestRender,
    // Forward-reference: assigned after preloadCtrl is created
    maybeStartCurrentSourceBackgroundPhase: () => preloadCtrl.maybeStartCurrentSourceBackgroundPhase(),
    isRecommendationsLikeContext
  });

  const concurrency = deriveConcurrencyConfig(resolveWorkerCount());
  const preloadCtrl = createPreloadController({
    getState: () => state,
    getSourceVersion: () => state.sourceVersion,
    getCurrentSrc: () => String(state.currentSrc || '').trim(),
    getPlaylistTracks: () => state.playlist.tracks,
    getPlaylistCurrentIndex: () => state.playlist.currentIndex,
    isPreloadTracksEnabled: () => settings.preloadTracksEnabled,
    isKeyAnalysisEnabled: () => settings.keyAnalysisEnabled,
    resolvePreloadStartupBlockReason,
    isCurrentSourcePreloadPhaseReady,
    resolvePreloadTargetKey,
    hasCachedBpm: (cacheKey) => hasCachedPlaylistBpm(cacheKey),
    setCachedBpm: (cacheKey, bpm) => setCachedPlaylistBpm(cacheKey, bpm),
    canAttemptAnalysis,
    registerAnalysisAttempt,
    setPlaylistTrackAnalyzing,
    clearPlaylistTrackAnalyzing,
    getPlaylistBpmByCacheKey: () => playlistBpmByCacheKey,
    getPlaylistKeyAnalysisByCacheKey: () => playlistKeyAnalysisByCacheKey,
    getPlaylistWaveformByCacheKey: () => playlistWaveformByCacheKey,
    getPlaylistAnalyzingCacheKeys: () => playlistAnalyzingCacheKeys,
    getPlaylistFailedCacheKeys: () => playlistFailedCacheKeys,
    getPlaylistAttemptCountByCacheKey: () => playlistAttemptCountByCacheKey,
    getPlaylistConfidenceByCacheKey: () => playlistConfidenceByCacheKey,
    getPlaylistAnalysisCache: () => playlistAnalysisCache,
    requestRender,
    pushDebug: (title, sectionsFactory) => pushDebug(title, sectionsFactory),
    maybeStartCurrentSourceDeepLikePhase: () => likeCtrl.maybeStartCurrentSourceDeepLikePhase(),
    maybeStartCurrentSourceLikePhases: (force) => likeCtrl.maybeStartCurrentSourceLikePhases(force),
    getActiveTempoTrackCacheKey: () => analysisReqCtrl.getActiveTempoTrackCacheKey(),
    setActiveTempoTrackCacheKey: (key) => analysisReqCtrl.setActiveTempoTrackCacheKey(key),
    getLastAnalysis: () => state.lastAnalysis,
    setPlaylist: (playlist) => { state.playlist = playlist; }
  }, {
    maxConcurrentPreloads: concurrency.maxConcurrentPreloads,
    maxConcurrentKeyAnalyses: concurrency.maxConcurrentKeyAnalyses
  });
  const { preloader } = preloadCtrl;
  const syncPreloadQueue = preloadCtrl.syncPreloadQueue;
  const cancelPreloadKeyPass = preloadCtrl.cancelPreloadKeyPass;
  const resetPreloadBpmBatchGate = preloadCtrl.resetPreloadBpmBatchGate;
  const resetPreloadFailureEpoch = preloadCtrl.resetPreloadFailureEpoch;
  const applyPlaylistAnalysisDecorations = preloadCtrl.applyPlaylistAnalysisDecorations;

  analysisReqCtrl = createAnalysisRequestController({
    getCurrentSourceUrl: () => String(state.currentSrc || '').trim(),
    getRequestSeed: () => `${state.sourceVersion}`,
    isStale: (capturedSeed, sourceUrl) =>
      capturedSeed !== `${state.sourceVersion}`
      || String(state.currentSrc || '').trim() !== sourceUrl,
    isKeyAnalysisEnabled: () => settings.keyAnalysisEnabled,
    isContextReadyForKeyAnalysis: () => isCurrentSourceContextReadyForAnalysis(),
    resolveSourceCacheKey: (sourceUrl) =>
      resolveSourceTrackCacheKey(state.playlist.tracks, sourceUrl, { includePageUrl: true }),
    resolveFetchUrl: (sourceUrl) =>
      String(sourceUrl || '').trim() === String(state.currentSrc || '').trim()
        ? resolveCurrentTrackAnalysisFetchUrl()
        : '',
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
    canAttemptAnalysis: (cacheKey) => canAttemptAnalysis(cacheKey),
    registerAttempt: (cacheKey) => registerAnalysisAttempt(cacheKey),
    setTrackAnalyzing: (cacheKey, analyzing) => setPlaylistTrackAnalyzing(cacheKey, analyzing),
    getTrace: () => state.keyAnalysisTrace,
    getAnalysis: () => state.lastAnalysis,
    setAnalysis: (analysis) => {
      state.lastAnalysis = analysis;
      applyPlayerTempoAdjust(state, getPlaybackBridge());
    },
    getAnalysisRunId: () => state.analysisRunId,
    incrementAnalysisRunId: () => { state.analysisRunId += 1; return state.analysisRunId; },
    resolveKeyStatus: (keyAnalysis) => resolveKeyStatusFromResult(keyAnalysis),
    getBpmCacheMap: () => playlistBpmByCacheKey,
    render: () => requestRender(),
    syncPreloadQueue: () => syncPreloadQueue(state.sourceVersion),
    applyDecorations: () => applyPlaylistAnalysisDecorations(),
    onWaveformSettled: () => {
      warmDecodeForCurrentSource('waveform-settled', state.sourceVersion);
      preloadCtrl.maybeStartCurrentSourceBackgroundPhase();
      likeCtrl.maybeStartCurrentSourceLikePhases();
    },
    scheduleTempoRetry: (_sourceUrl, delayMs) => {
      const capturedVersion = state.sourceVersion;
      const capturedSrc = String(state.currentSrc || '').trim();
      window.setTimeout(() => {
        if (
          capturedVersion !== state.sourceVersion
          || String(state.currentSrc || '').trim() !== capturedSrc
          || settings.liteModeEnabled
        ) {
          return;
        }
        analysisReqCtrl.requestTempo();
      }, delayMs);
    },
    onEmptySourceReset: () => {
      clearAllPlaylistAnalyzing();
      runtimePrepareInFlightKey = '';
      runtimePrepareInFlightSource = '';
      playlistWarmToken += 1;
      activePlaylistRuntimePredecodeSignature = '';
      playlistRuntimePredecodeInFlightKeys.clear();
      playlistRuntimePredecodeInFlightSources.clear();
      preloader.cancel();
      preloadCtrl.resetPreloadQueueSignature();
      resetPreloadBpmBatchGate();
      preloadCtrl.clearPreloadKeyFailedCacheKeys();
      resetPreloadFailureEpoch();
      cancelPreloadKeyPass();
    }
  });

  const handlers = createPlayerPanelHandlers({
    state,
    getBridge: () => getPlaybackBridge(),
    render: requestRender,
    applyPlaylistCurrentIndex: (nextIndex, reason) => {
      applyPlaylistCurrentIndex(state, nextIndex, onAlign, reason);
    },
    requestPlaylistApiRefresh: () => {
      refreshPlaylistWithPolicy(true);
      syncPreloadQueue(state.sourceVersion);
      requestRender();
    },
    recordUiAction: (action, detail) => {
      recordUiAction(state, action, detail);
    },
    recordGuard: (action, detail) => {
      recordGuard(state, action, detail);
    },
    recordSelection: (action, detail) => {
      recordSelection(state, action, detail);
    },
    onToggleAlbumLike: () => {
      likeCtrl.runLikeToggleWithRetry('album');
    },
    onToggleTrackLike: (index) => {
      likeCtrl.runLikeToggleWithRetry('track', index);
    },
    onTempoAdjustIntent: () => {
      warmDecodeForCurrentSource('tempo-adjust-intent', state.sourceVersion);
    },
    settings,
    onPreloadQueueSync: () => {
      syncPreloadQueue(state.sourceVersion);
    },
    onClosePanel: () => {
      deactivateExtension();
    }
  });
  shortcutPanelHandlers = handlers;

  const maybeAutoAdvancePlaylist = (origin: 'origin-ended' | 'runtime-ended'): boolean => {
    if (!settings.autoPlayEnabled) {
      return false;
    }
    const now = Date.now();
    if (
      lastAutoAdvanceSourceVersion === state.sourceVersion &&
      now - lastAutoAdvanceAtMs < AUTO_ADVANCE_DEDUP_MS
    ) {
      return true;
    }
    const tracks = state.playlist.tracks;
    if (tracks.length <= 1) {
      return false;
    }
    const nextIndex = findNextPlayableIndexWithoutWrap(tracks, state.playlist.currentIndex);
    if (nextIndex < 0) {
      recordUiAction(state, 'auto-next-track-stop', `reason=end-of-playlist origin=${origin}`);
      requestRender();
      return true;
    }
    const target = tracks[nextIndex];
    const streamUrl = String(target?.streamUrl || '').trim();
    if (!target || !streamUrl) {
      recordSelection(
        state,
        'auto-next-track-blocked',
        `reason=missing-stream next=${nextIndex} origin=${origin}`
      );
      requestRender();
      return true;
    }

    if (origin === 'runtime-ended') {
      resetPlayerTempoAdjustSession(state);
      applyPlayerTempoAdjust(state, getPlaybackBridge());
    }

    armPlaylistJumpLock(state, target);
    recordUiAction(state, 'auto-next-track', `from=${state.playlist.currentIndex} to=${nextIndex} origin=${origin}`);
    recordSelection(
      state,
      'auto-load-track',
      `trackId=${target.trackId || '-'} stream=1 detached=0 origin=${origin} playlistSource=${state.playlistSource || '-'}`
    );
    const loaded = Boolean(getPlaybackBridge()?.loadTrack(streamUrl));
    if (!loaded) {
      recordSelection(
        state,
        'auto-load-track-blocked',
        `trackId=${target.trackId || '-'} reason=bridge-load-failed origin=${origin}`
      );
      requestRender();
      return true;
    }
    applyPlaylistCurrentIndex(state, nextIndex, onAlign, `auto:${origin}`);
    requestRender();
    lastAutoAdvanceSourceVersion = state.sourceVersion;
    lastAutoAdvanceAtMs = now;
    return true;
  };

  panel = showResultsPanel(buildPanelInput(state, settings), handlers, {
    onWaveformDebugTrace: (stage, detail) => {
      appendKeyAnalysisTrace(state.keyAnalysisTrace, stage, detail);
    },
    onWaveformPerformance: (snapshot) => {
      state.uiPerformanceDebug.waveformLoading = snapshot;
    },
    onOpenDebugger: () => {
      debugPanel?.open();
    }
  });

  syncRuntimeAudioEngineDebug();
  resourceDiagnostics = createResourceDiagnosticsController({
    setHostPerfSampling: (enabled) => runtimeAudioController?.setHostPerfSampling(enabled),
    collectHostPerfSnapshots: () =>
      runtimeAudioController?.collectHostPerfSnapshots() ?? Promise.resolve([])
  });
  state.resourceDiagnostics = resourceDiagnostics.getDebugState();
  debugPanel = createDebugPanel(
    () => ({
      title: 'Debugger',
      sections: buildDebugSections(state)
    }),
    { onVisibilityChange: (visible) => resourceDiagnostics?.setPanelOpen(visible) }
  );
  pushDebug = createThrottledDebugPush(debugPanel, 350);
  const playlistProbe = createPlaylistProbeController({
    state,
    enabled: rootLikePage,
    refreshPlaylistCacheOnly: () => {
      const now = Date.now();
      const unresolved =
        state.playlist.tracks.length === 0 ||
        state.playlistSource.startsWith('none') ||
        state.playlistSource.startsWith('switching');
      const forceApiDuringStrictReset = isStrictOriginRebindWindow();
      const allowApiFetch =
        forceApiDuringStrictReset ||
        (unresolved && now - lastProbeApiRefreshAt >= ROOT_PROBE_API_REFRESH_INTERVAL_MS);
      if (allowApiFetch) {
        lastProbeApiRefreshAt = now;
      }
      refreshPlaylistWithPolicy(allowApiFetch);
      syncPreloadQueue(state.sourceVersion);
      warmDecodeForCurrentSource('playlist-probe-refresh', state.sourceVersion);
    },
    requestRender
  });

  const deferredRefresh = createDeferredRefreshController({
    rootLikePage,
    rootRetryDelaysMs: ROOT_PLAYLIST_RETRY_SEQUENCE_MS,
    getCurrentSourceVersion: () => state.sourceVersion,
    hasMultiplePlaylistTracks: () => state.playlist.tracks.length > 1,
    isPlaylistUnresolved: () =>
      state.playlist.tracks.length === 0 || state.playlistSource.startsWith('none'),
    onPlaylistRefresh: (allowApiFetch) => {
      refreshPlaylistWithPolicy(allowApiFetch);
    },
    onPlaylistAfterRefresh: (expectedSourceVersion) => {
      playlistProbe.sync(expectedSourceVersion);
      syncPreloadQueue(expectedSourceVersion);
      warmDecodeForCurrentSource('deferred-refresh', expectedSourceVersion);
      requestRender();
    },
    onMetadataRefresh: (expectedSourceVersion, allowApiFetch) => {
      refreshMetadataWithPolicy(expectedSourceVersion, allowApiFetch);
      warmDecodeForCurrentSource('metadata-refresh', expectedSourceVersion);
      requestRender();
    }
  });

  const isPageReleaseSource = (candidateSrc: string): boolean => {
    const globals = getLatestPageGlobals(60_000);
    const pageTralbum =
      globals?.tralbum && typeof globals.tralbum === 'object' ? (globals.tralbum as TralbumLike) : null;
    if (!pageTralbum) {
      return false;
    }
    const candidateTrackId = readTrackIdFromUrl(candidateSrc);
    return tralbumMatchesCurrentTrack(pageTralbum, candidateTrackId, candidateSrc);
  };

  const shouldAcceptSourceEvent = (candidateSrc: string, origin: string): boolean => {
    const result = resolveSourceEventAcceptance({
      candidateSrc,
      origin,
      now: Date.now(),
      isAuthoritativeEvent: isAuthoritativeSourceEvent(origin),
      forceUnifiedNonReleaseSnapshot: state.forceUnifiedNonReleaseSnapshot,
      sourceVersion: state.sourceVersion,
      activeAudioSrc: String(state.activeAudio?.currentSrc || state.activeAudio?.src || '').trim(),
      currentSrc: String(state.currentSrc || '').trim(),
      lastAuthoritativeSource,
      lastAuthoritativeSourceAt,
      lastAuthoritativeSourceVersion,
      staleBridgeSourceGuardMs: STALE_BRIDGE_SOURCE_GUARD_MS,
      isPageReleaseSource
    });
    if (!result.accept && result.detail) {
      recordGuard(state, 'source-change-ignored-stale-event', result.detail);
    }
    return result.accept;
  };

  const applySourceChange = (src: string, origin = 'unknown'): void => {
    if (!shouldAcceptSourceEvent(src, origin)) {
      return;
    }
    const now = Date.now();
    const candidateSrc = String(src || '').trim();
    const candidateIsPageRelease = candidateSrc ? isPageReleaseSource(candidateSrc) : false;
    const transition = classifySourceTransition({
      previousSource: state.currentSrc,
      candidateSrc,
      origin,
      now,
      playlistTracks: state.playlist.tracks,
      playlistJumpLockUntil: state.playlistJumpLockUntil,
      playlistJumpLockTrackId: state.playlistJumpLockTrackId,
      activeAudioPlaying: Boolean(state.activeAudio && !state.activeAudio.paused && !state.activeAudio.ended),
      bridgeAudioPlaying: Boolean(
        state.bridgeAudioState &&
        now - state.bridgeAudioState.ts <= 2500 &&
        !state.bridgeAudioState.paused
      ),
      pauseSourceGuardUntil,
      forceUnifiedNonReleaseSnapshot: state.forceUnifiedNonReleaseSnapshot,
      candidateIsPageRelease
    });
    const {
      previousSource,
      sameTrackIdentityAsCurrent,
      candidateTrackId,
      sourceOutsideCurrentPlaylist,
      sourceMatchesJumpLock,
      recentUserSelectionMatchesCandidate,
      playbackPausedOrIdle,
      sourceChanged,
      shouldIgnoreJumpLockRebound,
      shouldIgnorePausedSourceFlipFinal,
      shouldIgnorePauseStaleSwitchFinal,
      isOriginSwitch,
      transitionKind
    } = transition;

    if (sameTrackIdentityAsCurrent && previousSource && candidateSrc && candidateSrc !== previousSource) {
      // Root/fan pages often emit tokenized stream_redirect URLs for the same track.
      // Do not treat those as source switches (it resets recovery/playlist scheduling).
      state.currentSrc = candidateSrc;
      recordGuard(
        state,
        'source-change-ignored-same-track',
        `origin=${origin} trackId=${candidateTrackId || '-'}`
      );
      return;
    }
    pushDistinctLikeDebugEvent(
      'source.change.request',
      [
        `origin=${origin}`,
        `from=${normalizeLikeId(readTrackIdFromUrl(previousSource) || '') || '-'}`,
        `to=${normalizeLikeId(candidateTrackId || '') || '-'}`,
        `changed=${sourceChanged ? '1' : '0'}`,
        `outside=${sourceOutsideCurrentPlaylist ? '1' : '0'}`,
        `recentSelection=${recentUserSelectionMatchesCandidate ? '1' : '0'}`,
        `jumpLock=${sourceMatchesJumpLock ? '1' : '0'}`,
        `paused=${playbackPausedOrIdle ? '1' : '0'}`,
        `pageRelease=${candidateIsPageRelease ? '1' : '0'}`
      ].join(' ')
    );
    pushDistinctLikeDebugEvent(
      'source.change.classify',
      [
        `kind=${transitionKind}`,
        `outside=${sourceOutsideCurrentPlaylist ? '1' : '0'}`,
        `recentSelection=${recentUserSelectionMatchesCandidate ? '1' : '0'}`,
        `jumpLock=${sourceMatchesJumpLock ? '1' : '0'}`,
        `origin=${origin}`,
        `from=${normalizeLikeId(readTrackIdFromUrl(previousSource) || '') || '-'}`,
        `to=${normalizeLikeId(candidateTrackId || '') || '-'}`
      ].join(' ')
    );

    if (shouldIgnorePausedSourceFlipFinal) {
      if (state.playlist.loading && state.playlist.tracks.length > 0) {
        state.playlist = {
          ...state.playlist,
          loading: false
        };
      }
      recordGuard(
        state,
        'source-change-ignored-paused-src-flip',
        `from=${previousSource} to=${candidateSrc} lock=${sourceMatchesJumpLock ? '1' : '0'}`
      );
      pushDistinctLikeDebugEvent(
        'source.change.ignore',
        `reason=paused-src-flip origin=${origin} to=${normalizeLikeId(candidateTrackId || '') || '-'} jumpLock=${sourceMatchesJumpLock ? '1' : '0'}`
      );
      return;
    }

    if (shouldIgnoreJumpLockRebound) {
      recordGuard(
        state,
        'source-change-ignored-jump-lock-rebound',
        `from=${previousSource} to=${candidateSrc} lock=${state.playlistJumpLockTrackId}`
      );
      pushDistinctLikeDebugEvent(
        'source.change.ignore',
        `reason=jump-lock-rebound origin=${origin} to=${normalizeLikeId(candidateTrackId || '') || '-'} lock=${state.playlistJumpLockTrackId || '-'}`
      );
      return;
    }

    if (shouldIgnorePauseStaleSwitchFinal) {
      if (state.playlist.loading && state.playlist.tracks.length > 0) {
        state.playlist = {
          ...state.playlist,
          loading: false
        };
      }
      recordGuard(
        state,
        'source-change-ignored-pause-stale',
        `from=${previousSource} to=${candidateSrc} paused=${playbackPausedOrIdle ? '1' : '0'} lock=${sourceMatchesJumpLock ? '1' : '0'}`
      );
      pushDistinctLikeDebugEvent(
        'source.change.ignore',
        `reason=pause-stale origin=${origin} to=${normalizeLikeId(candidateTrackId || '') || '-'} outside=${sourceOutsideCurrentPlaylist ? '1' : '0'}`
      );
      return;
    }

    const observedNow = getLatestObservedDiscoverAudioState(3000);
    const bridgeState = observedNow && observedNow.src
      ? {
          src: observedNow.src,
          paused: observedNow.paused,
          currentTimeSec: observedNow.currentTimeSec,
          durationSec: observedNow.durationSec,
          ts: observedNow.ts
        }
      : state.bridgeAudioState;
    const bridgeFresh = Boolean(bridgeState && now - bridgeState.ts <= 2500);
    const bridgePlaying = Boolean(bridgeFresh && bridgeState && !bridgeState.paused);
    const bridgeSrc = String(bridgeState?.src || '').trim();

    if (!confirmPageReleaseSourceChange({
      previousSource,
      candidateSrc,
      candidateIsPageRelease,
      bridgeFresh,
      bridgeSrc,
      now
    })) {
      return;
    }

    if (shouldIgnoreReleaseFlash({ bridgePlaying, candidateSrc, bridgeSrc })) {
      return;
    }

    if (shouldIgnoreExternalGuardedRelease({
      now,
      candidateSrc,
      candidateIsPageRelease,
      bridgeFresh,
      bridgePaused: Boolean(bridgeState?.paused ?? true),
      bridgeSrc
    })) {
      return;
    }

    const previousVersion = state.sourceVersion;
    if (state.forceUnifiedNonReleaseSnapshot && candidateSrc) {
      const candidateIsOriginReleaseSource = isPageReleaseSource(candidateSrc);
      const authoritativeOriginEvent = isAuthoritativeSourceEvent(origin);
      const shouldReconnectToOrigin =
        state.originDetachedFromPage && authoritativeOriginEvent && candidateIsOriginReleaseSource;

      if (state.originDetachedFromPage && candidateIsOriginReleaseSource && !shouldReconnectToOrigin) {
        recordGuard(
          state,
          'source-change-ignored-origin-detached',
          `origin=${origin} candidate=${candidateSrc}`
        );
        return;
      }

      if (shouldReconnectToOrigin) {
        state.originDetachedFromPage = false;
      } else if (!candidateIsOriginReleaseSource) {
        state.originDetachedFromPage = true;
      }
    }

    setCurrentSource(state, src, {
      clearNonReleaseSnapshot: sourceOutsideCurrentPlaylist
    });
    const version = state.sourceVersion;
    if (version !== previousVersion) {
      resetRuntimeAudioDebugForSourceChange();
      syncRuntimeAudioEngineDebug();
    }
    runtimeAudioController?.setCurrentSource(state.currentSrc, version);
    syncRuntimeTempoAdjustReady();
    if (version !== previousVersion && !isOriginSwitch) {
      warmDecodeForPlaylistTracks();
    }
    if (isAuthoritativeSourceEvent(origin) && candidateSrc && version !== previousVersion) {
      lastAuthoritativeSource = candidateSrc;
      lastAuthoritativeSourceAt = now;
      lastAuthoritativeSourceVersion = version;
    }
    if (src && !isPageReleaseSource(src)) {
      externalSourceGuardUntil = Date.now() + EXTERNAL_SOURCE_GUARD_MS;
    }
    pendingPageReleaseConfirmationSrc = '';
    pendingPageReleaseConfirmationAt = 0;

    if (version !== previousVersion) {
      const shouldEnterStrictOriginRebind = rootLikePage && isOriginSwitch;
      if (shouldEnterStrictOriginRebind) {
        strictOriginRebindVersion = version;
        strictOriginRebindUntil = Date.now() + STRICT_ORIGIN_REBIND_WINDOW_MS;
      }
      pushDistinctLikeDebugEvent(
        'source.change.rebind-decision',
        `apply=${shouldEnterStrictOriginRebind ? '1' : '0'} kind=${transitionKind} reason=${shouldEnterStrictOriginRebind ? 'origin-switch' : 'not-origin-switch'}`
      );
      pushDistinctLikeDebugEvent(
        'source.change.accept',
        [
          `origin=${origin}`,
          `from=${normalizeLikeId(readTrackIdFromUrl(previousSource) || '') || '-'}`,
          `to=${normalizeLikeId(candidateTrackId || '') || '-'}`,
          `outside=${sourceOutsideCurrentPlaylist ? '1' : '0'}`,
          `recentSelection=${recentUserSelectionMatchesCandidate ? '1' : '0'}`,
          `jumpLock=${sourceMatchesJumpLock ? '1' : '0'}`,
          `playlistSource=${state.playlistSource || '-'}`
        ].join(' ')
      );
      // Keep like status stable across playlist-only jumps. Only reset likes when
      // we actually switch origin outside the currently resolved playlist.
      maybeResetLikesForSourceChange({
        sourceChanged,
        sourceOutsideCurrentPlaylist,
        origin,
        candidateTrackId
      });
      notifyTrackSwitch(src);
      lastSwitchAt = Date.now();
      lastProbeApiRefreshAt = 0;
      pauseSourceGuardUntil = 0;
      resetSourceScopedWork(isOriginSwitch);
      const strictOriginResetApplied = rootLikePage && isOriginSwitch;
      pushDistinctLikeDebugEvent(
        'source.change.reset-decision',
        `apply=${strictOriginResetApplied ? '1' : '0'} kind=${transitionKind} reason=${strictOriginResetApplied ? 'origin-switch' : 'not-origin-switch'}`
      );
      if (strictOriginResetApplied) {
        // Strict origin-jump policy: always clear stale binding state before
        // rebuilding playlist/metadata for the new source.
        clearSourceBoundPanelState('source-change-clear-ui');
        resetPlaylistForSourceSwitch();
        pushDistinctLikeDebugEvent(
          'source.change.strict-reset',
          `to=${normalizeLikeId(candidateTrackId || '') || '-'} windowMs=${STRICT_ORIGIN_REBIND_WINDOW_MS}`
        );
      }

      if (sourceOutsideCurrentPlaylist && !recentUserSelectionMatchesCandidate) {
        // A new origin track outside the current playlist means old panel state is stale.
        // Clear immediately, then repopulate on the deferred refresh cycle.
        if (!strictOriginResetApplied) {
          clearSourceBoundPanelState('source-change-clear-ui');
        }
        pushDistinctLikeDebugEvent(
          'source.change.clear-ui',
          `reason=outside-playlist-switch to=${normalizeLikeId(candidateTrackId || '') || '-'} recentSelection=${recentUserSelectionMatchesCandidate ? '1' : '0'}`
        );
        if (!strictOriginResetApplied) {
          resetPlaylistForSourceSwitch();
        }

        scheduleOutsidePlaylistSourceRefresh(version);
        return;
      }

      if (transitionKind === 'playlist-track-switch') {
        finishPlaylistTrackSwitch(version, 'source-change');
        return;
      }

      scheduleAcceptedSourceRefresh(version);
      return;
    }

    if (transitionKind === 'playlist-track-switch') {
      finishPlaylistTrackSwitch(version, 'same-version-source-change');
      return;
    }

    refreshMetadataWithPolicy(version, false);
    refreshPlaylistWithPolicy(shouldUseApiPlaylistRefreshForRoot());
    maybeStartCurrentSourceAnalysis(version);
    syncPreloadQueue(version);
  };

  const syncBridgeAudioState = (): void => {
    state.ownedPlaybackHostState = getLatestOwnedPlaybackHostState(15_000);
    state.detachedPlaybackActive = Boolean(
      state.ownedPlaybackHostState &&
      state.ownedPlaybackHostState.detachedReady &&
      state.ownedPlaybackHostState.currentSrc &&
      state.currentSrc === state.ownedPlaybackHostState.currentSrc
    );
    const observed = getLatestObservedDiscoverAudioState(2500);
    if (!observed || !observed.src) {
      return;
    }

    const observedSrc = String(observed.src || '').trim();
    if (!observedSrc) {
      return;
    }
    const activeAudioSrc = String(state.activeAudio?.currentSrc || state.activeAudio?.src || '').trim();
    const activeAudioIsAuthoritative = Boolean(
      state.activeAudio &&
      !state.activeAudio.ended &&
      activeAudioSrc &&
      state.currentSrc === activeAudioSrc
    );
    if (activeAudioIsAuthoritative && observedSrc !== activeAudioSrc) {
      // Ignore stale bridge observer reports while player audio source is authoritative,
      // even during pause. This prevents repeated stale-event guard spam.
      return;
    }

    if (state.runtimePlaybackOwned) {
      // Runtime player owns playback — do not let observer state overwrite bridgeAudioState.
      return;
    }

    state.bridgeAudioState = {
      src: observedSrc,
      origin: 'bridge-observer',
      paused: observed.paused,
      currentTimeSec: observed.currentTimeSec,
      durationSec: observed.durationSec,
      volume: observed.volume,
      muted: observed.muted,
      ts: observed.ts
    };

    if (!state.hasPlaybackStarted) {
      state.hasPlaybackStarted = true;
    }

    const detachedActive =
      Boolean(
        state.activeAudio &&
        !document.contains(state.activeAudio) &&
        !state.activeAudio.paused &&
        !state.activeAudio.ended &&
        activeAudioSrc
      );
    // Detached playback is intentionally non-origin; avoid reverting to stale origin bridge src.
    if (detachedActive && observedSrc !== activeAudioSrc) {
      return;
    }

    const domSrc = String(state.activeAudio?.currentSrc || state.activeAudio?.src || '').trim();
    if (domSrc && domSrc === observedSrc && state.currentSrc === observedSrc) {
      return;
    }

    if (state.currentSrc !== observedSrc) {
      recordBridgeEvent(state, 'bridge-audio-state', `src=${observedSrc} paused=${observed.paused ? '1' : '0'}`);
      pauseSourceGuardUntil = 0;
      applySourceChange(observedSrc, 'bridge-audio-state');
    }
  };

  deferredRefresh.schedulePlaylistRefresh({
    delayMs: 80,
    expectedSourceVersion: state.sourceVersion,
    allowApiFetch: !rootLikePage
  });
  deferredRefresh.schedulePlaylistRetries(state.sourceVersion);

  bridge = createAudioBridge({
    onAudioChanged(audio) {
      if (state.detachedPlaybackActive && !audio) {
        requestRender();
        return;
      }
      if (state.detachedPlaybackActive && audio && document.contains(audio)) {
        return;
      }
      state.activeAudio = audio;
      if (audio && !state.runtimePlaybackOwned) {
        state.bridgeAudioState = {
          src: audio.currentSrc || audio.src || '',
          origin: 'origin-audio',
          paused: Boolean(audio.paused),
          currentTimeSec: Number.isFinite(audio.currentTime) ? Number(audio.currentTime) : 0,
          durationSec: Number.isFinite(audio.duration) ? Number(audio.duration) : 0,
          volume: Number.isFinite(audio.volume) ? Number(audio.volume) : 1,
          muted: Boolean(audio.muted),
          ts: Date.now()
        };
      }
      ensurePlaybackGateStarted(state);
      const nextSrc = audio?.currentSrc || audio?.src || '';
      recordBridgeEvent(
        state,
        'audio-changed',
        `src=${nextSrc || '-'} paused=${audio ? String(audio.paused) : '-'}`
      );

      applySourceChange(nextSrc, 'audio-changed');
      runtimeAudioController?.onOriginAudioState(audio, 'audio-changed');
      requestRender();
    },

    onAudioStateChanged(audio, eventType = 'state') {
      if (state.detachedPlaybackActive && !audio) {
        requestRender();
        return;
      }
      if (state.detachedPlaybackActive && audio && document.contains(audio)) {
        return;
      }
      state.activeAudio = audio;
      if (audio && !state.runtimePlaybackOwned) {
        // Only update bridge state from the origin element when the runtime player is not
        // actively playing.  When the runtime has taken over, its own onPlaybackState
        // callbacks are the authoritative source; letting origin events overwrite it causes
        // "Playback: paused" to flash whenever the suppressed origin fires a pause event.
        state.bridgeAudioState = {
          src: audio.currentSrc || audio.src || state.currentSrc,
          origin: 'origin-audio',
          paused: Boolean(audio.paused),
          currentTimeSec: Number.isFinite(audio.currentTime) ? Number(audio.currentTime) : 0,
          durationSec: Number.isFinite(audio.duration) ? Number(audio.duration) : 0,
          volume: Number.isFinite(audio.volume) ? Number(audio.volume) : 1,
          muted: Boolean(audio.muted),
          ts: Date.now()
        };
      }
      playbackHandoff.reportPlaybackState(
        Boolean(audio && !audio.paused && !audio.ended) || Boolean(state.runtimeAudioDebug?.runtimeActive),
        audio?.currentSrc || audio?.src || state.currentSrc
      );
      ensurePlaybackGateStarted(state);

      if (eventType !== 'timeupdate') {
        const src = audio?.currentSrc || audio?.src || '';
        const currentTime = Number.isFinite(audio?.currentTime) ? Number(audio?.currentTime || 0).toFixed(2) : '-';
        const duration = Number.isFinite(audio?.duration) ? Number(audio?.duration || 0).toFixed(2) : '-';
        recordBridgeEvent(
          state,
          eventType,
          `src=${src || '-'} paused=${audio ? String(audio.paused) : '-'} t=${currentTime}/${duration}`
        );
      }

      updateNativeSeekLifecycle(audio, eventType);

      if (eventType === 'pause') {
        pauseSourceGuardUntil = Date.now() + 1500;
      } else if (eventType === 'play' || eventType === 'loadedmetadata') {
        pauseSourceGuardUntil = 0;
        if (!state.hasPlaybackStarted && audio && !audio.paused) {
          state.hasPlaybackStarted = true;
        }
        warmDecodeForCurrentSource(`origin-${eventType}`, state.sourceVersion);
        maybeStartCurrentSourceAnalysis(state.sourceVersion);
      }

      runtimeAudioController?.onOriginAudioState(audio, eventType);
      if (eventType === 'ended' && !state.runtimePlaybackOwned) {
        maybeAutoAdvancePlaylist('origin-ended');
      }
      applyPlaylistAlignment(state, onAlign);

      syncPreloadQueue(state.sourceVersion);
      requestRender();
    },

    onSourceChanged(src) {
      recordBridgeEvent(state, 'source-changed', `src=${src || '-'}`);
      applySourceChange(src, 'source-changed');
      warmDecodeForCurrentSource('bridge-source-changed', state.sourceVersion);
      runtimeAudioController?.onOriginAudioState(bridge?.getActiveAudio() ?? null, 'source-changed');
      requestRender();
    }
  });
  runtimeAudioController = createRuntimeAudioController({
    bridge,
    engine: runtimeAudioEngine,
    onRuntimeCapability(capability) {
      state.runtimeStretchCapability = capability;
      syncRuntimeTempoAdjustReady();
      requestRender();
    },
    onRuntimeSourceChanged(src) {
      recordBridgeEvent(state, 'runtime-source-changed', `src=${src || '-'}`);
      applySourceChange(src, 'source-changed');
      warmDecodeForCurrentSource('runtime-source-changed', state.sourceVersion);
      requestRender();
    },
    onPendingRuntimeSelectionChange(pending) {
      state.runtimePlaylistSelectionPending = pending;
      requestRender();
    },
    onOwnershipChange(owned, ownership) {
      state.runtimePlaybackOwned = owned;
      if (owned) {
        state.seekWaitOverlayActive = false;
      }
      if (state.runtimeAudioDebug) {
        state.runtimeAudioDebug.ownershipState = ownership.ownershipState;
        state.runtimeAudioDebug.firstOriginAvailable = ownership.firstOriginAvailable;
        state.runtimeAudioDebug.runtimeOwned = owned;
        if (!owned) {
          state.runtimeAudioDebug.awaitingFirstRuntimeSample = false;
        }
        state.runtimeAudioDebug.ts = Date.now();
      }
      requestRender();
    },
    onPlaybackState(runtimeState) {
      const runtimeReportedSrc = String(runtimeState.src || '').trim();
      const runtimeSrc = String(runtimeReportedSrc || state.currentSrc || '').trim();
      const reportedDurationSec = Number.isFinite(runtimeState.durationSec) ? Number(runtimeState.durationSec) : 0;
      const preparedMatch = runtimeSrc ? runtimeAudioEngine.findPrepared(runtimeSrc) : null;
      const activeAudioSrc = String(state.activeAudio?.currentSrc || state.activeAudio?.src || '').trim();
      const activeAudioDurationSec = Number.isFinite(state.activeAudio?.duration)
        ? Number(state.activeAudio?.duration)
        : 0;
      const previousState = state.bridgeAudioState;
      const previousDurationSec = Number.isFinite(previousState?.durationSec) ? Number(previousState?.durationSec || 0) : 0;
      const durationCandidates: number[] = [];
      if (
        preparedMatch &&
        preparedMatch.snapshot.sourceVersion === state.sourceVersion &&
        Number.isFinite(preparedMatch.snapshot.durationSec) &&
        preparedMatch.snapshot.durationSec > 0
      ) {
        durationCandidates.push(Number(preparedMatch.snapshot.durationSec));
      }
      if (
        runtimeSrc &&
        activeAudioSrc &&
        sourcesShareTrackIdentity(activeAudioSrc, runtimeSrc) &&
        activeAudioDurationSec > 0
      ) {
        durationCandidates.push(activeAudioDurationSec);
      }
      if (
        runtimeSrc &&
        previousState?.src &&
        sourcesShareTrackIdentity(previousState.src, runtimeSrc) &&
        previousDurationSec > 0
      ) {
        durationCandidates.push(previousDurationSec);
      }
      const authoritativeDurationSec = durationCandidates.find((value) => value > 0) || 0;
      const runtimeDurationSec =
        authoritativeDurationSec > 0 &&
        (!reportedDurationSec || Math.abs(reportedDurationSec - authoritativeDurationSec) > 0.25)
          ? authoritativeDurationSec
          : reportedDurationSec;
      state.bridgeAudioState = {
        src: runtimeSrc,
        origin: 'runtime',
        paused: runtimeState.paused,
        currentTimeSec: runtimeState.currentTimeSec,
        durationSec: runtimeDurationSec,
        volume: runtimeState.volume,
        muted: runtimeState.muted,
        ts: runtimeState.ts
      };
      if (state.runtimeAudioDebug) {
        state.runtimeAudioDebug.runtimeActive = !runtimeState.paused;
        state.runtimeAudioDebug.runtimeOwned = state.runtimePlaybackOwned;
        state.runtimeAudioDebug.runtimeSrc = runtimeSrc;
        state.runtimeAudioDebug.runtimeReportedSrc = runtimeReportedSrc;
        state.runtimeAudioDebug.runtimePaused = runtimeState.paused;
        state.runtimeAudioDebug.runtimeTimeSec = runtimeState.currentTimeSec;
        state.runtimeAudioDebug.runtimeDurationSec = runtimeDurationSec;
        if (
          state.runtimeAudioDebug.awaitingFirstRuntimeSample &&
          state.runtimePlaybackOwned &&
          !runtimeState.paused
        ) {
          state.runtimeAudioDebug.handoverFirstRuntimeTimeSec = runtimeState.currentTimeSec;
          const seekTarget = state.runtimeAudioDebug.handoverSeekTargetTimeSec;
          state.runtimeAudioDebug.handoverFirstRuntimeDeltaSec =
            seekTarget !== null ? runtimeState.currentTimeSec - seekTarget : null;
          state.runtimeAudioDebug.awaitingFirstRuntimeSample = false;
          appendRuntimeDebugTrace(
            state.runtimeAudioDebug.takeoverTrace,
            `runtime-state→first-sample(t=${runtimeState.currentTimeSec.toFixed(2)}${
              seekTarget !== null
                ? `,delta=${(runtimeState.currentTimeSec - seekTarget).toFixed(2)}`
                : ''
            })`
          );
        }
        state.runtimeAudioDebug.ts = runtimeState.ts;
      }
      if (!runtimeState.paused) {
        state.hasPlaybackStarted = true;
      }
      playbackHandoff.reportPlaybackState(!runtimeState.paused, runtimeSrc || state.currentSrc);
      if (
        previousState?.paused !== runtimeState.paused ||
        previousState?.src !== runtimeSrc ||
        Math.abs((previousState?.durationSec || 0) - runtimeDurationSec) > 0.01
      ) {
        requestRender();
      }
    },
    onPlaybackEnded() {
      maybeAutoAdvancePlaylist('runtime-ended');
    },
    getDetachedAudioState() {
      if (!state.detachedPlaybackActive) {
        return null;
      }
      const observed = getLatestObservedDiscoverAudioState(2500);
      const owned = state.ownedPlaybackHostState;
      if (!observed?.src || !owned) {
        return null;
      }
      return {
        src: observed.src,
        currentTimeSec: observed.currentTimeSec,
        durationSec: observed.durationSec,
        volume: observed.volume,
        muted: observed.muted,
        playing: Boolean(owned.playing && !observed.paused)
      };
    },
    claimRuntimePlayback(src) {
      sendDiscoverAudioCommand('runtime-owns-playback', { streamUrl: src });
      requestOwnedPlaybackHostState();
    },
    onTakeoverDebug(reason, stage, info) {
      const debug = ensureRuntimeAudioDebug();
      recordRuntimeIncidentDebug(reason, stage, info?.detail || '-');
      debug.takeoverStage = stage;
      debug.takeoverReason = reason;
      debug.takeoverDetail = info?.detail || '-';
      if (Number.isFinite(info?.originSnapshotTimeSec)) {
        debug.handoverOriginSnapshotTimeSec = Number(info?.originSnapshotTimeSec);
      }
      if (Number.isFinite(info?.seekTargetTimeSec)) {
        debug.handoverSeekTargetTimeSec = Number(info?.seekTargetTimeSec);
        debug.handoverFirstRuntimeTimeSec = null;
        debug.handoverFirstRuntimeDeltaSec = null;
        debug.awaitingFirstRuntimeSample = true;
      }
      if (stage === 'host-latency') {
        debug.hostLatencyDetail = info?.detail || '-';
      } else if (stage === 'host-load') {
        debug.hostLoadDetail = info?.detail || '-';
      } else if (stage === 'host-resample') {
        debug.hostResampleDetail = info?.detail || '-';
      } else if (stage === 'host-input-churn') {
        debug.hostChurnDetail = info?.detail || '-';
      } else if (stage === 'host-play-scheduled') {
        debug.hostScheduleDetail = info?.detail || '-';
      } else if (stage === 'host-first-window') {
        debug.hostFirstWindowDetail = info?.detail || '-';
      } else if (stage === 'host-pair') {
        debug.hostPairDetail = info?.detail || '-';
      } else if (stage.startsWith('origin-muted-before-')) {
        debug.originMuteDetail = info?.detail || stage;
      } else if (stage.startsWith('arm-')) {
        debug.armDetail = info?.detail || stage;
      }
      debug.ts = Date.now();
      appendRuntimeDebugTrace(debug.takeoverTrace, `${reason}→${stage}${info?.detail ? `(${info.detail})` : ''}`);
      requestRender();
    },
    onSeekDispatch(info) {
      const now = Date.now();
      const mode: 'native-only' | 'runtime-only' | 'runtime+native' | 'handover' =
        info.handoverPending
          ? 'handover'
          : info.runtimeDispatched && info.nativeDispatched
          ? 'runtime+native'
          : (info.runtimeDispatched ? 'runtime-only' : 'native-only');
      state.nativeSeekDebug.dispatchMode = mode;
      if (info.handoverPending) {
        state.nativeSeekDebug.runtimeDispatchAt = now;
        state.nativeSeekDebug.runtimeDispatchDetail =
          `handover fraction=${info.fraction.toFixed(3)} prepared=${info.preparedLoaded ? '1' : '0'} runtimeOwned=${info.runtimeOwned ? '1' : '0'}`;
      }
      if (info.runtimeDispatched) {
        state.nativeSeekDebug.runtimeDispatchAt = now;
        state.nativeSeekDebug.runtimeDispatchDetail =
          `fraction=${info.fraction.toFixed(3)} prepared=${info.preparedLoaded ? '1' : '0'} runtimeOwned=${info.runtimeOwned ? '1' : '0'}`;
      }
      if (info.nativeDispatched) {
        state.nativeSeekDebug.nativeDispatchAt = now;
        state.nativeSeekDebug.nativeDispatchDetail =
          `fraction=${info.fraction.toFixed(3)} prepared=${info.preparedLoaded ? '1' : '0'} runtimeOwned=${info.runtimeOwned ? '1' : '0'}`;
      }
      recordRuntimeIncidentDebug(
        'seek',
        'seek-dispatch',
        `mode=${mode} fraction=${info.fraction.toFixed(3)} prepared=${info.preparedLoaded ? '1' : '0'} runtimeOwned=${info.runtimeOwned ? '1' : '0'}`
      );
      recordBridgeEvent(
        state,
        'seek-dispatch',
        `mode=${mode} fraction=${info.fraction.toFixed(3)} prepared=${info.preparedLoaded ? '1' : '0'} runtimeOwned=${info.runtimeOwned ? '1' : '0'}`
      );
      state.seekWaitOverlayActive = Boolean(info.handoverPending && !info.preparedLoaded && !info.runtimeOwned);
      requestRender();
    },
    requestCurrentRuntimePrepare(reason) {
      warmDecodeForCurrentSource(reason, state.sourceVersion);
    }
  });
  playbackBridge = runtimeAudioController;
  runtimeAudioController.setCurrentSource(state.currentSrc, state.sourceVersion);
  applyPlayerTempoAdjust(state, getPlaybackBridge());

  const bridgeAudioPollId = window.setInterval(() => {
    syncBridgeAudioState();
    requestRender();
  }, 800);

  const playheadTickId = window.setInterval(() => {
    requestPlayheadRender();
  }, PLAYHEAD_TICK_INTERVAL_MS);

  const preloadCoverageAuditId = window.setInterval(() => {
    if (!settings.preloadTracksEnabled || state.playlist.tracks.length <= 1) {
      return;
    }

    // Periodic queue refresh catches tracks that were skipped by transient races.
    syncPreloadQueue(state.sourceVersion);
  }, PRELOAD_AUDIT_INTERVAL_MS);

  const stopWatch = watchMetadataChanges(() => {
    syncBridgeAudioState();
    ensurePlaybackGateStarted(state);
    const version = state.sourceVersion;
    if (applyLoadedPlaylistMetadataPolicy('metadata-watch')) {
      warmDecodeForCurrentSource('metadata-changed', version);
      syncPreloadQueue(version);
      likeCtrl.maybeStartCurrentSourceLikePhases();
      requestRender();
      return;
    }
    refreshMetadataWithPolicy(version, false);
    refreshPlaylistWithPolicy(shouldUseApiPlaylistRefreshForRoot());
    warmDecodeForCurrentSource('metadata-changed', version);
    syncPreloadQueue(version);
    likeCtrl.maybeStartCurrentSourceLikePhases();
    requestRender();
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
    releaseUrlBySource.clear();
    deferredRefresh.cancelAll();
    playlistProbe.cancel();
    clearAllPlaylistAnalyzing();
    preloader.cancel();
    preloadCtrl.resetPreloadQueueSignature();
    resetPreloadBpmBatchGate();
    preloadCtrl.clearPreloadKeyFailedCacheKeys();
    resetPreloadFailureEpoch();
    cancelPreloadKeyPass();
    state.metadata = { ...DEFAULT_TRACK_METADATA };
    state.metadataResolution = null;
    state.nonReleaseSnapshot = null;
    state.nonReleaseSnapshotVersion = -1;
    state.lastAnalysis = null;
    resetPlayerTempoAdjustSession(state);
    applyPlayerTempoAdjust(state, getPlaybackBridge());
    state.playlist = {
      ...DEFAULT_PLAYLIST_STATE,
      expanded: state.playlist.expanded,
      tracks: [],
      currentIndex: 0,
      loading: true
    };
    state.playlistSource = 'debug-cache-reset';
    likesController.resetMutationViewCaches('debug-cache-reset');
    const version = state.sourceVersion;
    refreshMetadataWithPolicy(version, true);
    refreshPlaylistWithPolicy(rootLikePage ? shouldUseApiPlaylistRefreshForRoot() : true);
    syncPreloadQueue(version);
    likeCtrl.maybeStartCurrentSourceLikePhases(true);
    requestRender();
  });

  const stopRuntimeTimers = startRuntimeTimers({
    getBridge: () => getPlaybackBridge(),
    onWarmupTick: () => {
      syncBridgeAudioState();
      deferredRefresh.schedulePlaylistRefresh({
        delayMs: 0,
        expectedSourceVersion: state.sourceVersion,
        allowApiFetch: !rootLikePage
      });

      syncPreloadQueue(state.sourceVersion);
      likeCtrl.maybeStartCurrentSourceLikePhases();
      requestRender();
    },
    onIntervalTick: () => {
      syncBridgeAudioState();
      ensurePlaybackGateStarted(state);

      syncPreloadQueue(state.sourceVersion);
      likeCtrl.maybeStartCurrentSourceLikePhases();
      requestRender();
    },
    onLikesTick: () => {
      likeCtrl.maybeStartScheduledDeepLikeSync();
    }
  });

  const deactivateExtension = (): void => {
    if (extensionDeactivated) {
      return;
    }
    extensionDeactivated = true;
    deferredRefresh.cancelAll();
    analysisReqCtrl.cancelTempo();
    runtimePrepareInFlightKey = '';
    runtimePrepareInFlightSource = '';
    playlistWarmToken += 1;
    activePlaylistRuntimePredecodeSignature = '';
    playlistRuntimePredecodeInFlightKeys.clear();
    playlistRuntimePredecodeInFlightSources.clear();
    clearAllPlaylistAnalyzing();
    preloader.cancel();
    preloader.setEnabled(false);
    preloadCtrl.resetPreloadQueueSignature();
    resetPreloadBpmBatchGate();
    preloadCtrl.clearPreloadKeyFailedCacheKeys();
    resetPreloadFailureEpoch();
    cancelPreloadKeyPass();
    playlistProbe.cancel();
    stopRuntimeTimers();
    stopWatch();
    stopDebugCacheReset();
    likeCtrl.clearNoticeTimer();
    try {
      state.activeAudio?.pause();
    } catch {
      // Ignore pause failures for detached/removed audio nodes.
    }
    getPlaybackBridge()?.pause();
    playbackHandoff.reportPlaybackState(false, state.currentSrc);
    playbackHandoff.destroy();
    window.clearInterval(bridgeAudioPollId);
    window.clearInterval(playheadTickId);
    window.clearInterval(preloadCoverageAuditId);
    bpmPrototypeController.destroy();
    keyTuningController.destroy();
    playbackBridge?.destroy();
    if (bridge && bridge !== playbackBridge) {
      bridge.destroy();
    }
    runtimeAudioController?.destroy();
    playbackBridge = null;
    bridge = null;
    runtimeAudioController = null;
    runtimeAudioEngine.destroy();
    debugPanel?.destroy();
    resourceDiagnostics?.destroy();
    resourceDiagnostics = null;
    state.resourceDiagnostics = null;
    panel?.destroy();
    panel = null;
  };

  window.addEventListener('beforeunload', () => {
    deactivateExtension();
  });

  syncPreloadQueue(state.sourceVersion);
  likeCtrl.maybeStartCurrentSourceLikePhases();
  requestRender();
}

init();
