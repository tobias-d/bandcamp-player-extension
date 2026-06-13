import type { PageGlobals, TrackReleaseDate } from '@/shared/types';
import { readTrackIdFromUrl } from '@/content/metadata/common';
import { getNowPlayingLinkedReleaseUrl } from '@/content/metadata/release';
import { toReleaseIdentity } from '@/content/metadata/identity';
import {
  getCachedAlbumIdentityForReleaseUrl,
  getResolvedIdentityForTrack
} from '@/content/metadata/extractor/probe-state';
import { collectApiHintCandidates } from '@/content/metadata/extractor/hints';
import type { TralbumLike } from '@/content/metadata/extractor/types';
import {
  getValidCachedApiEntry,
  getValidCachedApiEntryForRequestUrl
} from '@/content/metadata/extractor/api/fetch';
import { resolveIndexedTrackMetadata } from '@/content/metadata/extractor/api/track-index';
import { getTrackList, tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';

function getTrackRows(tralbum: TralbumLike | null): Array<Record<string, unknown>> {
  if (!tralbum) {
    return [];
  }
  const trackinfo = Array.isArray(tralbum.trackinfo) ? tralbum.trackinfo : [];
  const tracks = Array.isArray(tralbum.tracks) ? tralbum.tracks : [];
  if (tracks.length > trackinfo.length) {
    return tracks as Array<Record<string, unknown>>;
  }
  return trackinfo as Array<Record<string, unknown>>;
}

function readStreamFromTrack(track: Record<string, unknown>): string {
  const file = (track.file ?? null) as Record<string, unknown> | null;
  const fromFile = String(file?.['mp3-128'] ?? file?.['mp3-v0'] ?? file?.['mp3-320'] ?? '').trim();
  if (fromFile) {
    return fromFile;
  }
  const streaming = track.streaming_url ?? track.streamingUrl;
  if (typeof streaming === 'string') {
    const raw = streaming.trim();
    if (raw) {
      return raw;
    }
  }
  if (streaming && typeof streaming === 'object') {
    const record = streaming as Record<string, unknown>;
    const fromStreaming = String(record['mp3-128'] ?? record['mp3-v0'] ?? record['mp3-320'] ?? '').trim();
    if (fromStreaming) {
      return fromStreaming;
    }
  }
  return String(track.stream_url ?? track.streamUrl ?? '').trim();
}

function scoreTralbumCandidate(tralbum: TralbumLike | null): number {
  const tracks = getTrackRows(tralbum);
  if (!tracks.length) {
    return -1;
  }
  let streamCount = 0;
  for (const track of tracks) {
    if (readStreamFromTrack(track).length > 0) {
      streamCount += 1;
    }
  }
  return streamCount * 10_000 + tracks.length * 100;
}

export function getCachedApiTralbum(globals: PageGlobals | null, currentSrc = ''): TralbumLike | null {
  const candidates: TralbumLike[] = [];
  const pushCandidate = (candidate: TralbumLike | null | undefined): void => {
    if (!candidate) {
      return;
    }
    if (candidates.includes(candidate)) {
      return;
    }
    candidates.push(candidate);
  };

  const trackId = readTrackIdFromUrl(currentSrc);
  const resolved = getResolvedIdentityForTrack(trackId);
  if (resolved) {
    const cachedResolved = getValidCachedApiEntry(resolved);
    pushCandidate(cachedResolved?.tralbum ?? null);
  }

  const linkedReleaseUrl = getNowPlayingLinkedReleaseUrl();
  if (linkedReleaseUrl) {
    const linkedReleaseCached = getValidCachedApiEntryForRequestUrl(linkedReleaseUrl);
    pushCandidate(linkedReleaseCached?.tralbum ?? null);
  }
  const linkedAlbumIdentity = getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl);
  if (linkedAlbumIdentity) {
    const linkedAlbumCached = getValidCachedApiEntry(linkedAlbumIdentity);
    pushCandidate(linkedAlbumCached?.tralbum ?? null);
  }

  const apiHintCandidates = collectApiHintCandidates(trackId, linkedReleaseUrl, 10 * 60 * 1000);
  apiHintCandidates.slice(0, 20).forEach((identity) => {
    const cached = getValidCachedApiEntry(identity);
    pushCandidate(cached?.tralbum ?? null);
  });

  const identity = toReleaseIdentity(globals);
  if (identity) {
    const cached = getValidCachedApiEntry(identity);
    pushCandidate(cached?.tralbum ?? null);
  }

  if (!candidates.length) {
    return null;
  }

  const anchoredCandidates =
    trackId || currentSrc
      ? candidates.filter((candidate) => tralbumMatchesCurrentTrack(candidate, trackId, currentSrc))
      : candidates;

  if ((trackId || currentSrc) && !anchoredCandidates.length) {
    return null;
  }

  let best = anchoredCandidates[0] ?? null;
  let bestScore = scoreTralbumCandidate(best);
  for (let i = 1; i < anchoredCandidates.length; i += 1) {
    const candidate = anchoredCandidates[i] ?? null;
    const score = scoreTralbumCandidate(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

export interface CachedTrackMetadataHit {
  trackId: string;
  title?: { value: string; source: string };
  artist?: { value: string; source: string };
  album?: { value: string; source: string };
  releaseDate?: TrackReleaseDate;
}

export function resolveCachedTrackMetadata(trackId: string): CachedTrackMetadataHit | null {
  return resolveIndexedTrackMetadata(trackId);
}

export function findCachedTrackTitle(trackId: string): { title: string; source: string } | null {
  const resolved = resolveCachedTrackMetadata(trackId);
  if (!resolved?.title?.value) {
    return null;
  }
  return {
    title: resolved.title.value,
    source: resolved.title.source
  };
}

export function findCachedTrackAlbum(trackId: string): { album: string; source: string } | null {
  const resolved = resolveCachedTrackMetadata(trackId);
  if (!resolved?.album?.value) {
    return null;
  }
  return {
    album: resolved.album.value,
    source: resolved.album.source
  };
}

export function findCachedTrackArtist(trackId: string): { artist: string; source: string } | null {
  const resolved = resolveCachedTrackMetadata(trackId);
  if (!resolved?.artist?.value) {
    return null;
  }
  return {
    artist: resolved.artist.value,
    source: resolved.artist.source
  };
}
