import type {
  LikeIdentity,
  LikeMutationAction,
  LikeState,
  LikeViewState,
  PlaylistTrack
} from '@/shared/types';
import { detectPageContext, resolveLikeMutationRuntimeContext } from '@/content/page-context';
import { getLatestPageGlobals } from '@/content/discover/origin-bridge';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import {
  buildLikeSyncInputFromPageContext,
  type LikesStatusController
} from '@/content/likes/inventory';
import { resolveBoughtStateBlock } from '@/content/likes/mutation-gate';
import { LikeMutationController } from '@/content/likes/mutation-controller';
import { patchLikeMutationDebug, pushLikeProcessEvent, setLikeMutationAction } from '@/content/likes/mutation-debug';
import {
  applyOptimisticLikeMutation,
  finalizeLocalLikeMutation,
  rollbackOptimisticLikeMutation,
  resolveLikeToggleAction
} from '@/content/likes/toggle-helpers';
import {
  canonicalizeLikeIdentityPageUrl,
  normalizeLikeId,
  toCanonicalLikeUrl
} from '@/content/likes/state';
import { recordGuard } from '@/content/player/transport-log';
import type { PlayerState } from '@/content/player/state';

// --- Constants ---

const LIKE_WRITES_ENABLED = true;
const LIKE_BLOCKED_RETRY_DELAY_MS = 260;
const TRACK_ALBUM_LIKED_NOTICE_REASON = 'blocked_track_uncollect_album_liked';
const TRACK_ALBUM_LIKED_NOTICE_TEXT = 'Remove album from your wishlist first,\nto add/remove single tracks.';
const LIKE_CROSS_HOST_NOTICE_TEXT = 'Open the release page to change wishlist for this item.';
const TRACK_ALBUM_LIKED_NOTICE_DURATION_MS = 3600;
const LIKE_GUARD_NOTICE_TEXT = 'Please wait until wishlist sync completes,\nthen try again.';
const LIKE_GUARD_NOTICE_REASONS = new Set([
  'blocked_state_unresolved',
  'blocked_in_flight',
  'blocked_cooldown',
  'blocked_recommendations_context'
]);

// --- Pure helpers ---

export function formatLikeIdentityDebug(identity: LikeIdentity | null): string {
  if (!identity) {
    return 'none';
  }
  const itemId = normalizeLikeId(identity.itemId || '') || '-';
  const bandId = normalizeLikeId(identity.bandId || '') || '-';
  const pageUrl = toCanonicalLikeUrl(String(identity.pageUrl || '')) || '-';
  return `${identity.itemType}:${itemId}:b=${bandId}:u=${pageUrl}`;
}

export function cloneLikeViewState(view: LikeViewState): LikeViewState {
  return {
    ...view,
    trackStates: { ...(view.trackStates || {}) }
  };
}

export function summarizeLikeViewStateCounts(view: LikeViewState, totalTracks: number): string {
  const counts = {
    unknown: 0,
    disliked: 0,
    liked: 0,
    bought: 0
  };
  for (let index = 0; index < totalTracks; index += 1) {
    const state = view.trackStates[index] || 'unknown';
    counts[state] += 1;
  }
  return `u=${counts.unknown},d=${counts.disliked},l=${counts.liked},b=${counts.bought}`;
}

export function resolveActiveTrackIndexForLikeDebug(playlist: { tracks: PlaylistTrack[]; currentIndex: number }): number {
  if (Number.isInteger(playlist.currentIndex) && playlist.currentIndex >= 0 && playlist.currentIndex < playlist.tracks.length) {
    return playlist.currentIndex;
  }
  const matched = playlist.tracks.findIndex((track) => Boolean(track?.isCurrent));
  return matched >= 0 ? matched : (playlist.tracks.length > 0 ? 0 : -1);
}

export function formatPlaylistTrackLikeDebug(
  playlist: { tracks: PlaylistTrack[] },
  view: LikeViewState,
  index: number
): string {
  if (index < 0 || index >= playlist.tracks.length) {
    return 'idx=-1:none';
  }
  const track = playlist.tracks[index];
  const trackId = normalizeLikeId(track?.trackId || '') || readTrackIdFromUrl(track?.streamUrl || '') || '-';
  return `idx=${index}:id=${trackId}:state=${view.trackStates[index] || 'unknown'}`;
}

// --- Callback interface ---

export interface LikeControllerCallbacks {
  getState(): PlayerState;
  getCurrentSrc(): string;
  getPlaylistTracks(): PlaylistTrack[];
  getPlaylistCurrentIndex(): number;
  getSourceVersion(): number;
  hasPlaybackStarted(): boolean;
  isCurrentSourceContextReadyForAnalysis(): boolean;

