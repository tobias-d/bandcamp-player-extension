import type { MetadataResolution, PlaylistState } from '@/shared/types';
import { normalizeUrl, readTrackIdFromUrl, resolveStreamContentId } from '@/content/playlist/resolver';
export type { TrackSelectionResult } from '@/content/playlist/track-selection';
export { triggerDomTrackSelection } from '@/content/playlist/track-selection';

export interface PlaylistAlignmentResult {
  playlist: PlaylistState;
  changed: boolean;
  reason: string;
  previousIndex: number;
  nextIndex: number;
}

export interface PlaylistSetResult {
  playlist: PlaylistState;
  changed: boolean;
  previousIndex: number;
  nextIndex: number;
}

export function alignPlaylistToCurrentPlayback(
  playlist: PlaylistState,
  currentSrc: string,
  metadataResolution: MetadataResolution | null
): PlaylistAlignmentResult {
  const tracks = playlist.tracks;
  if (!tracks.length) {
    return {
      playlist,
      changed: false,
      reason: 'none',
      previousIndex: playlist.currentIndex,
      nextIndex: playlist.currentIndex
    };
  }

  const trackId = readTrackIdFromUrl(currentSrc);
  const normalizedSrc = normalizeUrl(currentSrc);
  const streamContentId = resolveStreamContentId(currentSrc);

  let nextIndex = -1;
  let reason = 'none';

  if (trackId) {
    nextIndex = tracks.findIndex((track) => track.trackId === trackId);
    if (nextIndex >= 0) {
      reason = 'trackId';
    }
  }

  if (nextIndex < 0 && normalizedSrc) {
    nextIndex = tracks.findIndex((track) => normalizeUrl(track.streamUrl || '') === normalizedSrc);
    if (nextIndex >= 0) {
      reason = 'streamUrl';
    }
  }

  if (nextIndex < 0 && streamContentId) {
    nextIndex = tracks.findIndex((track) => resolveStreamContentId(track.streamUrl || '') === streamContentId);
    if (nextIndex >= 0) {
      reason = 'streamContentId';
    }
  }

  if (nextIndex < 0 && metadataResolution?.matchedTrackId) {
    nextIndex = tracks.findIndex((track) => track.trackId === metadataResolution.matchedTrackId);
    if (nextIndex >= 0) {
      reason = 'metadata.matchedTrackId';
    }
  }

  if (nextIndex < 0 || nextIndex === playlist.currentIndex) {
    return {
      playlist,
      changed: false,
      reason,
      previousIndex: playlist.currentIndex,
      nextIndex: playlist.currentIndex
    };
  }

  const nextPlaylist: PlaylistState = {
    ...playlist,
    currentIndex: nextIndex,
    tracks: tracks.map((track, index) => ({
      ...track,
      isCurrent: index === nextIndex
    }))
  };

  return {
    playlist: nextPlaylist,
    changed: true,
    reason,
    previousIndex: playlist.currentIndex,
    nextIndex
  };
}

export function setPlaylistCurrentIndex(playlist: PlaylistState, nextIndex: number): PlaylistSetResult {
  if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= playlist.tracks.length) {
    return {
      playlist,
      changed: false,
      previousIndex: playlist.currentIndex,
      nextIndex: playlist.currentIndex
    };
  }

  if (nextIndex === playlist.currentIndex && playlist.tracks[nextIndex]?.isCurrent) {
    return {
      playlist,
      changed: false,
      previousIndex: playlist.currentIndex,
      nextIndex: playlist.currentIndex
    };
  }

  const nextPlaylist: PlaylistState = {
    ...playlist,
    currentIndex: nextIndex,
    tracks: playlist.tracks.map((track, index) => ({
      ...track,
      isCurrent: index === nextIndex
    }))
  };

  return {
    playlist: nextPlaylist,
    changed: true,
    previousIndex: playlist.currentIndex,
    nextIndex
  };
}
