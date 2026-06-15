import type {
  FanEndpoint,
  LikeIdentity,
  LikeProcessEvent,
  LikeState,
  PageGlobals,
  PlaylistTrack
} from '@/shared/types';
import { sendMessage } from '@/utils/messaging';
import {
  normalizeLikeId,
  toCanonicalLikeUrl,
  type LikeIdentityInput,
  type LikeInventorySets
} from '@/content/likes/state';

const RETRY_BASE_MS = 700;
// Must exceed the background fan-items fetch timeout so content doesn't give up
// before the background request has a chance to return.
const MESSAGE_TIMEOUT_MS = 6_000;
const MAX_LIKES_PROCESS_EVENTS = 120;

export interface EndpointSnapshot {
  albumIds: Set<string>;
  trackIds: Set<string>;
  albumUrls: Set<string>;
  trackUrls: Set<string>;
  albumIdByUrl: Map<string, string>;
}

export interface EndpointSyncResult {
  ok: boolean;
  endpoint: FanEndpoint;
  attempts: number;
  pages: number;
  nextToken: string;
  snapshot: EndpointSnapshot;
  status: string;
  error: string;
  retryAfterMs: number;
}

export function createEmptyEndpointSnapshot(): EndpointSnapshot {
  return {
    albumIds: new Set<string>(),
    trackIds: new Set<string>(),
    albumUrls: new Set<string>(),
    trackUrls: new Set<string>(),
    albumIdByUrl: new Map<string, string>()
  };
}

function inferItemType(raw: Record<string, unknown>): 'album' | 'track' | '' {
  const direct = String(raw.item_type ?? raw.tralbum_type ?? raw.type ?? '').trim().toLowerCase();
  if (direct === 'album' || direct === 'a') {
    return 'album';
  }
  if (direct === 'track' || direct === 't') {
    return 'track';
  }

  const trackHint = normalizeLikeId(raw.track_id ?? raw.trackId ?? '');
  if (trackHint) {
    return 'track';
  }
  const albumHint = normalizeLikeId(raw.album_id ?? raw.albumId ?? raw.parent_album_id ?? raw.parentAlbumId ?? '');
  if (albumHint) {
    return 'album';
  }

  const urlCandidates = [
    raw.item_url,
    raw.tralbum_url,
    raw.url,
    raw.item_href,
    raw.item_link,
    raw.release_url,
    raw.track_url,
    raw.album_url
  ];
  for (const candidate of urlCandidates) {
    const url = toCanonicalLikeUrl(String(candidate ?? ''));
    if (url.includes('/album/')) {
      return 'album';
    }
    if (url.includes('/track/')) {
      return 'track';
    }
  }

  return '';
}

function collectItemUrls(raw: Record<string, unknown>, itemType: 'album' | 'track'): string[] {
  const urls = new Set<string>();
  const candidates = [
    raw.item_url,
    raw.tralbum_url,
    raw.url,
    raw.item_href,
    raw.item_link,
    raw.release_url,
    raw.track_url,
    raw.album_url
  ];
  for (const candidate of candidates) {
    const canonical = toCanonicalLikeUrl(String(candidate ?? ''));
    if (!canonical) {
      continue;
    }
    if (itemType === 'album' && canonical.includes('/album/')) {
      urls.add(canonical);
    }
    if (itemType === 'track' && canonical.includes('/track/')) {
      urls.add(canonical);
    }
  }
  return Array.from(urls);
}

function applyItemToSnapshot(rawValue: unknown, snapshot: EndpointSnapshot): void {
  if (!rawValue || typeof rawValue !== 'object') {
    return;
  }
  const raw = rawValue as Record<string, unknown>;
  const itemType = inferItemType(raw);
  if (!itemType) {
    return;
  }

  const itemId = normalizeLikeId(
    raw.item_id ??
      raw.tralbum_id ??
      raw.id ??
      raw.track_id ??
      raw.album_id ??
      (raw.item && typeof raw.item === 'object' ? (raw.item as Record<string, unknown>).item_id : '')
  );
  if (itemType === 'album' && itemId) {
    snapshot.albumIds.add(itemId);
  } else if (itemType === 'track' && itemId) {
    snapshot.trackIds.add(itemId);
  }

  const urls = collectItemUrls(raw, itemType);
  urls.forEach((url) => {
    if (itemType === 'album') {
      snapshot.albumUrls.add(url);
      if (itemId && !snapshot.albumIdByUrl.has(url)) {
        snapshot.albumIdByUrl.set(url, itemId);
      }
    } else {
      snapshot.trackUrls.add(url);
    }
  });
}

