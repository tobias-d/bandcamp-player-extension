import type {
  LikeEndpointAttempts,
  LikeEndpointDebug,
  LikeInventoryCounts,
  LikeMutationDebug,
  LikesDebugSnapshot,
  LikeViewState,
  PlaylistState,
  TrackMetadata
} from '@/shared/types';

export const ANALYSIS_VERSION = '2026-05-22-full-waveform-refinement';
export const ANALYSIS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const ANALYSIS_PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ANALYSIS_CACHE_MAX_ENTRIES = 200;
export const ANALYSIS_SAMPLE_RATE = 16_000;
export const ANALYSIS_CACHE_STORAGE_KEY = '__BC_ANALYSIS_CACHE_V2__';
export const ANALYSIS_DECODED_AUDIO_TTL_MS = 10 * 60 * 1000;
export const ANALYSIS_DECODED_AUDIO_MAX_ENTRIES = 8;

export const PANEL_POS_KEY = '__BC_PANEL_POS__';
export const DEBUG_PANEL_POS_KEY = '__BC_DEBUG_PANEL_POS__';
export const PLAYLIST_EXPANDED_KEY = '__BC_BPM_PLAYLIST_EXPANDED__';
export const AUTO_PRELOAD_KEY = '__BC_BPM_TRACKLIST_PRELOAD_ENABLED__';
export const DEBUG_KEY = '__BC_PLAYER_DEBUG__';
export const DEBUG_TAGS_KEY = '__BC_PLAYER_DEBUG_TAGS__';
export const SHARED_LIKES_CACHE_MAX_AGE_MS = 30 * 60 * 1000;
export const LIKES_DEEP_SYNC_POLL_INTERVAL_MS = 60_000;
export const LIKES_FANCOLLECTION_PAGE_SIZE = 1000;
export const LIKES_FANCOLLECTION_FETCH_TIMEOUT_MS = 15_000;
export const LIKES_FANCOLLECTION_MESSAGE_TIMEOUT_MS = LIKES_FANCOLLECTION_FETCH_TIMEOUT_MS + 5_000;

export const TRALBUM_API_URL = '/api/tralbum/2/info';
export const COLLECTION_SUMMARY_API = '/api/fan/2/collection_summary';

export const DEFAULT_TRACK_METADATA: TrackMetadata = {
  artistName: '---',
  trackTitle: '---',
  albumTitle: '---',
  combined: '---',
  confidence: 'low',
  sources: {
    title: 'default',
    artist: 'default',
    album: 'default'
  }
};

export const DEFAULT_PLAYLIST_STATE: PlaylistState = {
  tracks: [],
  currentIndex: 0,
  expanded: true,
  loading: false,
  sortKey: 'index',
  sortAsc: true,
  releasePageUrl: ''
};

export const DEFAULT_LIKE_VIEW_STATE: LikeViewState = {
  albumState: 'unknown',
  loading: false,
  disabled: false,
  trackStates: {}
};

export function createDefaultLikeInventoryCounts(): LikeInventoryCounts {
  return {
    wishlistAlbumIds: 0,
    wishlistTrackIds: 0,
    wishlistAlbumUrls: 0,
    wishlistTrackUrls: 0,
    collectionAlbumIds: 0,
    collectionTrackIds: 0,
    collectionAlbumUrls: 0,
    collectionTrackUrls: 0
  };
}

export function createDefaultLikeEndpointStatus(): LikeEndpointDebug {
  return {
    wishlist: 'n/a',
    collection: 'n/a'
  };
}

export function createDefaultLikeEndpointAttempts(): LikeEndpointAttempts {
  return {
    wishlist: 0,
    collection: 0
  };
}

export function createDefaultLikeMutationDebug(): LikeMutationDebug {
  return {
    enabled: false,
    inFlight: false,
    target: 'none',
    action: 'none',
    key: '',
    gate: 'n/a',
    reasonCode: '',
    requestOrigin: '',
    requestContextFamily: '',
    requestContextVariant: '',
    selectedOriginReason: '',
    endpointPath: '',
    status: 0,
    ok: false,
    cooldownMsRemaining: 0,
    identityItemId: '',
    identityItemType: '',
    identityBandId: '',
    identityPageUrl: '',
    pageHost: '',
    targetHost: '',
    sameHost: false,
    fanIdPresent: false,
    fanIdValue: '',
    crumbPresent: false,
    crumbLength: 0,
    crumbSource: '',
    retryCount: 0,
    preflightReason: '',
    requestPreview: '',
    responsePreview: '',
    transport: '',
    preflightAt: 0,
    dispatchAt: 0,
    completedAt: 0,
    durationMs: 0,
    ts: 0
  };
}

export function createDefaultLikesDebugSnapshot(context: string): LikesDebugSnapshot {
  return {
    phase: 'phase-1-status',
    context: String(context || 'unknown'),
    contextFamily: '',
    contextVariant: '',
    fanSlug: '',
    fanId: '',
    syncStatus: 'idle',
    syncReason: 'not-started',
    syncRunSeq: 0,
    syncInFlightSince: 0,
    lastSyncTs: 0,
    endpointStatus: createDefaultLikeEndpointStatus(),
    endpointAttempts: createDefaultLikeEndpointAttempts(),
    nextRetryTs: 0,
    inventoryCounts: createDefaultLikeInventoryCounts(),
    boughtCacheStatus: 'not-read',
    boughtCacheUpdatedAt: 0,
    boughtCacheLastReadAt: 0,
    boughtCacheLastWriteAt: 0,
    boughtCacheCollectionAlbumIds: 0,
    boughtCacheCollectionTrackIds: 0,
    boughtCacheCollectionAlbumUrls: 0,
    boughtCacheCollectionTrackUrls: 0,
    albumState: 'unknown',
    activeTrackIndex: -1,
    activeTrackState: 'n/a',
    truthAlbumState: 'unknown',
    truthActiveTrackState: 'n/a',
    displayAlbumState: 'unknown',
    displayActiveTrackState: 'n/a',
    trackProjection: '-',
    identityTrust: '-',
    identityReason: '-',
    lastAction: 'none',
    lastActionTs: 0,
    lastError: '',
    mutation: createDefaultLikeMutationDebug(),
    processEvents: []
  };
}
