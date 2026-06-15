import { normalizeStreamMatchKey, readTrackIdFromUrl } from '@/content/metadata/common';
import type { TralbumLike, TralbumTrack } from '@/content/metadata/extractor/types';

export function getTrackList(tralbum: TralbumLike): TralbumTrack[] {
  // Prefer trackinfo (canonical), but fall through to tracks when trackinfo is
  // an empty array — a merged payload can carry trackinfo:[] alongside a full
  // tracks[], and returning [] here makes the match-guard and index see no
  // tracks while the candidate scorer (which reads the longer array) sees them.
  if (Array.isArray(tralbum.trackinfo) && tralbum.trackinfo.length > 0) {
    return tralbum.trackinfo;
  }
  if (Array.isArray(tralbum.tracks)) {
    return tralbum.tracks;
  }
  return [];
}

export function tralbumMatchesCurrentTrack(tralbum: TralbumLike, currentTrackId: string, currentSrc: string): boolean {
  if (!currentTrackId && !currentSrc) {
    return false;
  }
  const normalizedCurrentSrc = normalizeStreamMatchKey(currentSrc || '');
  const tracks = getTrackList(tralbum);
  return tracks.some((track) => {
    if (currentTrackId && String(track.track_id ?? '') === currentTrackId) {
      return true;
    }
    if (!normalizedCurrentSrc) {
      return false;
    }
    const streamUrl = normalizeStreamMatchKey(String(track.file?.['mp3-128'] ?? ''));
    if (streamUrl && streamUrl === normalizedCurrentSrc) {
      return true;
    }
    if (streamUrl) {
      const streamTrackId = readTrackIdFromUrl(streamUrl);
      if (streamTrackId && currentTrackId && streamTrackId === currentTrackId) {
        return true;
      }
    }
    return false;
  });
}
