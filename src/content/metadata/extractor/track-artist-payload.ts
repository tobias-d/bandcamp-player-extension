import {
  asRecord,
  firstNonEmpty,
  getNestedString,
  toIdString,
  toTralbumType
} from '@/content/metadata/common';
import {
  parseArtistPrefix,
  sanitizeTrackLevelArtist
} from '@/content/metadata/extractor/artist-helpers';

export function collectTrackArtistHintFromPayload(
  payload: unknown,
  targetTrackId: string,
  sourcePrefix = 'fanPayload'
): { artist: string; source: string } | null {
  if (!payload || typeof payload !== 'object' || !targetTrackId) {
    return null;
  }

  const queue: Array<{
    node: unknown;
    depth: number;
    trackId: string;
    tralbumId: string;
  }> = [{ node: payload, depth: 0, trackId: '', tralbumId: '' }];
  const visited = new Set<unknown>();
  const maxDepth = 10;
  const maxNodes = 12000;
  let scanned = 0;

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

    const tralbumType = toTralbumType(
      firstNonEmpty(
        String(record['tralbum_type'] ?? ''),
        String(record['tralbumType'] ?? ''),
        String(record['item_type'] ?? ''),
        String(record['itemType'] ?? '')
      )
    );

    const tralbumId = firstNonEmpty(
      toIdString(record['tralbum_id']),
      toIdString(record['tralbumId']),
      toIdString(record['item_id']),
      toIdString(record['itemId']),
      toIdString(record['itemid']),
      toIdString(record['album_id']),
      toIdString(record['albumId']),
      toIdString(record['release_id']),
      toIdString(record['releaseId']),
      toIdString(record['id']),
      item.tralbumId
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

    if (trackId && trackId === targetTrackId) {
      const direct = sanitizeTrackLevelArtist(
        firstNonEmpty(
          String(record['artist'] ?? '').trim(),
          String(record['artist_name'] ?? '').trim(),
          String(record['artistName'] ?? '').trim(),
          String(record['track_artist'] ?? '').trim(),
          String(record['trackArtist'] ?? '').trim(),
          String(record['display_artist'] ?? '').trim(),
          String(record['displayArtist'] ?? '').trim(),
          String(record['item_artist'] ?? '').trim(),
          String(record['itemArtist'] ?? '').trim(),
          getNestedString(record, 'artist', 'name'),
          getNestedString(record, 'artist', 'artist_name'),
          getNestedString(record, 'artist', 'display_name'),
          String(record['performer'] ?? '').trim(),
          String(record['creator'] ?? '').trim(),
          String(record['band_name'] ?? '').trim()
        )
      );
      if (direct) {
        return {
          artist: direct,
          source: `${sourcePrefix}.artist`
        };
      }

      const title = firstNonEmpty(
        String(record['title'] ?? '').trim(),
        String(record['track_title'] ?? '').trim(),
        String(record['trackTitle'] ?? '').trim(),
        String(record['track_name'] ?? '').trim(),
        String(record['trackName'] ?? '').trim()
      );

      const compositeCandidates = [
        String(record['title_with_artist'] ?? '').trim(),
        String(record['titleWithArtist'] ?? '').trim(),
        String(record['full_title'] ?? '').trim(),
        String(record['fullTitle'] ?? '').trim(),
        String(record['display_title'] ?? '').trim(),
        String(record['displayTitle'] ?? '').trim(),
        String(record['item_title'] ?? '').trim(),
        String(record['itemTitle'] ?? '').trim()
      ].filter(Boolean);

      for (const candidate of compositeCandidates) {
        const parsed = sanitizeTrackLevelArtist(parseArtistPrefix(candidate, title));
        if (parsed) {
          return {
            artist: parsed,
            source: `${sourcePrefix}.title_with_artist`
          };
        }
      }
    }

    if (item.depth >= maxDepth) {
      continue;
    }

    Object.entries(record).forEach(([key, value]) => {
      const keyTrackId = toIdString(key);
      const inheritedTrackId = firstNonEmpty(item.trackId, keyTrackId);
      if (value && typeof value === 'object') {
        queue.push({
          node: value,
          depth: item.depth + 1,
          trackId: inheritedTrackId,
          tralbumId
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
                trackId: inheritedTrackId,
                tralbumId
              });
            }
          } catch {
            // ignore non-json strings
          }
        }
      }
    });
  }

  return null;
}
