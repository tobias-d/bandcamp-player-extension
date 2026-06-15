import { asRecord, getNestedString } from '@/content/metadata/common';
import type { TralbumLike } from '@/content/metadata/extractor/types';
import { pickReleaseDateFromTralbum } from '@/content/metadata/release/date';
import { pickTrackArtistFromTralbum } from '@/content/metadata/extractor/track-artist';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';
import type { TrackReleaseDate } from '@/shared/types';
import {
  API_CACHE_TTL_MS,
  apiBackoffUntilByRelease,
  apiCacheByRelease,
  apiLastAttemptByRelease,
  trackIdsByReleaseKey,
  trackMetadataCandidatesByTrackId,
  trackMetadataIndexByTrackId,
  type TrackMetadataIndexEntry
} from '@/content/metadata/extractor/state';

export interface CachedTrackMetadataHit {
  trackId: string;
  title?: { value: string; source: string };
  artist?: { value: string; source: string };
  album?: { value: string; source: string };
  releaseDate?: TrackReleaseDate;
}

function normalizeTrackId(raw: unknown): string {
  return String(raw ?? '').replace(/[^\d]/g, '').trim();
}

function readTitleFromTrackRecord(track: Record<string, unknown>): { value: string; source: string } | null {
  const title = String(track.title ?? track.track_title ?? track.name ?? '').trim();
  if (!title) {
    return null;
  }
  if (String(track.title ?? '').trim()) {
    return { value: title, source: 'ApiCache.trackinfo.title' };
  }
  if (String(track.track_title ?? '').trim()) {
    return { value: title, source: 'ApiCache.trackinfo.track_title' };
  }
  return { value: title, source: 'ApiCache.trackinfo.name' };
}

function readAlbumFromTralbum(tralbum: TralbumLike): { value: string; source: string } | null {
  const record = asRecord(tralbum as unknown);
  if (!record) {
    return null;
  }
  const candidates: Array<{ value: string; source: string }> = [
    { value: getNestedString(record, 'album_title'), source: 'ApiCache.album_title' },
    { value: getNestedString(record, 'albumTitle'), source: 'ApiCache.albumTitle' },
    { value: getNestedString(record, 'release_title'), source: 'ApiCache.release_title' },
    { value: getNestedString(record, 'releaseTitle'), source: 'ApiCache.releaseTitle' },
    { value: getNestedString(record, 'item_title'), source: 'ApiCache.item_title' },
    { value: getNestedString(record, 'itemTitle'), source: 'ApiCache.itemTitle' },
    { value: getNestedString(record, 'current', 'title'), source: 'ApiCache.current.title' },
    { value: getNestedString(record, 'title'), source: 'ApiCache.title' },
    { value: getNestedString(record, 'name'), source: 'ApiCache.name' }
  ];
  const match = candidates.find((candidate) => String(candidate.value || '').trim().length > 0) ?? null;
  if (!match) {
    return null;
  }
  return {
    value: match.value.trim(),
    source: match.source
  };
}

function readArtistFromTralbum(tralbum: TralbumLike, trackId: string): { value: string; source: string } | null {
  const match = pickTrackArtistFromTralbum(tralbum, trackId);
  if (!match?.artist) {
    return null;
  }
  return {
    value: match.artist,
    source: `ApiCache.${match.source}`
  };
}

function isBetterCandidate(
  current: TrackMetadataIndexEntry | undefined,
  candidate: TrackMetadataIndexEntry
): boolean {
  if (!current) {
    return true;
  }
  if (candidate.completeness !== current.completeness) {
    return candidate.completeness > current.completeness;
  }
  if (candidate.trackCount !== current.trackCount) {
    return candidate.trackCount > current.trackCount;
  }
  return candidate.ts > current.ts;
}

function recomputeBestForTrack(trackId: string): void {
  const candidatesByRelease = trackMetadataCandidatesByTrackId.get(trackId);
  if (!candidatesByRelease || candidatesByRelease.size === 0) {
    trackMetadataCandidatesByTrackId.delete(trackId);
    trackMetadataIndexByTrackId.delete(trackId);
    return;
  }
  let best: TrackMetadataIndexEntry | undefined;
  for (const candidate of candidatesByRelease.values()) {
    if (isBetterCandidate(best, candidate)) {
      best = candidate;
    }
  }
  if (!best) {
    trackMetadataIndexByTrackId.delete(trackId);
    return;
  }
  trackMetadataIndexByTrackId.set(trackId, best);
}

