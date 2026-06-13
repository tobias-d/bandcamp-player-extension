import {
  asRecord,
  collectStringByKey,
  firstNonEmpty,
  getNestedUnknown,
  normalizeReleaseUrl,
  toIdString,
  toTralbumType
} from '@/content/metadata/common';
import { releaseKey } from '@/content/metadata/identity';
import { cacheAlbumIdentityForReleaseUrl } from '@/content/metadata/extractor/probe-state';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';
import type { TralbumLike } from '@/content/metadata/extractor/types';
import type { ReleaseIdentity } from '@/content/metadata/release';

export function extractParentAlbumIdentityFromTralbum(
  tralbum: TralbumLike,
  baseIdentity: ReleaseIdentity | null
): ReleaseIdentity | null {
  const root = asRecord(tralbum as unknown);
  if (!root) {
    return null;
  }

  const tracks = getTrackList(tralbum);
  const trackRecords = tracks.map((track) => asRecord(track as unknown)).filter((value): value is Record<string, unknown> => Boolean(value));
  const trackBandId = firstNonEmpty(
    ...trackRecords
      .map((record) =>
        firstNonEmpty(
          toIdString(record['band_id']),
          toIdString(record['bandId']),
          toIdString(record['selling_band_id']),
          toIdString(record['sellingBandId'])
        )
      )
      .filter(Boolean)
  );
  const trackAlbumId = firstNonEmpty(
    ...trackRecords
      .map((record) =>
        firstNonEmpty(
          toIdString(record['album_id']),
          toIdString(record['albumId']),
          toIdString(record['parent_album_id']),
          toIdString(record['parentAlbumId']),
          toIdString(record['album_item_id']),
          toIdString(record['albumItemId'])
        )
      )
      .filter(Boolean)
  );

  const bandId = firstNonEmpty(
    baseIdentity?.bandId ?? '',
    toIdString(root['band_id']),
    toIdString(root['selling_band_id']),
    toIdString(root['bandId']),
    toIdString(root['sellingBandId']),
    trackBandId,
    ...collectStringByKey(root, ['band_id', 'bandId', 'selling_band_id', 'sellingBandId'], 6).map(toIdString)
  );

  const albumId = firstNonEmpty(
    toIdString(root['album_id']),
    toIdString(root['albumId']),
    toIdString(root['parent_album_id']),
    toIdString(root['parentAlbumId']),
    trackAlbumId,
    ...collectStringByKey(root, ['album_id', 'albumId', 'parent_album_id', 'parentAlbumId'], 6).map(toIdString)
  );

  if (!bandId || !albumId) {
    return null;
  }

  const parent: ReleaseIdentity = {
    bandId,
    tralbumId: albumId,
    tralbumType: 'a'
  };

  if (baseIdentity && releaseKey(parent) === releaseKey(baseIdentity)) {
    return null;
  }

  return parent;
}

// Reads the album identity of an album payload itself (not a track's parent
// pointer). Bandcamp track payloads carry `album_id` up to their parent, but an
// album payload's own id lives in `current.id` / `id` / `item_id`, so the parent
// extractor above returns null for it. A URL-fetched album (html-preferred, no
// numeric id known) only ever exists as this kind of payload, so without this the
// album never gets a numeric identity and album like-state cannot resolve.
export function extractOwnAlbumIdentityFromTralbum(tralbum: TralbumLike): ReleaseIdentity | null {
  const root = asRecord(tralbum as unknown);
  if (!root) {
    return null;
  }
  const current = asRecord(root['current']);
  const type =
    toTralbumType(getNestedUnknown(root, 'item_type')) ||
    toTralbumType(getNestedUnknown(current, 'type')) ||
    toTralbumType(getNestedUnknown(root, 'tralbum_type'));
  // Only treat the payload as an album when it says so, or when it lists more
  // than one track. A single-track payload is a track, not its own album.
  const isAlbum = type === 'a' || (type === '' && getTrackList(tralbum).length > 1);
  if (!isAlbum) {
    return null;
  }
  const bandId = firstNonEmpty(
    toIdString(getNestedUnknown(current, 'band_id')),
    toIdString(root['band_id']),
    toIdString(root['selling_band_id']),
    toIdString(root['bandId'])
  );
  const albumId = firstNonEmpty(
    toIdString(getNestedUnknown(current, 'id')),
    toIdString(root['id']),
    toIdString(root['item_id']),
    toIdString(root['tralbum_id'])
  );
  if (!bandId || !albumId) {
    return null;
  }
  return { bandId, tralbumId: albumId, tralbumType: 'a' };
}

// Resolves the album identity for a tralbum payload by its shape: an album
// payload yields its own id, a track payload yields its parent album id.
export function extractAlbumIdentityFromTralbum(
  tralbum: TralbumLike,
  baseIdentity: ReleaseIdentity | null
): ReleaseIdentity | null {
  const own = extractOwnAlbumIdentityFromTralbum(tralbum);
  if (own) {
    return own;
  }
  return extractParentAlbumIdentityFromTralbum(tralbum, baseIdentity);
}

export function maybeCacheAlbumIdentityForLinkedRelease(
  linkedReleaseUrl: string,
  tralbum: TralbumLike,
  baseIdentity: ReleaseIdentity | null
): void {
  const normalized = normalizeReleaseUrl(linkedReleaseUrl);
  if (!normalized || !normalized.includes('/album/')) {
    return;
  }
  const albumIdentity = extractAlbumIdentityFromTralbum(tralbum, baseIdentity);
  if (albumIdentity) {
    cacheAlbumIdentityForReleaseUrl(normalized, albumIdentity);
    return;
  }
  const tracks = getTrackList(tralbum);
  if (tracks.length <= 1) {
    return;
  }
  if (baseIdentity?.tralbumType === 'a') {
    cacheAlbumIdentityForReleaseUrl(normalized, baseIdentity);
  }
}
