import type {
  LikeIdentity,
  LikeInventoryCounts,
  LikeState,
  LikeViewState,
  PlaylistTrack,
  SerializedBoughtLikeInventory,
  SerializedLikeInventory
} from '@/shared/types';

export interface LikeInventorySets {
  wishlistAlbumIds: Set<string>;
  wishlistTrackIds: Set<string>;
  wishlistAlbumUrls: Set<string>;
  wishlistTrackUrls: Set<string>;
  collectionAlbumIds: Set<string>;
  collectionTrackIds: Set<string>;
  collectionAlbumUrls: Set<string>;
  collectionTrackUrls: Set<string>;
}

export interface LikeIdentityInput {
  itemId: string;
  itemType: 'album' | 'track';
  urls: string[];
}

export interface TrackLikeIdentityTrust {
  ready: boolean;
  trackId: string;
  source: string;
  reason: string;
}

export function createEmptyLikeInventorySets(): LikeInventorySets {
  return {
    wishlistAlbumIds: new Set<string>(),
    wishlistTrackIds: new Set<string>(),
    wishlistAlbumUrls: new Set<string>(),
    wishlistTrackUrls: new Set<string>(),
    collectionAlbumIds: new Set<string>(),
    collectionTrackIds: new Set<string>(),
    collectionAlbumUrls: new Set<string>(),
    collectionTrackUrls: new Set<string>()
  };
}

export function toCanonicalLikeUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function canonicalizeLikeIdentityPageUrl(
  itemType: 'album' | 'track',
  raw: string
): string {
  const canonical = toCanonicalLikeUrl(raw);
  if (!canonical) {
    return '';
  }
  if (itemType === 'track') {
    return canonical.includes('/track/') ? canonical : '';
  }
  return canonical.includes('/album/') ? canonical : '';
}

export function normalizeLikeId(raw: unknown): string {
  return String(raw ?? '').replace(/[^\d]/g, '').trim();
}