export function applyPayloadToSnapshot(payload: unknown, snapshot: EndpointSnapshot): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const record = payload as Record<string, unknown>;

  const items = Array.isArray(record.items) ? record.items : [];
  items.forEach((item) => applyItemToSnapshot(item, snapshot));

  const itemLookup =
    record.item_lookup && typeof record.item_lookup === 'object'
      ? (record.item_lookup as Record<string, unknown>)
      : null;
  if (itemLookup) {
    Object.values(itemLookup).forEach((value) => applyItemToSnapshot(value, snapshot));
  }
}

export function replaceEndpointData(
  endpoint: FanEndpoint,
  snapshot: EndpointSnapshot,
  target: LikeInventorySets
): void {
  if (endpoint === 'wishlist_items') {
    target.wishlistAlbumIds = new Set(snapshot.albumIds);
    target.wishlistTrackIds = new Set(snapshot.trackIds);
    target.wishlistAlbumUrls = new Set(snapshot.albumUrls);
    target.wishlistTrackUrls = new Set(snapshot.trackUrls);
    return;
  }
  target.collectionAlbumIds = new Set(snapshot.albumIds);
  target.collectionTrackIds = new Set(snapshot.trackIds);
  target.collectionAlbumUrls = new Set(snapshot.albumUrls);
  target.collectionTrackUrls = new Set(snapshot.trackUrls);
}

export function clearInventorySets(target: LikeInventorySets): void {
  target.wishlistAlbumIds = new Set<string>();
  target.wishlistTrackIds = new Set<string>();
  target.wishlistAlbumUrls = new Set<string>();
  target.wishlistTrackUrls = new Set<string>();
  target.collectionAlbumIds = new Set<string>();
  target.collectionTrackIds = new Set<string>();
  target.collectionAlbumUrls = new Set<string>();
  target.collectionTrackUrls = new Set<string>();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, Math.max(0, ms));
  });
}

function likeStateRank(state: LikeState): number {
  if (state === 'bought') {
    return 2;
  }
  if (state === 'liked') {
    return 1;
  }
  if (state === 'disliked') {
    return 0;
  }
  if (state === 'unknown') {
    return -1;
  }
  return 0;
}

export function maxLikeState(a: LikeState, b: LikeState): LikeState {
  return likeStateRank(a) >= likeStateRank(b) ? a : b;
}

type AlbumDerivedTrackDisplayState = {
  albumState: LikeState;
  trackStates: Record<number, LikeState>;
};

export function applyAlbumDerivedTrackDisplay<T extends AlbumDerivedTrackDisplayState>(
  likeState: T,
  trackCount: number,
  hasStrictAlbumIdentity: boolean
): T {
  if (!hasStrictAlbumIdentity) {
    return likeState;
  }
  if (likeState.albumState !== 'liked' && likeState.albumState !== 'bought') {
    return likeState;
  }

  const inheritedState = likeState.albumState;
  const inheritedTrackStates: Record<number, LikeState> = {};
  for (let index = 0; index < trackCount; index += 1) {
    const current = likeState.trackStates[index] || 'unknown';
    if (inheritedState === 'bought') {
      inheritedTrackStates[index] = 'bought';
    } else {
      inheritedTrackStates[index] = current === 'bought' ? 'bought' : 'liked';
    }
  }

  return {
    ...likeState,
    trackStates: inheritedTrackStates
  } as T;
}

export function endpointStatusIsComplete(status: string): boolean {
  return /^ok:pages=\d+:complete$/.test(String(status || ''));
}