function candidateToHit(candidate: TrackMetadataIndexEntry): CachedTrackMetadataHit {
  return {
    trackId: candidate.trackId,
    ...(candidate.title ? { title: candidate.title } : {}),
    ...(candidate.artist ? { artist: candidate.artist } : {}),
    ...(candidate.album ? { album: candidate.album } : {}),
    ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {})
  };
}

export function removeTrackMetadataIndexForRelease(
  releaseKey: string,
  options: { removeCacheEntry?: boolean } = {}
): void {
  const key = String(releaseKey || '').trim();
  if (!key) {
    return;
  }

  const trackIds = trackIdsByReleaseKey.get(key);
  if (trackIds) {
    for (const trackId of trackIds) {
      const byRelease = trackMetadataCandidatesByTrackId.get(trackId);
      if (!byRelease) {
        continue;
      }
      byRelease.delete(key);
      if (byRelease.size === 0) {
        trackMetadataCandidatesByTrackId.delete(trackId);
        trackMetadataIndexByTrackId.delete(trackId);
      } else {
        recomputeBestForTrack(trackId);
      }
    }
    trackIdsByReleaseKey.delete(key);
  }

  if (options.removeCacheEntry !== false) {
    apiCacheByRelease.delete(key);
    apiLastAttemptByRelease.delete(key);
    apiBackoffUntilByRelease.delete(key);
  }
}

export function upsertTrackMetadataIndexForRelease(releaseKey: string, tralbum: TralbumLike, ts: number): void {
  const key = String(releaseKey || '').trim();
  if (!key || !tralbum) {
    return;
  }

  // Replace existing release contribution atomically.
  removeTrackMetadataIndexForRelease(key, { removeCacheEntry: false });

  const tracks = getTrackList(tralbum);
  if (!tracks.length) {
    return;
  }

  const trackCount = tracks.length;
  const album = readAlbumFromTralbum(tralbum);
  const releaseDate = pickReleaseDateFromTralbum(tralbum as unknown, 'ApiCache');
  const indexedTrackIds = new Set<string>();

  for (const trackRaw of tracks) {
    const track = trackRaw as Record<string, unknown>;
    // Key only on track_id — the same field tralbumMatchesCurrentTrack/
    // pickTrackArtistFromTralbum use. track.id can be the album/item id, which
    // would register metadata under a non-track id the match guard never agrees with.
    const trackId = normalizeTrackId(track.track_id ?? '');
    if (!trackId) {
      continue;
    }

    const title = readTitleFromTrackRecord(track);
    const artist = readArtistFromTralbum(tralbum, trackId);
    const completeness =
      Number(Boolean(title?.value)) +
      Number(Boolean(artist?.value)) +
      Number(Boolean(album?.value)) +
      Number(Boolean(releaseDate?.iso));
    if (completeness === 0) {
      continue;
    }

    const candidate: TrackMetadataIndexEntry = {
      releaseKey: key,
      trackId,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      completeness,
      trackCount,
      ...(title ? { title } : {}),
      ...(artist ? { artist } : {}),
      ...(album ? { album } : {}),
      ...(releaseDate ? { releaseDate } : {})
    };

    const byRelease = trackMetadataCandidatesByTrackId.get(trackId) ?? new Map<string, TrackMetadataIndexEntry>();
    byRelease.set(key, candidate);
    trackMetadataCandidatesByTrackId.set(trackId, byRelease);
    indexedTrackIds.add(trackId);
  }

  if (!indexedTrackIds.size) {
    return;
  }

  trackIdsByReleaseKey.set(key, indexedTrackIds);
  for (const trackId of indexedTrackIds) {
    recomputeBestForTrack(trackId);
  }
}

export function resolveIndexedTrackMetadata(trackId: string): CachedTrackMetadataHit | null {
  const targetTrackId = normalizeTrackId(trackId);
  if (!targetTrackId) {
    return null;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const best = trackMetadataIndexByTrackId.get(targetTrackId);
    if (!best) {
      return null;
    }
    if (Date.now() - best.ts <= API_CACHE_TTL_MS) {
      return candidateToHit(best);
    }
    removeTrackMetadataIndexForRelease(best.releaseKey);
  }

  return null;
}