  // Album identity (managed by requestRender, read by controller)
  getLockedAlbumLikeIdentity(): LikeIdentity | null;
  getLatestAlbumLikeIdentity(): { itemId: string | number; itemType: 'album' | 'track'; bandId?: string | number; pageUrl?: string } | null;

  // Like controllers
  getLikesController(): LikesStatusController;

  // Fan root context resolution
  resolveFanRootSyncPageContext(liveSyncContext: ReturnType<typeof detectPageContext>): ReturnType<typeof detectPageContext>;
  resolveRuntimeLikeContext(
    currentPageContext: ReturnType<typeof detectPageContext>,
    releaseUrl: string
  ): ReturnType<typeof resolveLikeMutationRuntimeContext>;

  // Integration
  requestRender(): void;
  maybeStartCurrentSourceBackgroundPhase(): void;

  // Page context
  isRecommendationsLikeContext(): boolean;
}

// --- Public interface ---

export interface LikeController {
  readonly likeMutationController: LikeMutationController;
  readonly LIKE_WRITES_ENABLED: boolean;
  resolveTrackLikeIdentityByIndex(index?: number): LikeIdentity | null;
  resolveFocusedTrackLikeIdentities(): LikeIdentity[];
  maybeStartCurrentSourceLikePhases(forceTargeted?: boolean): void;
  maybeStartCurrentSourceDeepLikePhase(): void;
  maybeStartScheduledDeepLikeSync(): void;
  resetLikesForOriginJump(reason: string): void;
  runLikeToggleWithRetry(target: 'album' | 'track', trackIndex?: number): void;
  clearNoticeTimer(): void;
}

// --- Factory ---

