import type {
  LikeIdentity,
  LikeViewState,
  LikesDebugSnapshot,
  PageGlobals,
  PlaylistState
} from '@/shared/types';
import { detectPageContext } from '@/content/page-context';
import {
  getLatestPageGlobals
} from '@/content/discover/origin-bridge';
import {
  buildLikeSyncInputFromPageContext,
  type LikesStatusController
} from '@/content/likes/inventory';
import { buildFocusTruthKey } from '@/content/likes/inventory-helpers';
import { resolveBoughtStateBlock } from '@/content/likes/mutation-gate';
import { LikeMutationController } from '@/content/likes/mutation-controller';
import {
  applyOptimisticLikeMutation,
  finalizeLocalLikeMutation,
  rollbackOptimisticLikeMutation,
  resolveLikeToggleAction
} from '@/content/likes/toggle-helpers';
import { patchLikeMutationDebug } from '@/content/likes/mutation-debug';
import {
  normalizeLikeId,
  toCanonicalLikeUrl
} from '@/content/likes/state';
import {
  playlistContainsSourceTrack
} from '@/content/playlist/track-identity';
import { normalizeUrl } from '@/content/playlist/resolver';

// --- Constants ---

const LIKE_WRITES_ENABLED = true;
const LIKE_BLOCKED_RETRY_DELAY_MS = 260;
const LIKE_BLOCKED_MAX_RETRIES = 20;
const TRACK_ALBUM_LIKED_NOTICE_REASON = 'blocked_track_uncollect_album_liked';
const TRACK_ALBUM_LIKED_NOTICE_TEXT = 'Remove album from your wishlist first,\nto add/remove single tracks.';
const TRACK_ALBUM_LIKED_NOTICE_DURATION_MS = 3600;
const LIKE_GUARD_NOTICE_TEXT = 'Please wait until wishlist sync completes,\nthen try again.';
const LIKE_GUARD_NOTICE_REASONS = new Set([
  'blocked_state_unresolved',
  'blocked_in_flight',
  'blocked_cooldown',
  'blocked_recommendations_context'
]);

// --- Callback interface ---

export interface DiscoverLikeControllerCallbacks {
  // State
  getPlaylistState(): PlaylistState;
  getPlaylistSource(): string;
  getNowPlayingStreamUrl(): string;
  getLikeViewState(): LikeViewState;
  setLikeViewState(view: LikeViewState): void;
  getLikeNoticeText(): string;
  setLikeNoticeText(text: string): void;

  // Identity resolution (stays in controller.ts)
  resolveAlbumLikeIdentity(apiOnly?: boolean, globals?: PageGlobals | null): LikeIdentity | null;
  resolveApiOnlyLikeIdentityMode(globals?: PageGlobals | null): boolean;
  resolveTrackLikeIdentity(index?: number): LikeIdentity | null;
  resolveFocusedTrackLikeIdentities(): LikeIdentity[];
  isPlaylistSourceValid(): boolean;

  // Controllers
  getLikesController(): LikesStatusController;

  // Integration
  render(): void;
  refreshLikeSnapshot(): void;
}

// --- Public interface ---

export interface DiscoverLikeController {
  readonly likeMutationController: LikeMutationController;
  readonly LIKE_WRITES_ENABLED: boolean;
  requestLikeSyncIfActive(force?: boolean): void;
  maybeStartScheduledDeepLikeSync(): void;
  resetLikesForOriginJump(reason: string): void;
  runWishlistToggle(target: 'album' | 'track', trackIndex?: number): Promise<void>;
  clearNoticeTimer(): void;
  getLikeNoticeText(): string;
  getLikeNoticeExpiresAt(): number;
  getPendingLikeSyncAfterPlaylistReady(): boolean;
  setPendingLikeSyncAfterPlaylistReady(val: boolean): void;
}

// --- Factory ---

