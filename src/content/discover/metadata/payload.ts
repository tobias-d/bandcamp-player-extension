import { getLatestObservedDiscoverPayload } from '@/content/discover/origin-bridge';
import {
  normalizeFullUrl,
  normalizeReleaseUrl,
  normalizeText,
  toId,
  toType
} from '@/content/discover/metadata/normalize';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import type { DiscoverIdentity, MediaSessionState, PayloadMatch } from '@/content/discover/metadata/types';

function readDiscoverResults(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const direct = (payload as { results?: unknown[] }).results;
  if (Array.isArray(direct)) {
    return direct;
  }
  const nested = (payload as { discovery?: { results?: unknown[] } }).discovery?.results;
  return Array.isArray(nested) ? nested : [];
}

export function readMediaSessionState(): MediaSessionState {
  try {
    const media = navigator.mediaSession;
    const metadata = media?.metadata;
    return {
      title: normalizeText(metadata?.title),
      artist: normalizeText(String(metadata?.artist ?? '').replace(/^by\s+/i, '')),
      album: normalizeText(metadata?.album),
      isPlaying: String(media?.playbackState ?? '').toLowerCase() === 'playing'
    };
  } catch {
    return {
      title: '',
      artist: '',
      album: '',
      isPlaying: false
    };
  }
}

export function readPayloadMatches(): PayloadMatch[] {
  const payload = getLatestObservedDiscoverPayload();
  const results = readDiscoverResults(payload);
  if (!results.length) {
    return [];
  }

  const output: PayloadMatch[] = [];
  const seen = new Set<string>();
  results.forEach((itemRaw) => {
    if (!itemRaw || typeof itemRaw !== 'object') {
      return;
    }
    const item = itemRaw as Record<string, unknown>;
    const featured = (item['featured_track'] ?? {}) as Record<string, unknown>;

    const trackTitle = normalizeText(item['title']);
    const artistName = normalizeText(item['artist'] ?? item['album_artist'] ?? featured['band_name'] ?? item['band_name']);
    const albumTitle = normalizeText(item['album_title'] ?? item['albumTitle'] ?? item['release_title']);
    const releaseUrl = normalizeReleaseUrl(
      item['item_url'] ?? item['itemUrl'] ?? item['tralbum_url'] ?? item['tralbumUrl'] ?? item['url'] ?? item['link']
    );
    const streamUrl = normalizeFullUrl(featured['stream_url'] ?? featured['streamUrl']);
    const trackId = toId(item['track_id']) || toId(featured['track_id']) || readTrackIdFromUrl(streamUrl);

    const bandId = toId(item['band_id']) || toId(item['bandId']) || toId(item['selling_band_id']) || toId(featured['band_id']);
    // No `|| trackId` fallback: a track id is not a release id. If the item has no
    // real tralbum/album id, leave it empty so the identity below resolves to null
    // rather than locking a track id in as if it were the release.
    const tralbumId = toId(item['tralbum_id']) || toId(item['tralbumId']) || toId(item['item_id']) || toId(item['id']);
    const tralbumType = toType(item['tralbum_type'] ?? item['tralbumType'] ?? item['item_type']) || (releaseUrl.includes('/track/') ? 't' : 'a');
    const identity: DiscoverIdentity | null =
      bandId && tralbumId
        ? {
            bandId,
            tralbumId,
            tralbumType: tralbumType || 'a',
            trackId,
            url: releaseUrl
          }
        : null;

    if (!trackTitle && !artistName && !streamUrl && !releaseUrl) {
      return;
    }

    const key = [trackTitle, artistName, albumTitle, releaseUrl, streamUrl, trackId, bandId, tralbumId, tralbumType].join('|');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push({
      trackTitle,
      artistName,
      albumTitle,
      releaseUrl,
      streamUrl,
      trackId,
      identity
    });
  });

  return output;
}
