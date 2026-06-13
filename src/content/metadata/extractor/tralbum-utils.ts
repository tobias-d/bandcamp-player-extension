import { normalizeStreamMatchKey, readTrackIdFromUrl } from '@/content/metadata/common';
import type { TralbumLike, TralbumTrack } from '@/content/metadata/extractor/types';

export function getTrackList(tralbum: TralbumLike): TralbumTrack[] {
  if (Array.isArray(tralbum.trackinfo)) {
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