export function createDiscoverLikeController(
  cb: DiscoverLikeControllerCallbacks,
  likesDebug: LikesDebugSnapshot
): DiscoverLikeController {
  let likeNoticeExpiresAt = 0;
  let likeNoticeTimerId: number | null = null;
  let pendingLikeSyncAfterPlaylistReady = false;
  let activeSyncFocusKey = '';

  const likeMutationController = new LikeMutationController({
    context: 'discover',
    likesDebug,
    writesEnabled: LIKE_WRITES_ENABLED,
    render: () => {
      cb.render();
    }
  });

  const buildFocusKeyFromIdentity = (
    itemType: 'album' | 'track',
    identity: LikeIdentity | null | undefined
  ): string => {
    return buildFocusTruthKey({
      itemId: normalizeLikeId(identity?.itemId || ''),
      itemType,
      urls: [toCanonicalLikeUrl(String(identity?.pageUrl || ''))].filter(Boolean)
    });
  };

  const resolveActiveFocusKey = (
    focusAlbumIdentity: LikeIdentity | null,
    focusTrackIdentity: LikeIdentity | null,
    focusTrackIdentities: LikeIdentity[]
  ): string => {
    const albumKey = buildFocusKeyFromIdentity('album', focusAlbumIdentity);
    if (albumKey) {
      return albumKey;
    }
    const trackKeys = new Set<string>();
    [focusTrackIdentity, ...focusTrackIdentities].forEach((identity) => {
      const trackKey = buildFocusKeyFromIdentity('track', identity);
      if (trackKey) {
        trackKeys.add(trackKey);
      }
    });
    return Array.from(trackKeys).sort().join('|');
  };

  // --- Sync ---

  const resolveDiscoverLikeSyncRequest = (force = false) => {
    const globals = getLatestPageGlobals(60_000);
    const focusAlbumIdentity = cb.resolveAlbumLikeIdentity(cb.resolveApiOnlyLikeIdentityMode(globals), globals);
    const playlistState = cb.getPlaylistState();
    const focusTrackIdentity = cb.resolveTrackLikeIdentity(playlistState.currentIndex);
    const focusTrackIdentities = cb.resolveFocusedTrackLikeIdentities();
    const syncInput = buildLikeSyncInputFromPageContext(
      detectPageContext({
        pageGlobals: globals
      }),
      force
    );

    return {
      syncInput,
      focusAlbumIdentity,
      focusTrackIdentity,
      focusTrackIdentities
    };
  };

  const requestLikeSync = (force = false): void => {
    const { syncInput, focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = resolveDiscoverLikeSyncRequest(force);
    const likesController = cb.getLikesController();
    const nextFocusKey = resolveActiveFocusKey(
      focusAlbumIdentity,
      focusTrackIdentity,
      focusTrackIdentities
    );

    if (
      nextFocusKey &&
      activeSyncFocusKey &&
      nextFocusKey !== activeSyncFocusKey &&
      likesController.isSyncInFlight()
    ) {
      likesController.hardResetForOriginJump('discover:focus-change');
    }
    activeSyncFocusKey = nextFocusKey || activeSyncFocusKey;

    const likeViewState = cb.getLikeViewState();
    const shouldRefreshUiAfterSync = Boolean(likeViewState.loading) || String(likeViewState.notice || '').trim() === 'sync-error';
    void likesController
      .sync({
        ...syncInput,
        silent: false,
        focusAlbumIdentity,
        focusTrackIdentity,
        focusTrackIdentities
      })
      .then((changed) => {
        cb.refreshLikeSnapshot();
        if (changed || shouldRefreshUiAfterSync) {
          cb.render();
        }
        maybeStartDeepLikeSync();
      })
      .catch(() => {
        cb.refreshLikeSnapshot();
        if (shouldRefreshUiAfterSync) {
          cb.render();
        }
      });
  };

  const requestDeepLikeSync = (force = true): void => {
    const { syncInput, focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = resolveDiscoverLikeSyncRequest(force);
    const likesController = cb.getLikesController();
    void likesController
      .sync({
        ...syncInput,
        silent: true,
        focusAlbumIdentity,
        focusTrackIdentity,
        focusTrackIdentities
      })
      .then((changed) => {
        cb.refreshLikeSnapshot();
        if (changed) {
          cb.render();
        }
      })
      .catch(() => {
        cb.refreshLikeSnapshot();
      });
  };

  const shouldRequestLikeSync = (): boolean => {
    return cb.getPlaylistSource() !== 'waiting-for-origin-play';
  };

  const isPlaylistReadyForLikeSync = (): boolean => {
    const playlistState = cb.getPlaylistState();
    if (playlistState.loading) {
      return false;
    }
    const playlistSource = cb.getPlaylistSource();
    const normalizedSource = String(playlistSource || '').trim();
    if (!playlistState.tracks.length) {
      return false;
    }
    if (!normalizedSource || normalizedSource.startsWith('none') || normalizedSource.includes('(stale-track)')) {
      return false;
    }
    return cb.isPlaylistSourceValid();
  };

  const isDiscoverLikePhaseReady = (): boolean => {
    if (!shouldRequestLikeSync()) {
      return false;
    }
    return isPlaylistReadyForLikeSync();
  };

  const maybeStartDeepLikeSync = (): void => {
    if (!isDiscoverLikePhaseReady()) {
      return;
    }
    const likesController = cb.getLikesController();
    const { focusAlbumIdentity, focusTrackIdentity, focusTrackIdentities } = resolveDiscoverLikeSyncRequest(true);
    if (likesController.isSyncInFlight()) {
      return;
    }
    if (!likesController.shouldRunDeepSync(
      [focusAlbumIdentity, focusTrackIdentity, ...focusTrackIdentities]
    )) {
      return;
    }
    requestDeepLikeSync(true);
  };

  const maybeStartScheduledDeepLikeSync = (): void => {
    maybeStartDeepLikeSync();
  };

  const requestLikeSyncIfActive = (force = false): void => {
    if (!shouldRequestLikeSync()) {
      return;
    }
    if (!force && !isPlaylistReadyForLikeSync()) {
      pendingLikeSyncAfterPlaylistReady = true;
      return;
    }
    pendingLikeSyncAfterPlaylistReady = false;
    const likesController = cb.getLikesController();
    if (likesController.isSyncInFlight()) {
      return;
    }
    if (!force && !likesController.shouldRunForegroundSync()) {
      maybeStartDeepLikeSync();
      return;
    }
    requestLikeSync(force);
  };

  // --- Reset ---

  const resetLikesForOriginJump = (reason: string): void => {
    cb.getLikesController().hardResetForOriginJump(reason);
    likeMutationController.reset();
    pendingLikeSyncAfterPlaylistReady = true;
    activeSyncFocusKey = '';
    cb.refreshLikeSnapshot();
  };

  // --- Notices ---

  const showLikeNotice = (noticeText: string): void => {
    const message = String(noticeText || '').trim();
    if (!message) {
      return;
    }
    const now = Date.now();
    const currentNoticeText = cb.getLikeNoticeText();
    if (currentNoticeText === message && likeNoticeExpiresAt > now) {
      return;
    }
    cb.setLikeNoticeText(message);
    likeNoticeExpiresAt = now + TRACK_ALBUM_LIKED_NOTICE_DURATION_MS;
    if (likeNoticeTimerId !== null) {
      window.clearTimeout(likeNoticeTimerId);
    }
    likeNoticeTimerId = window.setTimeout(() => {
      if (Date.now() >= likeNoticeExpiresAt) {
        cb.setLikeNoticeText('');
        likeNoticeExpiresAt = 0;
        cb.render();
      }
      likeNoticeTimerId = null;
    }, TRACK_ALBUM_LIKED_NOTICE_DURATION_MS + 16);
    cb.render();
  };

  const resolveBlockedLikeNotice = (target: 'album' | 'track', reasonCode: string): string => {
    if (target === 'track' && reasonCode === TRACK_ALBUM_LIKED_NOTICE_REASON) {
      return TRACK_ALBUM_LIKED_NOTICE_TEXT;
    }
    if (LIKE_GUARD_NOTICE_REASONS.has(reasonCode)) {
      return LIKE_GUARD_NOTICE_TEXT;
    }
    return '';
  };

  // --- Wishlist toggle ---

  const runWishlistToggle = async (
    target: 'album' | 'track',
    trackIndex?: number,
    retryCount = 0
  ): Promise<void> => {
    if (retryCount > 0) {
      patchLikeMutationDebug(likesDebug, { retryCount });
    }
    const playlistState = cb.getPlaylistState();
    const likeViewState = cb.getLikeViewState();
    const effectiveTrackIndex = trackIndex ?? playlistState.currentIndex;
    const safeTrackIndex = Number.isInteger(effectiveTrackIndex) && effectiveTrackIndex >= 0 && effectiveTrackIndex < playlistState.tracks.length
      ? effectiveTrackIndex
      : playlistState.currentIndex;
    const identity = target === 'track'
      ? cb.resolveTrackLikeIdentity(safeTrackIndex)
      : cb.resolveAlbumLikeIdentity(cb.resolveApiOnlyLikeIdentityMode());
    const targetState = target === 'track' ? likeViewState.trackStates[safeTrackIndex] || 'unknown' : likeViewState.albumState;
    const preflightAction = resolveLikeToggleAction(target, likeViewState.albumState, targetState);
    const boughtStateBlock = resolveBoughtStateBlock(target, likeViewState.albumState, targetState);
    let appliedPreflightOptimisticUi = false;
    if (!boughtStateBlock && applyOptimisticLikeMutation({
      likesController: cb.getLikesController(),
      action: preflightAction,
      target,
      identity
    })) {
      cb.refreshLikeSnapshot();
      cb.render();
      appliedPreflightOptimisticUi = true;
    }
    const result = await likeMutationController.runToggle({
      target,
      albumState: likeViewState.albumState,
      targetState,
      explicitTrackLiked: target === 'track' ? targetState === 'liked' : undefined,
      identity,
      syncLoading: Boolean(likeViewState.loading),
      syncError: String(likeViewState.notice || '').trim() === 'sync-error'
    });

    if (!result.ok) {
      const canRetryBlockedState =
        result.blocked &&
        (
          result.reasonCode === 'blocked_state_unresolved' ||
          result.reasonCode === 'blocked_in_flight' ||
          result.reasonCode === 'blocked_cooldown'
        ) &&
        retryCount < LIKE_BLOCKED_MAX_RETRIES;
      if (target === 'track' && canRetryBlockedState && retryCount === 0) {
        showLikeNotice(resolveBlockedLikeNotice(target, result.reasonCode));
      }
      if (!canRetryBlockedState) {
        showLikeNotice(resolveBlockedLikeNotice(target, result.reasonCode));
      }
      if (appliedPreflightOptimisticUi) {
        rollbackOptimisticLikeMutation({
          likesController: cb.getLikesController(),
          action: preflightAction,
          target,
          identity,
          resetReason: `discover:${target}:mutation-local-rollback`
        });
        cb.refreshLikeSnapshot();
      }
      if (
        canRetryBlockedState
      ) {
        window.setTimeout(() => {
          void runWishlistToggle(target, safeTrackIndex, retryCount + 1);
        }, LIKE_BLOCKED_RETRY_DELAY_MS);
      }
      cb.render();
      return;
    }

    finalizeLocalLikeMutation({
      likesController: cb.getLikesController(),
      action: result.action,
      target,
      identity,
      appliedOptimisticUi: appliedPreflightOptimisticUi,
      resetReason: `discover:${target}:mutation-cache-reset`
    });
    cb.refreshLikeSnapshot();
    cb.render();
  };

  // --- Public interface ---

  return {
    likeMutationController,
    LIKE_WRITES_ENABLED,
    requestLikeSyncIfActive,
    maybeStartScheduledDeepLikeSync,
    resetLikesForOriginJump,
    runWishlistToggle: (target, trackIndex) => runWishlistToggle(target, trackIndex),
    clearNoticeTimer: () => {
      if (likeNoticeTimerId !== null) {
        window.clearTimeout(likeNoticeTimerId);
        likeNoticeTimerId = null;
      }
    },
    getLikeNoticeText: () => cb.getLikeNoticeText(),
    getLikeNoticeExpiresAt: () => likeNoticeExpiresAt,
    getPendingLikeSyncAfterPlaylistReady: () => pendingLikeSyncAfterPlaylistReady,
    setPendingLikeSyncAfterPlaylistReady: (val) => { pendingLikeSyncAfterPlaylistReady = val; }
  };
}
