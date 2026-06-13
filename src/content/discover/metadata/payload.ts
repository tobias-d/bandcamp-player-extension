import { getLatestObservedDiscoverPayload } from '@/content/discover/origin-bridge';
import {
  normalizeReleaseUrl,
  normalizeText,
  normalizeUrl,
  readTrackIdFromUrl,
  toId,
  toType
} from '@/content/discover/metadata/normalize';
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

function scorePayloadItem(
  item: PayloadMatch,
  hints: { title: string; artist: string; album: string; releaseUrl: string; trackId: string }
): number {
  let score = 0;
  const hintTitle = hints.title.toLowerCase();
  const hintArtist = hints.artist.toLowerCase();
  const hintAlbum = hints.album.toLowerCase();
  const releaseUrl = hints.releaseUrl;
  const trackId = hints.trackId;

  if (releaseUrl && item.releaseUrl && releaseUrl === item.releaseUrl) {
    score += 120;
  }
  if (trackId && item.trackId && trackId === item.trackId) {
    score += 180;
  }

  if (hintTitle && item.trackTitle) {
    const title = item.trackTitle.toLowerCase();
    if (title === hintTitle) {
      score += 35;
    } else if (title.includes(hintTitle) || hintTitle.includes(title)) {
      score += 18;
    }
  }
  if (hintArtist && item.artistName) {
    const artist = item.artistName.toLowerCase();
    if (artist === hintArtist) {
      score += 24;
    } else if (artist.includes(hintArtist) || hintArtist.includes(artist)) {
      score += 12;
    }
  }
  if (hintAlbum && item.albumTitle) {
    const album = item.albumTitle.toLowerCase();
    if (album === hintAlbum) {
      score += 14;
    } else if (album.includes(hintAlbum) || hintAlbum.includes(album)) {
      score += 7;
    }
  }

  if (!hints.title && !hints.artist && !hints.album && item.streamUrl) {
    score += 2;
  }

  return score;
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
    const streamUrl = normalizeUrl(featured['stream_url'] ?? featured['streamUrl']);
    const trackId = toId(item['track_id']) || toId(featured['track_id']) || readTrackIdFromUrl(streamUrl);

    const bandId = toId(item['band_id']) || toId(item['bandId']) || toId(item['selling_band_id']) || toId(featured['band_id']);
    const tralbumId = toId(item['tralbum_id']) || toId(item['tralbumId']) || toId(item['item_id']) || toId(item['id']) || trackId;
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

export function pickPayloadMatch(hints: {
  title: string;
  artist: string;
  album: string;
  releaseUrl: string;
  trackId: string;
}): PayloadMatch | null {
  const candidates = readPayloadMatches();
  if (!candidates.length) {
    return null;
  }

  let best: PayloadMatch | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scorePayloadItem(candidate, hints);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (!best) {
    return null;
  }
  if (hints.title || hints.artist || hints.album || hints.releaseUrl || hints.trackId) {
    return bestScore > 0 ? best : null;
  }
  return best;
}