export function createLikeController(cb: LikeControllerCallbacks): LikeController {
  let pendingForcedForegroundLikeSync = false;
  let likeNoticeTimerId: number | null = null;

  const likeMutationController = new LikeMutationController({
    context: 'player',
    likesDebug: cb.getState().likesDebug,
    writesEnabled: LIKE_WRITES_ENABLED,
    render: () => {
      cb.requestRender();
    }
  });

  const resolveTrackLikeIdentityByIndex = (
    index = cb.getPlaylistCurrentIndex()
  ): LikeIdentity | null => {
    const tracks = cb.getPlaylistTracks();
    const track = tracks[index] || null;
    if (!track) {
      return null;
    }
    const trackId = normalizeLikeId(track.trackId || readTrackIdFromUrl(String(track.streamUrl || '').trim()));
    if (!trackId) {
      return null;
    }
    return {
      itemId: trackId,
      itemType: 'track',
      bandId: normalizeLikeId(cb.getLockedAlbumLikeIdentity()?.bandId || cb.getLatestAlbumLikeIdentity()?.bandId || ''),
      pageUrl: canonicalizeLikeIdentityPageUrl('track', String(track.pageUrl || ''))
    };
  };

  const resolveFocusedTrackLikeIdentities = (): LikeIdentity[] => {
    const identities = new Map<string, LikeIdentity>();
    cb.getPlaylistTracks().forEach((_, index) => {
      const identity = resolveTrackLikeIdentityByIndex(index);
      const itemId = normalizeLikeId(identity?.itemId || '');
      if (!identity || !itemId || identities.has(itemId)) {
        return;
      }
      identities.set(itemId, identity);
    });
    return Array.from(identities.values());
  };

  const buildCurrentSourceLikeSyncRequest = (force = false) => {
    const state = cb.getState();
    const liveSyncContext = detectPageContext({
      pageGlobals: getLatestPageGlobals(60_000),
      viewerFanIdHint: state.likesDebug.fanId
    });
    const syncPageContext = cb.resolveFanRootSyncPageContext(liveSyncContext);
    const lockedAlbumLikeIdentity = cb.getLockedAlbumLikeIdentity();
    const latestAlbumLikeIdentity = cb.getLatestAlbumLikeIdentity();
    const activeReleaseUrlForContext =
      toCanonicalLikeUrl(String(lockedAlbumLikeIdentity?.pageUrl || '')) ||
      toCanonicalLikeUrl(String(latestAlbumLikeIdentity?.pageUrl || '')) ||
      window.location.href;
    const runtimeLikeContext = cb.resolveRuntimeLikeContext(syncPageContext, activeReleaseUrlForContext);
    const syncInput = buildLikeSyncInputFromPageContext(syncPageContext, force, runtimeLikeContext);
    const focusAlbumIdentity = lockedAlbumLikeIdentity || (latestAlbumLikeIdentity?.itemType === 'album'
      ? {
          itemId: normalizeLikeId(latestAlbumLikeIdentity.itemId || ''),
          itemType: 'album' as const,
          bandId: normalizeLikeId(latestAlbumLikeIdentity.bandId || '') || undefined,
          pageUrl: String(latestAlbumLikeIdentity.pageUrl || activeReleaseUrlForContext || window.location.href || '')
        }
      : null);
    const focusTrackIdentity = resolveTrackLikeIdentityByIndex(cb.getPlaylistCurrentIndex());
    const focusTrackIdentities = resolveFocusedTrackLikeIdentities();

    return {
      syncInput,
      focusAlbumIdentity,
      focusTrackIdentity,
      focusTrackIdentities
    };
  };

  const requestLikeSync = (
    force = false,
    verifyMutation?: {
      target: 'album' | 'track';
      action: LikeMutationAction;
      identity: LikeIdentity | null;
    }
  ): Promise<{
    changed: boolean;
    verified: boolean;
    expectedState: string;
    observedState: string;
    reason: string;
  }> => {
    const state = cb.getState();
    const likesController = cb.getLikesController();
    if (!cb.hasPlaybackStarted()) {
      return Promise.resolve({
        changed: false,
        verified: false,
        expectedState: '-',
        observedState: '-',
        reason: 'sync-skipped-playback-not-started'
      });
    }
    if (cb.getPlaylistTracks().length === 0) {
      return Promise.resolve({
        changed: false,
        verified: false,
        expectedState: '-',
        observedState: '-',
        reason: 'sync-skipped-playlist-empty'
      });
    }
    const { syncInput, focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = buildCurrentSourceLikeSyncRequest(force);
    const shouldRefreshUiAfterSync = Boolean(state.likeViewState.loading) || String(state.likeViewState.notice || '').trim() === 'sync-error';
    return likesController
      .sync({
        ...syncInput,
        silent: false,
        focusAlbumIdentity,
        focusTrackIdentity,
        focusTrackIdentities
      })
      .then((changed) => {
        likesController.applyDebug(state.likesDebug);
        let verified = true;
        let expectedState = '-';
        let observedState = '-';
        let reason = 'verified';
        if (verifyMutation?.identity) {
          expectedState = verifyMutation.action === 'uncollect' ? 'disliked' : 'liked';
          observedState = likesController.readInventoryLikeState(verifyMutation.identity);
          verified =
            observedState === expectedState ||
            (expectedState === 'liked' && observedState === 'bought');
          reason = verified ? 'verified' : 'verify-mismatch';
          pushLikeProcessEvent(
            state.likesDebug,
            'mutation.verify',
            `target=${verifyMutation.target} action=${verifyMutation.action} expected=${expectedState} observed=${observedState} ok=${verified ? '1' : '0'} identity=${formatLikeIdentityDebug(verifyMutation.identity)}`
          );
        }
        if (changed || shouldRefreshUiAfterSync) {
          cb.requestRender();
        }
        return {
          changed,
          verified,
          expectedState,
          observedState,
          reason
        };
      })
      .catch(() => {
        likesController.applyDebug(state.likesDebug);
        if (shouldRefreshUiAfterSync) {
          cb.requestRender();
        }
        return {
          changed: false,
          verified: false,
          expectedState: '-',
          observedState: '-',
          reason: 'sync-failed'
        };
      });
  };

  const requestDeepLikeSync = (force = true): Promise<boolean> => {
    const state = cb.getState();
    const likesController = cb.getLikesController();
    if (!cb.hasPlaybackStarted() || cb.getPlaylistTracks().length === 0) {
      return Promise.resolve(false);
    }
    const { syncInput, focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = buildCurrentSourceLikeSyncRequest(force);
    return likesController
      .sync({
        ...syncInput,
        silent: true,
        focusAlbumIdentity,
        focusTrackIdentity,
        focusTrackIdentities
      })
      .then((changed) => {
        likesController.applyDebug(state.likesDebug);
        if (changed) {
          cb.requestRender();
        }
        return changed;
      })
      .catch(() => {
        likesController.applyDebug(state.likesDebug);
        return false;
      });
  };

  const isCurrentSourceDeepLikeRefreshReady = (): boolean => {
    if (!cb.hasPlaybackStarted()) {
      return false;
    }
    if (cb.getPlaylistTracks().length === 0) {
      return false;
    }
    if (!cb.getCurrentSrc()) {
      return false;
    }
    return true;
  };

  const isCurrentSourceDeepLikePhaseReady = (): boolean => {
    if (!isCurrentSourceDeepLikeRefreshReady()) {
      return false;
    }
    if (!cb.isCurrentSourceContextReadyForAnalysis()) {
      return false;
    }
    return true;
  };

  const maybeStartCurrentSourceDeepLikePhase = (): void => {
    if (!isCurrentSourceDeepLikePhaseReady()) {
      return;
    }
    const likesController = cb.getLikesController();
    const { focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = buildCurrentSourceLikeSyncRequest(true);
    if (likesController.isSyncInFlight()) {
      return;
    }
    if (!likesController.shouldRunDeepSync(
      [focusAlbumIdentity, focusTrackIdentity, ...focusTrackIdentities]
    )) {
      return;
    }
    void requestDeepLikeSync(true).then(() => {
      cb.requestRender();
    });
  };

  const maybeStartScheduledDeepLikeSync = (): void => {
    if (!isCurrentSourceDeepLikeRefreshReady()) {
      return;
    }
    const likesController = cb.getLikesController();
    const { focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = buildCurrentSourceLikeSyncRequest(true);
    if (likesController.isSyncInFlight()) {
      return;
    }
    if (!likesController.shouldRunDeepSync(
      [focusAlbumIdentity, focusTrackIdentity, ...focusTrackIdentities]
    )) {
      return;
    }
    void requestDeepLikeSync(true).then(() => {
      cb.requestRender();
    });
  };

  const maybeStartCurrentSourceLikePhases = (forceForeground = false): void => {
    const shouldForceForeground = forceForeground || pendingForcedForegroundLikeSync;
    if (!cb.hasPlaybackStarted()) {
      return;
    }
    if (cb.getPlaylistTracks().length === 0) {
      return;
    }
    if (!cb.getCurrentSrc()) {
      return;
    }
    if (!cb.isCurrentSourceContextReadyForAnalysis()) {
      return;
    }
    const likesController = cb.getLikesController();
    if (shouldForceForeground && likesController.isInventoryReady() && !likesController.shouldRunForegroundSync()) {
      // Source-switch force can linger across render/timer churn. Once the full
      // inventory is already fresh again, drop the force instead of immediately
      // starting a redundant foreground sync.
      pendingForcedForegroundLikeSync = false;
      cb.maybeStartCurrentSourceBackgroundPhase();
      return;
    }
    if (likesController.isSyncInFlight()) {
      cb.maybeStartCurrentSourceBackgroundPhase();
      return;
    }
    if (!shouldForceForeground && !likesController.shouldRunForegroundSync()) {
      cb.maybeStartCurrentSourceBackgroundPhase();
      return;
    }
    pendingForcedForegroundLikeSync = false;
    void requestLikeSync(shouldForceForeground).then(() => {
      cb.maybeStartCurrentSourceBackgroundPhase();
      cb.requestRender();
    });
  };

  const resetLikesForOriginJump = (reason: string): void => {
    cb.getLikesController().hardResetForOriginJump(reason);
    likeMutationController.reset();
    pendingForcedForegroundLikeSync = true;
    cb.requestRender();
    maybeStartCurrentSourceLikePhases(true);
  };

  const showLikeNotice = (noticeText: string): void => {
    const message = String(noticeText || '').trim();
    if (!message) {
      return;
    }
    const state = cb.getState();
    const now = Date.now();
    state.likeNoticeText = message;
    state.likeNoticeExpiresAt = now + TRACK_ALBUM_LIKED_NOTICE_DURATION_MS;
    if (likeNoticeTimerId !== null) {
      window.clearTimeout(likeNoticeTimerId);
    }
    likeNoticeTimerId = window.setTimeout(() => {
      if (Date.now() >= state.likeNoticeExpiresAt) {
        state.likeNoticeText = '';
        state.likeNoticeExpiresAt = 0;
        cb.requestRender();
      }
      likeNoticeTimerId = null;
    }, TRACK_ALBUM_LIKED_NOTICE_DURATION_MS + 16);
    cb.requestRender();
  };

  const resolveBlockedLikeNotice = (target: 'album' | 'track', reasonCode: string): string => {
    if (reasonCode === 'blocked_cross_host_release_required' || reasonCode === 'blocked_recommendations_context') {
      return LIKE_CROSS_HOST_NOTICE_TEXT;
    }
    if (target === 'track' && reasonCode === TRACK_ALBUM_LIKED_NOTICE_REASON) {
      return TRACK_ALBUM_LIKED_NOTICE_TEXT;
    }
    if (LIKE_GUARD_NOTICE_REASONS.has(reasonCode)) {
      return LIKE_GUARD_NOTICE_TEXT;
    }
    return '';
  };

  const runLikeToggleWithRetry = (
    target: 'album' | 'track',
    trackIndex = cb.getPlaylistCurrentIndex(),
    retryCount = 0
  ): void => {
    const state = cb.getState();
    const likesController = cb.getLikesController();
    const tracks = cb.getPlaylistTracks();
    const safeTrackIndex =
      Number.isInteger(trackIndex) && trackIndex >= 0 && trackIndex < tracks.length
        ? trackIndex
        : cb.getPlaylistCurrentIndex();
    if (retryCount > 0) {
      patchLikeMutationDebug(state.likesDebug, { retryCount });
    }
    const albumState = state.likeViewState.albumState;
    const trackState = state.likeViewState.trackStates[safeTrackIndex] || 'unknown';
    const preflightAction = resolveLikeToggleAction(target, albumState, trackState);
    if (cb.isRecommendationsLikeContext()) {
      patchLikeMutationDebug(state.likesDebug, {
        target,
        action: preflightAction,
        inFlight: false,
        gate: 'blocked',
        reasonCode: 'blocked_recommendations_context'
      });
      setLikeMutationAction(state.likesDebug, target, preflightAction, 'blocked', 'blocked_recommendations_context');
      pushLikeProcessEvent(state.likesDebug, 'gate.blocked', `${target}:blocked_recommendations_context`);
      recordGuard(state, 'like-toggle-blocked-recommendations', `target=${target} index=${safeTrackIndex}`);
      showLikeNotice(LIKE_CROSS_HOST_NOTICE_TEXT);
      return;
    }
    const lockedAlbumLikeIdentity = cb.getLockedAlbumLikeIdentity();
    const latestAlbumLikeIdentity = cb.getLatestAlbumLikeIdentity();
    const targetIdentity =
      target === 'album' ? (lockedAlbumLikeIdentity || latestAlbumLikeIdentity) : resolveTrackLikeIdentityByIndex(safeTrackIndex);
    const boughtStateBlock = resolveBoughtStateBlock(
      target,
      albumState,
      target === 'album' ? albumState : trackState
    );
    let appliedPreflightOptimisticUi = false;
    if (!boughtStateBlock && (target === 'album' || target === 'track')) {
      if (applyOptimisticLikeMutation({
        likesController,
        action: preflightAction,
        target,
        identity: targetIdentity
      })) {
        likesController.applyDebug(state.likesDebug);
        cb.requestRender();
        appliedPreflightOptimisticUi = true;
      }
    }

    void likeMutationController
      .runToggle({
        target,
        albumState,
        targetState: target === 'album' ? albumState : trackState,
        explicitTrackLiked: target === 'track' ? trackState === 'liked' : undefined,
        identity: targetIdentity,
        syncLoading: Boolean(state.likeViewState.loading),
        syncError: String(state.likeViewState.notice || '').trim() === 'sync-error'
      })
      .then((result) => {
        if (result.ok) {
          finalizeLocalLikeMutation({
            likesController,
            action: result.action,
            target,
            identity: targetIdentity,
            appliedOptimisticUi: appliedPreflightOptimisticUi,
            resetReason: `player:${target}:mutation-cache-reset`
          });
          likesController.applyDebug(state.likesDebug);
          cb.requestRender();
          return;
        }

        if (appliedPreflightOptimisticUi) {
          rollbackOptimisticLikeMutation({
            likesController,
            action: preflightAction,
            target,
            identity: targetIdentity,
            resetReason: `player:${target}:mutation-local-rollback`
          });
          likesController.applyDebug(state.likesDebug);
        }
        showLikeNotice(resolveBlockedLikeNotice(target, result.reasonCode));
        if (
          result.blocked &&
          result.reasonCode === 'blocked_state_unresolved' &&
          retryCount < 1
        ) {
          window.setTimeout(() => {
            runLikeToggleWithRetry(target, safeTrackIndex, retryCount + 1);
          }, LIKE_BLOCKED_RETRY_DELAY_MS);
        }
        cb.requestRender();
      });
  };

  const clearNoticeTimer = (): void => {
    if (likeNoticeTimerId !== null) {
      window.clearTimeout(likeNoticeTimerId);
      likeNoticeTimerId = null;
    }
  };

  return {
    likeMutationController,
    LIKE_WRITES_ENABLED,
    resolveTrackLikeIdentityByIndex,
    resolveFocusedTrackLikeIdentities,
    maybeStartCurrentSourceLikePhases,
    maybeStartCurrentSourceDeepLikePhase,
    maybeStartScheduledDeepLikeSync,
    resetLikesForOriginJump,
    runLikeToggleWithRetry,
    clearNoticeTimer
  };
}
