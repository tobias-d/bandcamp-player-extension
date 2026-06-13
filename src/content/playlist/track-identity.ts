import { readTrackIdFromUrl, resolveStreamContentId } from '@/content/playlist/resolver';

type SourceTrackLike = {
  trackId?: string;
  streamUrl?: string;
};

type CacheKeyTrackLike = SourceTrackLike & {
  cacheKey?: string;
  pageUrl?: string;
  index?: number;
};

interface SourceMatchingOptions {
  normalizeUrlForCompare?: (value: string) => string;
}

interface TrackCacheKeyOptions {
  includePageUrl?: boolean;
  normalizeUrlForCache?: (value: string) => string;
}

function normalizeForCompare(value: string, normalizeUrlForCompare?: (value: string) => string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }
  if (!normalizeUrlForCompare) {
    return trimmed;
  }
  return String(normalizeUrlForCompare(trimmed) || '').trim();
}

export function normalizeCacheKey(value: string | undefined | null): string {
  return String(value || '').trim();
}

export function findPlaylistTrackIndexBySource<T extends SourceTrackLike>(
  tracks: T[],
  sourceUrl: string,
  options: SourceMatchingOptions = {}
): number {
  const src = String(sourceUrl || '').trim();
  if (!src || !tracks.length) {
    return -1;
  }

  const sourceTrackId = readTrackIdFromUrl(src);
  if (sourceTrackId) {
    const byTrackId = tracks.findIndex((track) => String(track.trackId || '').trim() === sourceTrackId);
    if (byTrackId >= 0) {
      return byTrackId;
    }
  }

  const sourceContentId = resolveStreamContentId(src);
  if (sourceContentId) {
    const byContentId = tracks.findIndex((track) => {
      const streamContentId = resolveStreamContentId(String(track.streamUrl || '').trim());
      return Boolean(streamContentId) && streamContentId === sourceContentId;
    });
    if (byContentId >= 0) {
      return byContentId;
    }
  }

  const normalizedSource = normalizeForCompare(src, options.normalizeUrlForCompare);
  return tracks.findIndex((track) => {
    const candidate = normalizeForCompare(String(track.streamUrl || '').trim(), options.normalizeUrlForCompare);
    return candidate === normalizedSource;
  });
}

export function playlistContainsSourceTrack<T extends SourceTrackLike>(
  tracks: T[],
  sourceUrl: string,
  options: SourceMatchingOptions = {}
): boolean {
  return findPlaylistTrackIndexBySource(tracks, sourceUrl, options) >= 0;
}

export function sourcesShareTrackIdentity(firstSourceUrl: string, secondSourceUrl: string): boolean {
  const first = String(firstSourceUrl || '').trim();
  const second = String(secondSourceUrl || '').trim();
  if (!first || !second) {
    return false;
  }
  if (first === second) {
    return true;
  }

  const firstTrackId = readTrackIdFromUrl(first);
  const secondTrackId = readTrackIdFromUrl(second);
  if (firstTrackId && secondTrackId) {
    return firstTrackId === secondTrackId;
  }

  const firstContentId = resolveStreamContentId(first);
  const secondContentId = resolveStreamContentId(second);
  if (firstContentId && secondContentId) {
    return firstContentId === secondContentId;
  }

  return false;
}

export function buildTrackCacheKey<T extends CacheKeyTrackLike>(
  track: T,
  streamUrl: string,
  options: TrackCacheKeyOptions = {}
): string | undefined {
  const explicit = normalizeCacheKey(track.cacheKey);
  if (explicit) {
    return explicit;
  }

  const trackId = normalizeCacheKey(track.trackId);
  if (trackId) {
    return trackId;
  }

  const normalizedStream = normalizeForCompare(String(streamUrl || '').trim(), options.normalizeUrlForCache);
  if (normalizedStream) {
    return normalizedStream;
  }

  if (options.includePageUrl) {
    const pageUrl = normalizeCacheKey(track.pageUrl);
    if (pageUrl) {
      return pageUrl;
    }
  }

  return Number.isInteger(track.index) ? String(track.index) : undefined;
}

export function resolveSourceTrackCacheKey<T extends CacheKeyTrackLike>(
  tracks: T[],
  sourceUrl: string,
  options: SourceMatchingOptions & TrackCacheKeyOptions = {}
): string {
  const src = String(sourceUrl || '').trim();
  if (!src) {
    return '';
  }

  const sourceIndex = findPlaylistTrackIndexBySource(tracks, src, options);
  if (sourceIndex >= 0) {
    const matchedTrack = tracks[sourceIndex];
    if (matchedTrack) {
      const matchedStreamUrl = String(matchedTrack.streamUrl || src).trim();
      return normalizeCacheKey(buildTrackCacheKey(matchedTrack, matchedStreamUrl, options));
    }
  }

  const trackId = readTrackIdFromUrl(src);
  if (trackId) {
    return trackId;
  }

  return normalizeForCompare(src, options.normalizeUrlForCompare);
}