function readTrackIdFromStreamUrl(url: string): string {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  const queryMatch = value.match(/[?&]track_id=(\d{4,})/i);
  if (queryMatch?.[1]) {
    return normalizeLikeId(queryMatch[1]);
  }
  const pathMatch = value.match(/\/(\d{4,})(?:[/?#]|$)/);
  if (pathMatch?.[1]) {
    return normalizeLikeId(pathMatch[1]);
  }
  return '';
}

function normalizePlaylistIdentitySource(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    return 'none';
  }
  if (value.startsWith('TralbumAPI')) {
    return 'TralbumAPI';
  }
  if (value.startsWith('TralbumData')) {
    return 'TralbumData';
  }
  return value;
}

function isTrustedLikeIdentitySource(source: string): boolean {
  return source === 'TralbumAPI' || source === 'TralbumData';
}

export function isTrustedPlaylistLikeSource(source: string): boolean {
  return isTrustedLikeIdentitySource(normalizePlaylistIdentitySource(source));
}

export function evaluateTrackLikeIdentityTrust(
  track: PlaylistTrack | null | undefined,
  playlistSource = ''
): TrackLikeIdentityTrust {
  if (!track) {
    return {
      ready: false,
      trackId: '',
      source: normalizePlaylistIdentitySource(playlistSource),
      reason: 'track=missing'
    };
  }

  const source = normalizePlaylistIdentitySource(String(track.identitySource || '') || playlistSource);
  const trackId = normalizeLikeId(track.trackId || '') || readTrackIdFromStreamUrl(String(track.streamUrl || ''));
  if (!trackId) {
    return {
      ready: false,
      trackId: '',
      source,
      reason: `trackId=missing source=${source}`
    };
  }

  if (!isTrustedLikeIdentitySource(source)) {
    return {
      ready: false,
      trackId,
      source,
      reason: `source=untrusted(${source}) trackId=${trackId}`
    };
  }

  return {
    ready: true,
    trackId,
    source,
    reason: `source=${source} trackId=${trackId}`
  };
}

export function buildLikeIdentity(identity: LikeIdentity | null | undefined): LikeIdentityInput | null {
  if (!identity) {
    return null;
  }
  const itemType = identity.itemType === 'track' ? 'track' : 'album';
  const itemId = normalizeLikeId(identity.itemId);
  const canonicalUrl = canonicalizeLikeIdentityPageUrl(itemType, identity.pageUrl || '');
  if (!itemId && !canonicalUrl) {
    return null;
  }
  const urls = canonicalUrl ? [canonicalUrl] : [];
  return {
    itemId,
    itemType,
    urls
  };
}

function resolveMembership(
  identity: LikeIdentityInput | null,
  sets: LikeInventorySets
): { inWishlist: boolean; inCollection: boolean } {
  if (!identity) {
    return { inWishlist: false, inCollection: false };
  }

  const isTrack = identity.itemType === 'track';
  const inWishlistById = Boolean(
    identity.itemId &&
      (isTrack ? sets.wishlistTrackIds : sets.wishlistAlbumIds).has(identity.itemId)
  );
  const inCollectionById = Boolean(
    identity.itemId &&
      (isTrack ? sets.collectionTrackIds : sets.collectionAlbumIds).has(identity.itemId)
  );
  const wishlistUrlSet = isTrack ? sets.wishlistTrackUrls : sets.wishlistAlbumUrls;
  const collectionUrlSet = isTrack ? sets.collectionTrackUrls : sets.collectionAlbumUrls;
  const inWishlistByUrl = identity.urls.some((url) => wishlistUrlSet.has(url));
  const inCollectionByUrl = identity.urls.some((url) => collectionUrlSet.has(url));

  return {
    inWishlist: inWishlistById || inWishlistByUrl,
    inCollection: inCollectionById || inCollectionByUrl
  };
}

function toState(inWishlist: boolean, inCollection: boolean, allowDisliked: boolean): LikeState {
  if (inCollection) {
    return 'bought';
  }
  if (inWishlist) {
    return 'liked';
  }
  return allowDisliked ? 'disliked' : 'unknown';
}

export function resolveAlbumState(
  albumIdentity: LikeIdentityInput | null,
  sets: LikeInventorySets,
  allowDisliked: boolean
): LikeState {
  if (!albumIdentity) {
    return 'unknown';
  }
  const membership = resolveMembership(albumIdentity, sets);
  return toState(membership.inWishlist, membership.inCollection, allowDisliked);
}

export function resolveTrackState(
  trackIdentity: LikeIdentityInput | null,
  sets: LikeInventorySets,
  allowDisliked: boolean
): LikeState {
  if (!trackIdentity) {
    return 'unknown';
  }
  const membership = resolveMembership(trackIdentity, sets);
  return toState(membership.inWishlist, membership.inCollection, allowDisliked);
}

export function buildLikeViewState(
  sets: LikeInventorySets,
  albumIdentity: LikeIdentityInput | null,
  playlistTracks: PlaylistTrack[],
  syncInFlight: boolean,
  allowDisliked: boolean,
  trackIdentityReady: boolean,
  writesDisabled: boolean,
  likeNotice = ''
): LikeViewState {
  const albumState = resolveAlbumState(albumIdentity, sets, allowDisliked);
  const trackStates: Record<number, LikeState> = {};

  playlistTracks.forEach((track, index) => {
    if (!trackIdentityReady) {
      trackStates[index] = 'unknown';
      return;
    }
    const trackIdentity = buildLikeIdentity({
      itemId: track.trackId || '',
      itemType: 'track',
      pageUrl: track.pageUrl || ''
    });
    trackStates[index] = resolveTrackState(trackIdentity, sets, allowDisliked);
  });

  return {
    albumState,
    loading: syncInFlight,
    disabled: writesDisabled || syncInFlight,
    notice: likeNotice,
    trackStates
  };
}

export function applyLikeStatesToPlaylist(
  playlistTracks: PlaylistTrack[],
  viewState: LikeViewState
): PlaylistTrack[] {
  if (!playlistTracks.length) {
    return playlistTracks;
  }

  let changed = false;
  const nextTracks = playlistTracks.map((track, index) => {
    const nextLikeState = viewState.trackStates[index] || 'unknown';
    if (track.likeState === nextLikeState) {
      return track;
    }
    changed = true;
    return {
      ...track,
      likeState: nextLikeState
    };
  });

  return changed ? nextTracks : playlistTracks;
}

export function getLikeInventoryCounts(sets: LikeInventorySets): LikeInventoryCounts {
  return {
    wishlistAlbumIds: sets.wishlistAlbumIds.size,
    wishlistTrackIds: sets.wishlistTrackIds.size,
    wishlistAlbumUrls: sets.wishlistAlbumUrls.size,
    wishlistTrackUrls: sets.wishlistTrackUrls.size,
    collectionAlbumIds: sets.collectionAlbumIds.size,
    collectionTrackIds: sets.collectionTrackIds.size,
    collectionAlbumUrls: sets.collectionAlbumUrls.size,
    collectionTrackUrls: sets.collectionTrackUrls.size
  };
}

export function serializeLikeInventorySets(sets: LikeInventorySets): SerializedLikeInventory {
  return {
    wishlistAlbumIds: Array.from(sets.wishlistAlbumIds),
    wishlistTrackIds: Array.from(sets.wishlistTrackIds),
    wishlistAlbumUrls: Array.from(sets.wishlistAlbumUrls),
    wishlistTrackUrls: Array.from(sets.wishlistTrackUrls),
    collectionAlbumIds: Array.from(sets.collectionAlbumIds),
    collectionTrackIds: Array.from(sets.collectionTrackIds),
    collectionAlbumUrls: Array.from(sets.collectionAlbumUrls),
    collectionTrackUrls: Array.from(sets.collectionTrackUrls)
  };
}

export function serializeBoughtLikeInventorySets(sets: LikeInventorySets): SerializedBoughtLikeInventory {
  return {
    collectionAlbumIds: Array.from(sets.collectionAlbumIds),
    collectionTrackIds: Array.from(sets.collectionTrackIds),
    collectionAlbumUrls: Array.from(sets.collectionAlbumUrls),
    collectionTrackUrls: Array.from(sets.collectionTrackUrls)
  };
}

export function applySerializedLikeInventory(
  target: LikeInventorySets,
  snapshot: SerializedLikeInventory | null | undefined
): void {
  target.wishlistAlbumIds = new Set(snapshot?.wishlistAlbumIds || []);
  target.wishlistTrackIds = new Set(snapshot?.wishlistTrackIds || []);
  target.wishlistAlbumUrls = new Set(snapshot?.wishlistAlbumUrls || []);
  target.wishlistTrackUrls = new Set(snapshot?.wishlistTrackUrls || []);
  target.collectionAlbumIds = new Set(snapshot?.collectionAlbumIds || []);
  target.collectionTrackIds = new Set(snapshot?.collectionTrackIds || []);
  target.collectionAlbumUrls = new Set(snapshot?.collectionAlbumUrls || []);
  target.collectionTrackUrls = new Set(snapshot?.collectionTrackUrls || []);
}

export function mergeSerializedBoughtLikeInventory(
  target: LikeInventorySets,
  snapshot: SerializedBoughtLikeInventory | null | undefined
): void {
  (snapshot?.collectionAlbumIds || []).forEach((itemId) => {
    const normalized = normalizeLikeId(itemId);
    if (normalized) {
      target.collectionAlbumIds.add(normalized);
    }
  });
  (snapshot?.collectionTrackIds || []).forEach((itemId) => {
    const normalized = normalizeLikeId(itemId);
    if (normalized) {
      target.collectionTrackIds.add(normalized);
    }
  });
  (snapshot?.collectionAlbumUrls || []).forEach((rawUrl) => {
    const canonical = toCanonicalLikeUrl(rawUrl);
    if (canonical) {
      target.collectionAlbumUrls.add(canonical);
    }
  });
  (snapshot?.collectionTrackUrls || []).forEach((rawUrl) => {
    const canonical = toCanonicalLikeUrl(rawUrl);
    if (canonical) {
      target.collectionTrackUrls.add(canonical);
    }
  });
}