export function mergeLikeProcessEvents(
  syncEvents: LikeProcessEvent[],
  existingEvents: LikeProcessEvent[]
): LikeProcessEvent[] {
  const merged = [...syncEvents, ...existingEvents];
  if (!merged.length) {
    return [];
  }

  merged.sort((a, b) => {
    const aTs = Number.isFinite(a.ts) ? Number(a.ts) : 0;
    const bTs = Number.isFinite(b.ts) ? Number(b.ts) : 0;
    if (aTs !== bTs) {
      return aTs - bTs;
    }
    return String(a.stage || '').localeCompare(String(b.stage || ''));
  });

  const deduped: LikeProcessEvent[] = [];
  const seen = new Set<string>();
  merged.forEach((event) => {
    const ts = Number.isFinite(event.ts) ? Number(event.ts) : Date.now();
    const stage = String(event.stage || '-');
    const detail = String(event.detail || '-');
    const key = `${ts}|${stage}|${detail}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push({ ts, stage, detail });
  });

  if (deduped.length <= MAX_LIKES_PROCESS_EVENTS) {
    return deduped;
  }
  return deduped.slice(deduped.length - MAX_LIKES_PROCESS_EVENTS);
}

export function trackLikeSessionKey(track: PlaylistTrack): string {
  const directTrackId = normalizeLikeId(track.trackId ?? '');
  if (directTrackId) {
    return `id:${directTrackId}`;
  }
  return '';
}

export function albumLikeSessionKey(album: LikeIdentityInput | null): string {
  if (!album) {
    return '';
  }
  const itemId = normalizeLikeId(album.itemId || '');
  if (itemId) {
    return `album-id:${itemId}`;
  }
  return '';
}

export function albumLikeSessionUrlKey(rawUrl: string): string {
  const canonicalUrl = toCanonicalLikeUrl(rawUrl);
  if (!canonicalUrl) {
    return '';
  }
  return `album-url:${canonicalUrl}`;
}

export async function sendMessageWithTimeout<T>(message: Parameters<typeof sendMessage>[0], timeoutMs = MESSAGE_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error('likes-message-timeout'));
    }, Math.max(1, timeoutMs));

    sendMessage<T>(message)
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

export function toBackoffMs(attempt: number, retryAfterMs = 0): number {
  if (retryAfterMs > 0) {
    return retryAfterMs;
  }
  // Deterministic backoff (no random jitter): retry/pacing must be reproducible,
  // and the defer-vs-sleep decision in syncEndpoint compares this against the
  // remaining budget. A single client has no thundering herd to jitter against.
  const exp = Math.max(1, attempt);
  return Math.min(5000, RETRY_BASE_MS * exp);
}

export function buildSyntheticStartToken(endpoint: FanEndpoint): string {
  const futureSec = Math.floor(Date.now() / 1000) + 3_600;
  const type = endpoint === 'wishlist_items' ? 't' : 'a';
  return `${futureSec}:2147483647:${type}::`;
}

export function resolveReleaseLikeIdentityFromGlobals(
  globals: PageGlobals | null,
  pageUrlHint = ''
): LikeIdentity | null {
  const tralbum = globals?.tralbum && typeof globals.tralbum === 'object'
    ? (globals.tralbum as Record<string, unknown>)
    : null;
  const page = globals?.page && typeof globals.page === 'object'
    ? (globals.page as Record<string, unknown>)
    : null;

  const idCandidates = [
    tralbum?.id,
    tralbum?.tralbum_id,
    tralbum?.item_id,
    tralbum?.current_id,
    page?.tralbum_id,
    page?.item_id,
    page?.collect_item_id
  ];
  let itemId = '';
  for (const candidate of idCandidates) {
    const normalized = normalizeLikeId(candidate);
    if (normalized) {
      itemId = normalized;
      break;
    }
  }

  const typeRaw = String(
    tralbum?.item_type ??
      tralbum?.tralbum_type ??
      page?.item_type ??
      page?.collect_item_type ??
      ''
  )
    .trim()
    .toLowerCase();
  const itemType =
    typeRaw === 'track' || typeRaw === 't'
      ? 'track'
      : typeRaw === 'album' || typeRaw === 'a'
        ? 'album'
        : '';

  if (!itemId || !itemType) {
    return null;
  }

  return {
    itemId,
    itemType,
    pageUrl: toCanonicalLikeUrl(pageUrlHint || window.location.href)
  };
}
