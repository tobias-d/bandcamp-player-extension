import type { PlaylistTrack } from '@/shared/types';

export function isTrackPlayable(track: PlaylistTrack | null | undefined): boolean {
  return Boolean(track && track.playable !== false);
}

export function findDirectionalPlayableIndex(
  tracks: PlaylistTrack[],
  currentIndex: number,
  direction: 1 | -1
): number {
  if (tracks.length <= 1) {
    return -1;
  }

  let cursor = Number.isInteger(currentIndex) ? currentIndex : 0;
  if (cursor < 0 || cursor >= tracks.length) {
    cursor = 0;
  }

  for (let step = 0; step < tracks.length - 1; step += 1) {
    cursor = (cursor + direction + tracks.length) % tracks.length;
    if (isTrackPlayable(tracks[cursor])) {
      return cursor;
    }
  }

  return -1;
}

export function findNextPlayableIndexWithoutWrap(
  tracks: PlaylistTrack[],
  currentIndex: number
): number {
  if (tracks.length <= 1) {
    return -1;
  }

  const startIndex = Number.isInteger(currentIndex) ? currentIndex : -1;
  for (let index = startIndex + 1; index < tracks.length; index += 1) {
    if (isTrackPlayable(tracks[index])) {
      return index;
    }
  }

  return -1;
}
