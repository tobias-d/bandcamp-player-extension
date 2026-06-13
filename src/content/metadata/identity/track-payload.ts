import {
  asRecord,
  firstNonEmpty,
  normalizeReleaseUrl,
  toIdString,
  toTralbumType
} from '@/content/metadata/common';
import { getReleaseUrlFromRecord, resolveBandIdFromHintsForTralbum, type ReleaseIdentity } from '@/content/metadata/release';
import { releaseKey } from '@/content/metadata/identity/release-candidates';

export function collectTrackLinkedIdentitiesFromPayload(
  payload: unknown,
  targetTrackId: string,
  targetReleaseUrl = ''
): ReleaseIdentity[] {
  const normalizedTargetRelease = normalizeReleaseUrl(targetReleaseUrl);
  if (!payload || typeof payload !== 'object' || (!targetTrackId && !normalizedTargetRelease)) {
    return [];
  }

  const output: ReleaseIdentity[] = [];
  const seen = new Set<string>();
  const queue: Array<{
    node: unknown;
    depth: number;
    bandId: string;
    tralbumId: string;
    tralbumType: 'a' | 't' | '';
    trackId: string;
    releaseUrl: string;
  }> = [{ node: payload, depth: 0, bandId: '', tralbumId: '', tralbumType: '', trackId: '', releaseUrl: '' }];
  const visited = new Set<unknown>();
  const maxDepth = 10;
  const maxNodes = 12000;
  let scanned = 0;

  const maybeAdd = (bandIdRaw: string, tralbumIdRaw: string, tralbumTypeRaw: 'a' | 't' | ''): void => {
    const tralbumId = toIdString(tralbumIdRaw);
    if (!tralbumId) {
      return;
    }
    const bandId = firstNonEmpty(toIdString(bandIdRaw), resolveBandIdFromHintsForTralbum(tralbumId, targetReleaseUrl));
    if (!bandId) {
      return;
    }
    const typeCandidates: Array<'a' | 't'> = tralbumTypeRaw ? [tralbumTypeRaw] : ['t', 'a'];
    typeCandidates.forEach((tralbumType) => {
      const identity: ReleaseIdentity = { bandId, tralbumId, tralbumType };
      const key = releaseKey(identity);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      output.push(identity);
    });
  };

  const targetWantsAlbum = normalizedTargetRelease.includes('/album/');
  const targetWantsTrack = normalizedTargetRelease.includes('/track/');

  while (queue.length > 0 && scanned < maxNodes) {
    const item = queue.shift();
    if (!item || !item.node || typeof item.node !== 'object' || visited.has(item.node)) {
      continue;
    }
    visited.add(item.node);
    scanned += 1;

    const record = asRecord(item.node);
    if (!record) {
      continue;
    }

    const tralbumType =
      toTralbumType(
        firstNonEmpty(
          String(record['tralbum_type'] ?? ''),
          String(record['tralbumType'] ?? ''),
          String(record['item_type'] ?? ''),
          String(record['itemType'] ?? '')
        )
      ) || item.tralbumType;

    const bandId = firstNonEmpty(
      toIdString(record['band_id']),
      toIdString(record['bandId']),
      toIdString(record['selling_band_id']),
      toIdString(record['sellingBandId']),
      item.bandId
    );

    const tralbumId = firstNonEmpty(
      toIdString(record['tralbum_id']),
      toIdString(record['tralbumId']),
      toIdString(record['item_id']),
      toIdString(record['itemId']),
      toIdString(record['itemid']),
      toIdString(record['release_id']),
      toIdString(record['releaseId']),
      toIdString(record['id']),
      item.tralbumId
    );
    const albumId = firstNonEmpty(
      toIdString(record['album_id']),
      toIdString(record['albumId']),
      toIdString(record['parent_album_id']),
      toIdString(record['parentAlbumId'])
    );

    const trackId = firstNonEmpty(
      toIdString(record['track_id']),
      toIdString(record['trackId']),
      toIdString(record['trackid']),
      tralbumType === 't' ? toIdString(record['item_id']) : '',
      tralbumType === 't' ? toIdString(record['itemId']) : '',
      tralbumType === 't' ? toIdString(record['id']) : '',
      item.trackId
    );
    const releaseUrl = firstNonEmpty(getReleaseUrlFromRecord(record), item.releaseUrl);
    const normalizedReleaseUrl = normalizeReleaseUrl(releaseUrl);

    const matchesTrack = Boolean(targetTrackId && trackId && trackId === targetTrackId);
    const matchesRelease = Boolean(
      normalizedTargetRelease &&
      normalizedReleaseUrl &&
      normalizedReleaseUrl === normalizedTargetRelease
    );

    if (matchesTrack || matchesRelease) {
      if (albumId && albumId !== tralbumId && (matchesTrack || targetWantsAlbum)) {
        maybeAdd(bandId, albumId, 'a');
      }
      maybeAdd(bandId, tralbumId, tralbumType);
      if (albumId && albumId !== tralbumId && targetWantsTrack && tralbumType !== 't') {
        maybeAdd(bandId, tralbumId, 't');
      }
    }

    if (item.depth >= maxDepth) {
      continue;
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push({
          node: value,
          depth: item.depth + 1,
          bandId,
          tralbumId,
          tralbumType,
          trackId,
          releaseUrl
        });
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (
          trimmed.length > 2 &&
          trimmed.length < 200000 &&
          (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
          (trimmed.includes('track_id') || trimmed.includes('tralbum_id') || trimmed.includes('band_id'))
        ) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object') {
              queue.push({
                node: parsed,
                depth: item.depth + 1,
                bandId,
                tralbumId,
                tralbumType,
                trackId,
                releaseUrl
              });
            }
          } catch {
            // Ignore non-json strings.
          }
        }
      }
    });
  }

  return output;
}
