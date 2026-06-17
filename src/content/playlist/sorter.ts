import type { PlaylistState, PlaylistTrack } from '@/shared/types';

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function compareByIndex(a: PlaylistTrack, b: PlaylistTrack): number {
  return a.index - b.index;
}

function compareByBpm(a: PlaylistTrack, b: PlaylistTrack): number {
  const bpmA = Number.isFinite(a.bpm) ? Number(a.bpm) : Number.POSITIVE_INFINITY;
  const bpmB = Number.isFinite(b.bpm) ? Number(b.bpm) : Number.POSITIVE_INFINITY;
  return bpmA - bpmB;
}

function compareByTitle(a: PlaylistTrack, b: PlaylistTrack): number {
  const titleA = normalizeTitle(a.title || '');
  const titleB = normalizeTitle(b.title || '');
  if (titleA < titleB) {
    return -1;
  }
  if (titleA > titleB) {
    return 1;
  }
  return 0;
}

function normalizeKeyLabel(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function compareByKeyField(
  a: PlaylistTrack,
  b: PlaylistTrack,
  field: 'key1' | 'key2'
): number {
  const keyA = normalizeKeyLabel(a[field]);
  const keyB = normalizeKeyLabel(b[field]);
  if (!keyA && !keyB) {
    return 0;
  }
  if (!keyA) {
    return 1;
  }
  if (!keyB) {
    return -1;
  }
  if (keyA < keyB) {
    return -1;
  }
  if (keyA > keyB) {
    return 1;
  }
  return 0;
}

function compareTracks(sortKey: PlaylistState['sortKey'], a: PlaylistTrack, b: PlaylistTrack): number {
  if (sortKey === 'bpm') {
    return compareByBpm(a, b) || compareByIndex(a, b);
  }
  if (sortKey === 'key') {
    return compareByKeyField(a, b, 'key1') || compareByIndex(a, b);
  }
  if (sortKey === 'key2') {
    return compareByKeyField(a, b, 'key2') || compareByIndex(a, b);
  }
  if (sortKey === 'title') {
    return compareByTitle(a, b) || compareByIndex(a, b);
  }
  return compareByIndex(a, b);
}

export function sortPlaylistTracks(
  tracks: PlaylistTrack[],
  sortKey: PlaylistState['sortKey'],
  sortAsc: boolean
): PlaylistTrack[] {
  const sign = sortAsc ? 1 : -1;
  return [...tracks].sort((a, b) => sign * compareTracks(sortKey, a, b));
}

export function applyPlaylistSort(state: PlaylistState): PlaylistState {
  const effectiveSortAsc = state.sortKey === 'index' ? true : state.sortAsc;
  const sorted = sortPlaylistTracks(state.tracks, state.sortKey, effectiveSortAsc);
  const currentKey = (() => {
    const explicitCurrent = state.tracks.find((track) => track.isCurrent);
    if (explicitCurrent) {
      return explicitCurrent.cacheKey || explicitCurrent.trackId || String(explicitCurrent.index);
    }
    const byIndex = state.tracks[state.currentIndex];
    if (byIndex) {
      return byIndex.cacheKey || byIndex.trackId || String(byIndex.index);
    }
    return '';
  })();
  const nextCurrentIndex = currentKey
    ? Math.max(0, sorted.findIndex((track) => (track.cacheKey || track.trackId || String(track.index)) === currentKey))
    : Math.max(0, Math.min(state.currentIndex, Math.max(0, sorted.length - 1)));

  return {
    ...state,
    sortAsc: effectiveSortAsc,
    currentIndex: nextCurrentIndex,
    tracks: sorted.map((track, index) => ({
      ...track,
      isCurrent: index === nextCurrentIndex
    }))
  };
}

export function togglePlaylistSort(state: PlaylistState, key: PlaylistState['sortKey']): PlaylistState {
  const sortAsc = key === 'index' ? true : (state.sortKey === key ? !state.sortAsc : true);
  const nextState: PlaylistState = {
    ...state,
    sortKey: key,
    sortAsc
  };
  return applyPlaylistSort(nextState);
}
