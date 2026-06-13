import { normalizeUrl, readTrackIdFromUrl } from '@/content/playlist/resolver';

export function clickElement(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  try {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, composed: true }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
    element.click();
    return true;
  } catch {
    return false;
  }
}

export function selectPlaylistRows(): HTMLElement[] {
  const selectors = [
    '.track_list .track_row',
    '.tracklist .trackrow',
    '#track_list .track_row',
    '#tracklist .trackrow',
    'table.track_list tr.track_row_view',
    'tr.track_row_view'
  ];
  const seen = new Set<HTMLElement>();
  const rows: HTMLElement[] = [];
  for (const selector of selectors) {
    const matches = document.querySelectorAll<HTMLElement>(selector);
    matches.forEach((row) => {
      if (seen.has(row)) {
        return;
      }
      seen.add(row);
      rows.push(row);
    });
  }
  return rows;
}

export function clickTrackContainer(container: HTMLElement | null): boolean {
  if (!container) {
    return false;
  }
  const selectors = [
    '.play_col .play_status',
    '.play_col .playbutton',
    '.play_col a',
    '.track_play_auxiliary',
    '.tralbum-art-container.track_play_auxiliary',
    '.track_play_time',
    '.play_status',
    '.playbutton',
    'button.playbutton',
    'a.playbutton',
    'a'
  ];
  for (const selector of selectors) {
    const element = container.querySelector<HTMLElement>(selector);
    if (clickElement(element)) {
      return true;
    }
  }

  return clickElement(container);
}

export function resolveTrackSelectionContainer(element: HTMLElement | null): HTMLElement | null {
  if (!element) {
    return null;
  }
  const container = element.closest(
    '.story-innards.collection-item-container, .story-innards, .story, .collection-item-container, .track_row, .trackrow, tr.track_row_view'
  ) as HTMLElement | null;
  return container || element;
}

export function isUsableControl(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  if (element.closest('.bc-panel-root')) {
    return false;
  }
  if (element.matches('[disabled], [aria-disabled="true"], .disabled')) {
    return false;
  }
  return true;
}

export function normalizeCmpText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
}

export function normalizePath(raw: string): string {
  const absolute = normalizeUrl(raw);
  if (!absolute) {
    return '';
  }
  try {
    const parsed = new URL(absolute);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

export function getTrackRowTitle(row: HTMLElement): string {
  const selectors = ['.title', '.track-title', '.trackTitle', '.track_name', '.track-title a', 'a[title]'];
  for (const selector of selectors) {
    const element = row.querySelector<HTMLElement>(selector);
    const text = String(element?.textContent ?? '').trim() || String(element?.getAttribute('title') ?? '').trim();
    if (text) {
      return text;
    }
  }
  return String(row.textContent ?? '').trim();
}

function pickActiveAudio(): HTMLAudioElement | null {
  const audios = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
  if (!audios.length) {
    return null;
  }

  const playing = audios.find((audio) => !audio.paused && !audio.ended && Boolean(audio.currentSrc || audio.src));
  if (playing) {
    return playing;
  }

  const ready = audios.find((audio) => audio.readyState > 0 && Boolean(audio.currentSrc || audio.src));
  if (ready) {
    return ready;
  }

  return audios[0] ?? null;
}

function getPlaybackRoots(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const roots: HTMLElement[] = [];
  const addRoot = (element: Element | null): void => {
    if (!(element instanceof HTMLElement) || seen.has(element)) {
      return;
    }
    seen.add(element);
    roots.push(element);
  };

  const activeSelectors = [
    '.track_play_waypoint.playing',
    '.waypoint.track_play_waypoint.playing',
    '.waypoint.playing',
    '.story.playing',
    '.story-innards.playing',
    '.track_play_hilite.playing',
    '.collection-item-container.track_play_hilite',
    '.story-innards.collection-item-container.track_play_hilite',
    '#track_play_waypoint',
    '#footer-player',
    '.play_status',
    '#collection-player',
    '.collection-player'
  ];

  const activeAudio = pickActiveAudio();
  const currentSrc = activeAudio?.currentSrc || activeAudio?.src || '';
  const currentTrackId = readTrackIdFromUrl(currentSrc);
  if (currentTrackId) {
    const escapedTrackId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(currentTrackId)
        : currentTrackId;
    const trackContainers = document.querySelectorAll(
      `[data-trackid="${escapedTrackId}"], [data-track-id="${escapedTrackId}"]`
    );
    trackContainers.forEach((element) => {
      const container = (element as HTMLElement).closest(
        '.story, .story-innards, .collection-item-container, .track_play_hilite'
      );
      addRoot(container ?? element);
    });
  }

  activeSelectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => addRoot(element));
  });

  return roots;
}

export function clickGlobalPrevNext(direction: number): { ok: boolean; selector: string } {
  const nextSelectors = [
    '#collection-player .nextbutton',
    '.collection-player .nextbutton',
    '#collection-player .next',
    '.collection-player .next',
    '#track_play_waypoint .nextbutton',
    '#track_play_waypoint .next',
    '#footer-player .nextbutton',
    '#footer-player .next',
    '.inline_player .nextbutton',
    '.inline_player .next',
    '.inlineplayer .nextbutton',
    '.inlineplayer .next',
    '.play_controls .nextbutton',
    '.play_controls .next',
    '.player .nextbutton',
    '.player .next',
    '[data-action*="next"]',
    '[aria-label*="Next"]',
    '[data-bind*="next"]'
  ];
  const prevSelectors = [
    '#collection-player .prevbutton',
    '.collection-player .prevbutton',
    '#collection-player .prev',
    '.collection-player .prev',
    '#track_play_waypoint .prevbutton',
    '#track_play_waypoint .prev',
    '#footer-player .prevbutton',
    '#footer-player .prev',
    '.inline_player .prevbutton',
    '.inline_player .prev',
    '.inlineplayer .prevbutton',
    '.inlineplayer .prev',
    '.play_controls .prevbutton',
    '.play_controls .prev',
    '.player .prevbutton',
    '.player .prev',
    '[data-action*="prev"]',
    '[aria-label*="Prev"]',
    '[aria-label*="Previous"]',
    '[data-bind*="prev"]',
    '[data-bind*="previous"]'
  ];
  const selectors = direction > 0 ? nextSelectors : prevSelectors;
  const playbackRoots = getPlaybackRoots();

  for (const root of playbackRoots) {
    for (const selector of selectors) {
      const scoped = Array.from(root.querySelectorAll<HTMLElement>(selector));
      for (const element of scoped) {
        if (!isUsableControl(element)) {
          continue;
        }
        if (clickElement(element)) {
          return { ok: true, selector };
        }
      }
    }
  }

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    for (const element of elements) {
      if (!isUsableControl(element)) {
        continue;
      }
      if (clickElement(element)) {
        return { ok: true, selector };
      }
    }
  }
  return { ok: false, selector: '-' };
}
