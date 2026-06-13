import type { LikesDebugSnapshot, LikeViewState, PlaylistState } from '@/shared/types';

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

export function updateLikeDebugDocumentAttrs(
  likesDebug: LikesDebugSnapshot,
  likeState: LikeViewState,
  playlist: PlaylistState
): void {
  const root = document.documentElement;
  if (!root) {
    return;
  }

  const activeTrackIndex = Number.isInteger(playlist.currentIndex) ? playlist.currentIndex : -1;
  const activeTrackState =
    activeTrackIndex >= 0 && likeState.trackStates[activeTrackIndex]
      ? likeState.trackStates[activeTrackIndex]
      : 'n/a';

  likesDebug.albumState = likeState.albumState;
  likesDebug.activeTrackIndex = activeTrackIndex;
  likesDebug.activeTrackState = activeTrackState;
  likesDebug.displayAlbumState = likeState.albumState;
  likesDebug.displayActiveTrackState = activeTrackState;
  // trackProjection is the album surface (bought/liked) projected onto its tracks.
  // It's set precisely by the resolve pass, but this function is the live per-render
  // sync of the album display state — so when the current album surface no longer
  // supports a projection (e.g. right after an origin switch clears the view, before
  // the next resolve pass), drop the stale projection so the transition reads clean
  // instead of carrying the previous track's album-bought/album-liked.
  if (likeState.albumState !== 'bought' && likeState.albumState !== 'liked') {
    likesDebug.trackProjection = '-';
  }

  const compactPayload = {
    phase: likesDebug.phase,
    context: likesDebug.context,
    contextFamily: likesDebug.contextFamily,
    contextVariant: likesDebug.contextVariant,
    fanSlug: likesDebug.fanSlug,
    fanId: likesDebug.fanId,
    syncStatus: likesDebug.syncStatus,
    syncReason: likesDebug.syncReason,
    syncRunSeq: likesDebug.syncRunSeq,
    syncInFlightSince: likesDebug.syncInFlightSince,
    lastSyncTs: likesDebug.lastSyncTs,
    endpointStatus: likesDebug.endpointStatus,
    endpointAttempts: likesDebug.endpointAttempts,
    nextRetryTs: likesDebug.nextRetryTs,
    inventoryCounts: likesDebug.inventoryCounts,
    boughtCacheStatus: likesDebug.boughtCacheStatus,
    boughtCacheUpdatedAt: likesDebug.boughtCacheUpdatedAt,
    boughtCacheLastReadAt: likesDebug.boughtCacheLastReadAt,
    boughtCacheLastWriteAt: likesDebug.boughtCacheLastWriteAt,
    boughtCacheCollectionAlbumIds: likesDebug.boughtCacheCollectionAlbumIds,
    boughtCacheCollectionTrackIds: likesDebug.boughtCacheCollectionTrackIds,
    boughtCacheCollectionAlbumUrls: likesDebug.boughtCacheCollectionAlbumUrls,
    boughtCacheCollectionTrackUrls: likesDebug.boughtCacheCollectionTrackUrls,
    albumState: likesDebug.albumState,
    activeTrackIndex: likesDebug.activeTrackIndex,
    activeTrackState: likesDebug.activeTrackState,
    truthAlbumState: likesDebug.truthAlbumState,
    truthActiveTrackState: likesDebug.truthActiveTrackState,
    displayAlbumState: likesDebug.displayAlbumState,
    displayActiveTrackState: likesDebug.displayActiveTrackState,
    trackProjection: likesDebug.trackProjection,
    lastAction: likesDebug.lastAction,
    lastActionTs: likesDebug.lastActionTs,
    lastError: likesDebug.lastError,
    mutation: likesDebug.mutation,
    processEvents: Array.isArray(likesDebug.processEvents) ? likesDebug.processEvents.slice(-20) : []
  };

  root.setAttribute('data-bc-like-debug', safeJsonStringify(compactPayload));
  root.setAttribute(
    'data-bc-like-current',
    safeJsonStringify({
      albumTruth: likesDebug.truthAlbumState,
      albumDisplay: likesDebug.displayAlbumState,
      activeTrackIndex: likesDebug.activeTrackIndex,
      trackTruth: likesDebug.truthActiveTrackState,
      trackDisplay: likesDebug.displayActiveTrackState,
      projection: likesDebug.trackProjection
    })
  );
}
