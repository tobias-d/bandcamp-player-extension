import type { PlaylistTrack } from '@/shared/types';
import {
  clickGlobalPrevNext,
  clickTrackContainer,
  getTrackRowTitle,
  normalizeCmpText,
  normalizePath,
  resolveTrackSelectionContainer,
  selectPlaylistRows
} from '@/content/playlist/track-selection-dom';
import { jumpViaPrevNext } from '@/content/playlist/track-selection-navigation';

export interface TrackSelectionResult {
  ok: boolean;
  strategy: string;
  detail: string;
}

export function triggerDomTrackSelection(
  track: PlaylistTrack,
  currentIndex = -1,
  totalTracks = 0,
  currentTrack: PlaylistTrack | null = null
): TrackSelectionResult {
  if (track.trackId) {
    const escapedTrackId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(track.trackId)
        : track.trackId;
    const selectors = [
      `[data-track-id="${escapedTrackId}"]`,
      `[data-trackid="${escapedTrackId}"]`,
      `a.track_play_auxiliary[data-trackid="${escapedTrackId}"]`,
      `.track_play_auxiliary[data-trackid="${escapedTrackId}"]`,
      `.tralbum-art-container.track_play_auxiliary[data-trackid="${escapedTrackId}"]`,
      `span.track_play_time[data-trackid="${escapedTrackId}"]`,
      `.story-innards.collection-item-container[data-trackid="${escapedTrackId}"]`,
      `.collection-item-container[data-trackid="${escapedTrackId}"]`,
      `.collection-item-container[data-trackid="${escapedTrackId}"] .track_play_auxiliary`,
      `tr.track_row_view[data-track-id="${escapedTrackId}"]`,
      `tr.track_row_view[data-trackid="${escapedTrackId}"]`,
      `.track_row[data-track-id="${escapedTrackId}"]`,
      `.track_row[data-trackid="${escapedTrackId}"]`
    ];

    for (const selector of selectors) {
      const element = document.querySelector<HTMLElement>(selector);
      if (clickTrackContainer(resolveTrackSelectionContainer(element))) {
        return { ok: true, strategy: 'track-id-selector', detail: selector };
      }
    }
  }

  const rows = selectPlaylistRows();
  if (rows[track.index] && clickTrackContainer(rows[track.index])) {
    return { ok: true, strategy: 'track-row-index', detail: `row=${track.index}` };
  }

  const trackNum = track.index + 1;
  const relSelector = `a[rel="tracknum=${trackNum}"], a[href*="#t${trackNum}"]`;
  const relAnchor = document.querySelector<HTMLElement>(relSelector);
  const relContainer = relAnchor?.closest('.track_row, .trackrow, tr.track_row_view') as HTMLElement | null;
  if (clickTrackContainer(relContainer || relAnchor)) {
    return { ok: true, strategy: 'tracknum-anchor', detail: relSelector };
  }

  if (track.pageUrl) {
    const targetPath = normalizePath(track.pageUrl);
    if (targetPath) {
      const roots = [
        '.track_list',
        '#track_list',
        '.tracklist',
        '.play_status',
        '.collection-player',
        '#collection-player',
        '.collection-item-container',
        '.track_play_hilite',
        '.story-innards.collection-item-container',
        '.story-innards',
        '.story',
        '#story-list',
        '#collection-items',
        '.collection-grid'
      ];
      for (const rootSelector of roots) {
        const root = document.querySelector(rootSelector);
        if (!root) {
          continue;
        }
        const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));
        for (const anchor of anchors) {
          const href = anchor.getAttribute('href') || '';
          if (normalizePath(href) !== targetPath) {
            continue;
          }
          const container = anchor.closest('.track_row, .trackrow, tr.track_row_view') as HTMLElement | null;
          if (clickTrackContainer(container || anchor)) {
            return { ok: true, strategy: 'page-url-link', detail: targetPath };
          }
        }
      }
    }
  }

  const normalizedTitle = normalizeCmpText(track.title);
  if (normalizedTitle) {
    const fuzzyMatches: HTMLElement[] = [];
    for (const row of rows) {
      const rowTitle = normalizeCmpText(getTrackRowTitle(row));
      if (!rowTitle) {
        continue;
      }
      if (rowTitle === normalizedTitle && clickTrackContainer(row)) {
        return { ok: true, strategy: 'title-row-match', detail: rowTitle.slice(0, 120) };
      }
      if (rowTitle.includes(normalizedTitle) || normalizedTitle.includes(rowTitle)) {
        fuzzyMatches.push(row);
      }
    }
    if (fuzzyMatches.length === 1 && clickTrackContainer(fuzzyMatches[0])) {
      return { ok: true, strategy: 'title-row-fuzzy', detail: normalizedTitle.slice(0, 120) };
    }
  }

  const prevNextJump = jumpViaPrevNext({
    targetIndex: track.index,
    currentIndex: Number.isInteger(currentTrack?.index) ? Number(currentTrack?.index) : currentIndex,
    totalTracks,
    clickGlobalPrevNext
  });
  if (prevNextJump.ok) {
    return { ok: true, strategy: 'global-prev-next', detail: prevNextJump.detail };
  }

  return {
    ok: false,
    strategy: 'none',
    detail: `trackId=${track.trackId || '-'} title=${track.title || '-'}`
  };
}
