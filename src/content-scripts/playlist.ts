/**
 * Playlist controller for Bandcamp pages.
 *
 * Responsibilities:
 * - Resolve track lists from local `data-tralbum`
 * - Fallback to `FETCH_TRALBUM` on collection pages when needed
 * - Track currently playing row/index across Bandcamp DOM variants
 * - Handle UI-triggered jumps and optional silent BPM enrichment
 */
import type { BeatMode } from '../shared/index';

interface BandcampTrackInfo {
  track_id?: number;
  id?: number;
  title?: string;
  duration?: number;
  is_playing?: boolean;
  file?: Record<string, string>;
  title_link?: string;
  track_link?: string;
  url?: string;
}

interface BandcampTralbumData {
  artist?: string;
  album_title?: string;
  current?: {
    type?: 'track' | 'album';
    title?: string;
  };
  trackinfo?: BandcampTrackInfo[];
}

interface FetchTralbumResponse {
  tralbum?: BandcampTralbumData | null;
  trackinfo?: BandcampTrackInfo[];
  error?: string;
}

export interface PlaylistTrack {
  index: number;
  title: string;
  durationSec: number;
  bpm?: number;
  isCurrent: boolean;
}

export interface PlaylistState {
  tracks: PlaylistTrack[];
  currentIndex: number;
  expanded: boolean;
  loading: boolean;
}

interface PlaylistControllerOptions {
  sendRuntimeMessage: <T = any>(message: any) => Promise<T>;
  onChange?: (() => void) | null;
  getBeatMode?: (() => BeatMode) | null;
}

interface InternalPlaylistTrack {
  index: number;
  title: string;
  durationSec: number;
  trackId: string;
  streamUrl: string;
  pageUrl: string;
  cacheKey: string;
  isPlayingHint: boolean;
}

function norm(input: string | null | undefined): string {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) return '';
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return '';
  }
}

function normalizePath(raw: string): string {
  const absolute = normalizeUrl(raw);
  if (!absolute) return '';
  try {
    const parsed = new URL(absolute);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function extractTrackIdFromSrc(src: string): string {
  const match = String(src || '').match(/\/(\d+)(?:\?|$)/);
  return match?.[1] || '';
}

function pickTrackFileUrl(file?: Record<string, string>): string {
  if (!file || typeof file !== 'object') return '';
  const preferred = ['mp3-128', 'mp3-v0', 'aac-hi'];
  for (const key of preferred) {
    const normalized = normalizeUrl(file[key] || '');
    if (normalized) return normalized;
  }
  for (const raw of Object.values(file)) {
    const normalized = normalizeUrl(raw || '');
    if (normalized) return normalized;
  }
  return '';
}

function getTrackPageUrl(track: BandcampTrackInfo): string {
  const candidates = [track?.title_link, track?.track_link, track?.url];
  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate || '');
    if (normalized) return normalized;
  }
  return '';
}

function getTrackCacheKey(trackId: string, streamUrl: string): string {
  if (trackId) return `bandcamp-track-id:${trackId}`;
  if (streamUrl) return `bandcamp-track-url:${streamUrl}`;
  return '';
}

function getCurrentTrackIndex(tracks: InternalPlaylistTrack[], currentAudioSrc: string): number {
  const currentTrackId = extractTrackIdFromSrc(currentAudioSrc);
  let index = -1;

  if (currentTrackId) {
    index = tracks.findIndex((track) => track.trackId === currentTrackId);
  }

  if (index < 0) {
    const normalizedCurrentSrc = normalizeUrl(currentAudioSrc);
    if (normalizedCurrentSrc) {
      index = tracks.findIndex((track) => track.streamUrl === normalizedCurrentSrc);
    }
  }

  if (index < 0) {
    const currentPath = normalizePath(window.location.href);
    if (currentPath) {
      index = tracks.findIndex((track) => track.pageUrl && normalizePath(track.pageUrl) === currentPath);
    }
  }

  if (index < 0) {
    index = tracks.findIndex((track) => track.isPlayingHint);
  }

  if (index < 0) {
    const playingRowSelectors = [
      '.track_list .track_row.playing',
      '.track_list .track_row.current',
      '.track_list .track_row.now_playing',
      '.tracklist .trackrow.playing',
      '.tracklist .trackrow.current',
      '.tracklist .trackrow.nowplaying',
      'table.track_list tr.track_row_view.current_track',
      'tr.track_row_view.current_track',
      'table.track_list tr.track_row_view.playing',
      'tr.track_row_view.playing',
    ];
    for (const selector of playingRowSelectors) {
      const row = document.querySelector(selector) as HTMLElement | null;
      if (!row) continue;
      const rowTrackId = getTrackIdFromElement(row);
      if (rowTrackId) {
        const byTrackId = tracks.findIndex((track) => track.trackId === rowTrackId);
        if (byTrackId >= 0) {
          index = byTrackId;
          break;
        }
      }
      const rowTitle = normalizeCmpText(getTrackRowTitle(row));
      if (!rowTitle) continue;
      const byTitle = tracks.findIndex((track) => {
        const title = normalizeCmpText(track.title);
        return Boolean(title) && (title === rowTitle || title.includes(rowTitle) || rowTitle.includes(title));
      });
      if (byTitle >= 0) {
        index = byTitle;
        break;
      }
    }
  }

  if (index < 0) {
    const nowPlayingSelectors = [
      '.play_status .track-title',
      '.play_status .title',
      '.collection-player .track-title',
      '#collection-player .track-title',
    ];
    for (const selector of nowPlayingSelectors) {
      const el = document.querySelector(selector);
      const nowPlayingTitle = normalizeCmpText(el?.textContent || '');
      if (!nowPlayingTitle) continue;
      const byTitle = tracks.findIndex((track) => {
        const title = normalizeCmpText(track.title);
        return Boolean(title) && (title === nowPlayingTitle || title.includes(nowPlayingTitle) || nowPlayingTitle.includes(title));
      });
      if (byTitle >= 0) {
        index = byTitle;
        break;
      }
    }
  }

  return index;
}

function extractDataAttribute(selector: string, attr: string): any | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const raw = element.getAttribute(attr);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getLocalTralbumData(): BandcampTralbumData | null {
  return extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;
}

function isCollectionPage(): boolean {
  const host = window.location.hostname.toLowerCase();
  if (host !== 'bandcamp.com' && host !== 'www.bandcamp.com') return false;

  const path = window.location.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return false;
  if (path.includes('/album/') || path.includes('/track/')) return false;

  const firstSegment = path.split('/').filter(Boolean)[0] || '';
  const reserved = new Set([
    'about',
    'api',
    'blog',
    'discover',
    'feed',
    'help',
    'search',
    'tag',
    'terms_of_use',
    'privacy',
    'tour',
    'music',
  ]);
  if (reserved.has(firstSegment)) return false;

  return true;
}

function isBandcampTrackOrAlbumUrl(raw: string): boolean {
  const url = normalizeUrl(raw);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isBandcampHost = host === 'bandcamp.com' || host.endsWith('.bandcamp.com');
    if (!isBandcampHost) return false;
    return /\/(track|album)\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function getCollectionPlayerLinkedUrl(): string {
  const directSelectors = [
    '.play_status .track-title a[href]',
    '.play_status .title a[href]',
    '.play_status .fromAlbum a[href]',
    '.collection-player .track-title a[href]',
    '.collection-player .fromAlbum a[href]',
    '#collection-player .track-title a[href]',
    '#collection-player .fromAlbum a[href]',
    '#track_play_waypoint a[href]',
  ];

  for (const selector of directSelectors) {
    const anchor = document.querySelector(selector) as HTMLAnchorElement | null;
    if (!anchor) continue;
    const href = anchor.getAttribute('href') || '';
    if (!isBandcampTrackOrAlbumUrl(href)) continue;
    const normalized = normalizeUrl(href);
    if (normalized) return normalized;
  }

  const roots = ['.play_status', '.collection-player', '#collection-player', '#track_play_waypoint'];
  for (const rootSelector of roots) {
    const root = document.querySelector(rootSelector);
    if (!root) continue;
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (!isBandcampTrackOrAlbumUrl(href)) continue;
      const normalized = normalizeUrl(href);
      if (normalized) return normalized;
    }
  }

  return '';
}

function toInternalTracks(trackinfo: BandcampTrackInfo[]): InternalPlaylistTrack[] {
  const out: InternalPlaylistTrack[] = [];
  for (let i = 0; i < trackinfo.length; i += 1) {
    const track = trackinfo[i] || {};
    const trackId = norm(String(track?.track_id ?? track?.id ?? ''));
    const streamUrl = pickTrackFileUrl(track?.file);
    const pageUrl = getTrackPageUrl(track);
    const durationSec = Number(track?.duration);
    const title = norm(track?.title) || `Track ${i + 1}`;

    out.push({
      index: i,
      title,
      durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : NaN,
      trackId,
      streamUrl,
      pageUrl,
      cacheKey: getTrackCacheKey(trackId, streamUrl),
      isPlayingHint: Boolean(track?.is_playing),
    });
  }

  return out;
}

function selectPlaylistRows(): HTMLElement[] {
  const selectors = [
    '.track_list .track_row',
    '.tracklist .trackrow',
    '#track_list .track_row',
    '#tracklist .trackrow',
    'table.track_list tr.track_row_view',
    'tr.track_row_view',
  ];

  const rows: HTMLElement[] = [];
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((element) => rows.push(element as HTMLElement));
  }
  return rows;
}

function clickElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  try {
    if (typeof el.click === 'function') {
      el.click();
      return true;
    }

    const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const eventType of events) {
      el.dispatchEvent(
        new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window,
        })
      );
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeCmpText(input: string): string {
  return norm(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

function getTrackIdFromElement(el: Element | null): string {
  if (!el) return '';
  const candidates = [
    (el as HTMLElement).getAttribute?.('data-track-id'),
    (el as HTMLElement).getAttribute?.('data-trackid'),
    (el as HTMLElement).getAttribute?.('rel'),
  ];
  for (const raw of candidates) {
    const clean = norm(String(raw || '')).replace(/[^\d]/g, '');
    if (clean) return clean;
  }
  return '';
}

function getTrackRowTitle(row: HTMLElement | null): string {
  if (!row) return '';
  const selectors = [
    '.title',
    '.track-title',
    '.trackTitle',
    '.track_name',
    '.track-title a',
    'a[title]',
  ];
  for (const selector of selectors) {
    const el = row.querySelector(selector);
    const text = norm(el?.textContent) || norm((el as HTMLElement | null)?.getAttribute?.('title'));
    if (text) return text;
  }
  return norm(row.textContent);
}

function clickTrackContainer(container: HTMLElement | null): boolean {
  if (!container) return false;
  const selectors = [
    '.play_col .play_status',
    '.play_col .playbutton',
    '.play_col a',
    '.playbutton',
    'button.playbutton',
    'a.playbutton',
  ];

  for (const selector of selectors) {
    const element = container.querySelector(selector) as HTMLElement | null;
    if (clickElement(element)) return true;
  }

  return clickElement(container);
}

function findAndClickTrackById(trackId: string): boolean {
  if (!trackId) return false;
  const escaped = (globalThis as any)?.CSS?.escape ? (globalThis as any).CSS.escape(trackId) : trackId;
  const selectors = [
    `[data-track-id="${escaped}"]`,
    `[data-trackid="${escaped}"]`,
    `tr.track_row_view[data-track-id="${escaped}"]`,
    `tr.track_row_view[data-trackid="${escaped}"]`,
    `.track_row[data-track-id="${escaped}"]`,
    `.track_row[data-trackid="${escaped}"]`,
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector) as HTMLElement | null;
    if (!element) continue;
    if (clickTrackContainer(element)) return true;
  }

  return false;
}

function findAndClickTrackByPageUrl(pageUrl: string): boolean {
  const targetPath = normalizePath(pageUrl);
  if (!targetPath) return false;

  const roots = ['.track_list', '#track_list', '.tracklist', '.play_status', '.collection-player', '#collection-player'];
  for (const rootSelector of roots) {
    const root = document.querySelector(rootSelector);
    if (!root) continue;

    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (normalizePath(href) !== targetPath) continue;

      const clickableContainer = anchor.closest('.track_row, .trackrow, tr.track_row_view') as HTMLElement | null;
      if (!clickableContainer) continue;
      if (clickTrackContainer(clickableContainer)) return true;
    }
  }

  return false;
}

function findAndClickTrackByTitle(title: string): boolean {
  const target = normalizeCmpText(title);
  if (!target) return false;

  const rows = selectPlaylistRows();
  const fuzzyMatches: HTMLElement[] = [];
  for (const row of rows) {
    const rowTitle = normalizeCmpText(getTrackRowTitle(row));
    if (!rowTitle) continue;
    if (rowTitle === target) {
      if (clickTrackContainer(row)) return true;
    }
    if (rowTitle.includes(target) || target.includes(rowTitle)) {
      fuzzyMatches.push(row);
    }
  }

  // Only use fuzzy fallback when there is exactly one candidate.
  if (fuzzyMatches.length === 1) {
    if (clickTrackContainer(fuzzyMatches[0])) return true;
  }

  return false;
}

function clickGlobalPrevNext(direction: number): boolean {
  const nextSelectors = [
    '.inline_player .nextbutton',
    '.inline_player .next',
    '.inlineplayer .nextbutton',
    '.inlineplayer .next',
    '.play_controls .nextbutton',
    '.play_controls .next',
    '.player .nextbutton',
    '.player .next',
    '[data-bind*="next"]',
  ];
  const prevSelectors = [
    '.inline_player .prevbutton',
    '.inline_player .prev',
    '.inlineplayer .prevbutton',
    '.inlineplayer .prev',
    '.play_controls .prevbutton',
    '.play_controls .prev',
    '.player .prevbutton',
    '.player .prev',
    '[data-bind*="prev"]',
    '[data-bind*="previous"]',
  ];

  const selectors = direction > 0 ? nextSelectors : prevSelectors;
  for (const selector of selectors) {
    const element = document.querySelector(selector) as HTMLElement | null;
    if (!element) continue;
    if (clickElement(element)) return true;
  }
  return false;
}

function jumpViaPrevNext(currentIndex: number, targetIndex: number, total: number): boolean {
  if (total <= 1 || currentIndex < 0 || targetIndex < 0 || currentIndex === targetIndex) return false;
  const forwardSteps = (targetIndex - currentIndex + total) % total;
  const backwardSteps = (currentIndex - targetIndex + total) % total;
  const direction = forwardSteps <= backwardSteps ? 1 : -1;
  const steps = Math.min(forwardSteps, backwardSteps);
  if (steps <= 0) return false;

  let clickedAny = false;
  for (let i = 0; i < steps; i += 1) {
    const clicked = clickGlobalPrevNext(direction);
    if (!clicked) return clickedAny;
    clickedAny = true;
  }
  return clickedAny;
}

function pickActiveAudio(): HTMLAudioElement | null {
  const audios = Array.from(document.querySelectorAll('audio'));
  if (!audios.length) return null;

  const playing = audios.find((audio) => !audio.paused && (audio.currentSrc || audio.src));
  if (playing) return playing;

  const ready = audios.find((audio) => (audio.currentSrc || audio.src) && audio.readyState > 0);
  if (ready) return ready;

  return audios[0] || null;
}

function getAudioElements(): HTMLAudioElement[] {
  return Array.from(document.querySelectorAll('audio'));
}

function pauseAudioSafe(audio: HTMLAudioElement): void {
  try {
    if (!audio.paused) {
      audio.pause();
    }
  } catch {
    // Ignore pause errors.
  }
}

function stopAllPlayingAudio(): void {
  const audios = getAudioElements();
  for (const audio of audios) {
    pauseAudioSafe(audio);
  }
}

function ensureExclusivePlayback(target: HTMLAudioElement | null): void {
  if (!target) return;
  const audios = getAudioElements();
  for (const audio of audios) {
    if (audio === target) continue;
    pauseAudioSafe(audio);
  }
}

function tryPlayAudio(target: HTMLAudioElement | null): void {
  if (!target) return;
  ensureExclusivePlayback(target);
  try {
    const maybePromise = target.play();
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === 'function') {
      (maybePromise as Promise<void>).catch(() => {
        // Ignore autoplay/runtime play errors.
      });
    }
  } catch {
    // Ignore runtime play errors.
  }
}

function findAudioByStreamUrl(streamUrl: string): HTMLAudioElement | null {
  const normalizedTarget = normalizeUrl(streamUrl);
  if (!normalizedTarget) return null;
  const targetTrackId = extractTrackIdFromSrc(normalizedTarget);
  const audios = getAudioElements();
  for (const audio of audios) {
    const src = normalizeUrl(audio.currentSrc || audio.src || '');
    if (!src) continue;
    if (src === normalizedTarget) {
      return audio;
    }
    const audioTrackId = extractTrackIdFromSrc(src);
    if (targetTrackId && audioTrackId && targetTrackId === audioTrackId) {
      return audio;
    }
  }
  return null;
}

function ensureSelectedTrackPlayback(
  targetStreamUrl: string,
  preferImmediateFallback = false,
  allowDirectSrcFallback = true
): void {
  const maxRetries = preferImmediateFallback ? 6 : 12;
  const retryMs = preferImmediateFallback ? 70 : 120;
  const fallbackAttempt = preferImmediateFallback ? 4 : maxRetries;
  let attempt = 0;
  const normalizedTarget = normalizeUrl(targetStreamUrl);
  let fallbackTriggered = false;

  const tick = () => {
    attempt += 1;
    const targetAudio = normalizedTarget ? findAudioByStreamUrl(normalizedTarget) : null;

    if (targetAudio) {
      tryPlayAudio(targetAudio);
      if (attempt < maxRetries && targetAudio.paused) {
        setTimeout(tick, retryMs);
      }
      return;
    }

    // If we know target URL, do not reactivate a different track.
    if (normalizedTarget) {
      if (allowDirectSrcFallback && !fallbackTriggered && attempt >= fallbackAttempt) {
        fallbackTriggered = true;
        jumpByAudioSource(normalizedTarget);
      }

      if (attempt < maxRetries) {
        setTimeout(tick, retryMs);
      } else {
        if (allowDirectSrcFallback && !fallbackTriggered) {
          jumpByAudioSource(normalizedTarget);
        }
      }
      return;
    }

    const active = pickActiveAudio();
    if (!active) {
      if (attempt < maxRetries) {
        setTimeout(tick, retryMs);
      }
      return;
    }

    tryPlayAudio(active);

    if (attempt < maxRetries && active.paused) {
      setTimeout(tick, retryMs);
    }
  };

  setTimeout(tick, 0);
}

function jumpByAudioSource(streamUrl: string): boolean {
  const normalized = normalizeUrl(streamUrl);
  if (!normalized) return false;

  const audio = pickActiveAudio();
  if (!audio) return false;

  const currentSrc = normalizeUrl(audio.currentSrc || audio.src || '');
  const currentTrackId = extractTrackIdFromSrc(currentSrc);
  const targetTrackId = extractTrackIdFromSrc(normalized);
  const isSameTrack = Boolean(currentTrackId && targetTrackId && currentTrackId === targetTrackId);

  if (currentSrc !== normalized && !isSameTrack) {
    try {
      stopAllPlayingAudio();
      audio.src = normalized;
      audio.load();
    } catch {
      return false;
    }
  }

  tryPlayAudio(audio);
  return true;
}

class PlaylistController {
  private readonly sendRuntimeMessage: <T = any>(message: any) => Promise<T>;
  private readonly onChange: (() => void) | null;
  private readonly getBeatMode: (() => BeatMode) | null;

  private tracks: InternalPlaylistTrack[] = [];
  private viewState: PlaylistState = {
    tracks: [],
    currentIndex: -1,
    expanded: false,
    loading: false,
  };

  private bpmByCacheKey = new Map<string, number>();
  private bpmMissingKeys = new Set<string>();
  private currentAudioSrc = '';
  private lastLocationHref = '';
  private resolveRunId = 0;
  private resolveInFlight = false;
  private bpmRunId = 0;
  private bpmInFlight = false;

  constructor(options: PlaylistControllerOptions) {
    this.sendRuntimeMessage = options.sendRuntimeMessage;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.getBeatMode = typeof options.getBeatMode === 'function' ? options.getBeatMode : null;
  }

  getState(): PlaylistState {
    return this.viewState;
  }

  refresh(currentAudioSrc: string, currentTrackBpm?: number): void {
    const nextSrc = normalizeUrl(currentAudioSrc);
    const locationHref = window.location.href;
    const srcChanged = nextSrc !== this.currentAudioSrc;
    const locationChanged = locationHref !== this.lastLocationHref;
    this.currentAudioSrc = nextSrc;
    this.lastLocationHref = locationHref;

    if (locationChanged && this.viewState.expanded) {
      this.viewState = {
        ...this.viewState,
        expanded: false,
      };
      this.notifyChange();
    }

    if (Number.isFinite(currentTrackBpm) && this.tracks.length) {
      const idx = getCurrentTrackIndex(this.tracks, this.currentAudioSrc);
      if (idx >= 0) {
        const key = this.tracks[idx].cacheKey;
        if (key && !this.bpmByCacheKey.has(key)) {
          this.bpmByCacheKey.set(key, Number(currentTrackBpm));
        }
      }
    }

    const currentIndex = this.tracks.length ? getCurrentTrackIndex(this.tracks, this.currentAudioSrc) : -1;
    const canReusePlaylist = this.tracks.length > 0 && currentIndex >= 0 && !locationChanged;
    const indexChanged = currentIndex !== this.viewState.currentIndex;

    if (canReusePlaylist) {
      this.syncViewState(indexChanged);
      if (this.viewState.expanded) {
        this.ensureBpmQueue();
      }
      return;
    }

    if (!srcChanged && !locationChanged && this.tracks.length) {
      this.syncViewState(indexChanged);
      return;
    }

    if (this.resolveInFlight) return;
    void this.resolvePlaylist();
  }

  toggleExpanded(): void {
    this.viewState = {
      ...this.viewState,
      expanded: !this.viewState.expanded,
    };
    this.notifyChange();
    if (this.viewState.expanded) {
      this.ensureBpmQueue();
    } else {
      this.bpmRunId += 1;
      this.bpmInFlight = false;
    }
  }

  jumpToTrack(index: number): boolean {
    const track = this.tracks[index];
    if (!track) return false;
    const currentIndex = getCurrentTrackIndex(this.tracks, this.currentAudioSrc);
    const total = this.tracks.length;

    if (jumpViaPrevNext(currentIndex, index, total)) {
      ensureSelectedTrackPlayback(track.streamUrl, true, false);
      return true;
    }

    if (findAndClickTrackById(track.trackId)) {
      ensureSelectedTrackPlayback(track.streamUrl, true, false);
      return true;
    }
    const rows = selectPlaylistRows();
    if (rows[track.index] && clickTrackContainer(rows[track.index])) {
      ensureSelectedTrackPlayback(track.streamUrl, true, false);
      return true;
    }
    if (findAndClickTrackByPageUrl(track.pageUrl)) {
      ensureSelectedTrackPlayback(track.streamUrl, true, false);
      return true;
    }
    if (findAndClickTrackByTitle(track.title)) {
      ensureSelectedTrackPlayback(track.streamUrl, true, false);
      return true;
    }

    const played = jumpByAudioSource(track.streamUrl);
    if (played) {
      ensureSelectedTrackPlayback(track.streamUrl);
      return true;
    }
    return false;
  }

  private notifyChange(): void {
    if (typeof this.onChange === 'function') {
      this.onChange();
    }
  }

  private syncViewState(emitChange: boolean): void {
    const currentIndex = getCurrentTrackIndex(this.tracks, this.currentAudioSrc);
    const tracks: PlaylistTrack[] = this.tracks.map((track, idx) => ({
      index: idx,
      title: track.title,
      durationSec: track.durationSec,
      bpm: this.bpmByCacheKey.get(track.cacheKey),
      isCurrent: idx === currentIndex,
    }));

    this.viewState = {
      ...this.viewState,
      tracks,
      currentIndex,
      loading: false,
    };
    if (emitChange) {
      this.notifyChange();
    }
  }

  private async resolvePlaylist(): Promise<void> {
    const runId = ++this.resolveRunId;
    this.resolveInFlight = true;
    this.viewState = {
      ...this.viewState,
      loading: true,
    };
    this.notifyChange();

    try {
      const localTralbum = getLocalTralbumData();
      let trackinfo = Array.isArray(localTralbum?.trackinfo) ? localTralbum!.trackinfo! : [];

      if (isCollectionPage() && trackinfo.length <= 1) {
        const linkedUrl = getCollectionPlayerLinkedUrl();
        if (linkedUrl) {
          try {
            const response = await this.sendRuntimeMessage<FetchTralbumResponse>({
              type: 'FETCH_TRALBUM',
              url: linkedUrl,
            });

            const fetchedTrackinfo = Array.isArray(response?.tralbum?.trackinfo)
              ? response!.tralbum!.trackinfo!
              : Array.isArray(response?.trackinfo)
              ? response!.trackinfo!
              : [];

            if (fetchedTrackinfo.length > 0) {
              trackinfo = fetchedTrackinfo;
            }
          } catch (error) {
            console.warn('[Playlist] FETCH_TRALBUM fallback failed:', error);
          }
        }
      }

      if (runId !== this.resolveRunId) return;

      this.tracks = toInternalTracks(trackinfo);
      this.bpmRunId += 1;
      this.bpmInFlight = false;
      this.syncViewState(true);
      if (this.viewState.expanded) {
        this.ensureBpmQueue();
      }
    } catch (error) {
      if (runId !== this.resolveRunId) return;
      console.warn('[Playlist] Failed to resolve playlist:', error);
      this.tracks = [];
      this.viewState = {
        ...this.viewState,
        tracks: [],
        currentIndex: -1,
        loading: false,
      };
      this.notifyChange();
    } finally {
      if (runId === this.resolveRunId) {
        this.resolveInFlight = false;
      }
    }
  }

  private ensureBpmQueue(): void {
    if (!this.viewState.expanded) return;
    if (this.bpmInFlight) return;
    if (!this.tracks.length) return;

    const pending = this.tracks.some((track) => {
      if (!track.streamUrl || !track.cacheKey) return false;
      if (this.bpmByCacheKey.has(track.cacheKey)) return false;
      if (this.bpmMissingKeys.has(track.cacheKey)) return false;
      return true;
    });
    if (!pending) return;

    this.bpmInFlight = true;
    const runId = ++this.bpmRunId;
    void this.runBpmQueue(runId);
  }

  private async runBpmQueue(runId: number): Promise<void> {
    try {
      const beatMode = this.getBeatMode ? this.getBeatMode() : 'auto';

      for (const track of this.tracks) {
        if (runId !== this.bpmRunId) return;
        if (!this.viewState.expanded) return;
        if (!track.streamUrl || !track.cacheKey) continue;
        if (this.bpmByCacheKey.has(track.cacheKey)) continue;
        if (this.bpmMissingKeys.has(track.cacheKey)) continue;

        try {
          const result = await this.sendRuntimeMessage<{ bpm?: number }>({
            type: 'ANALYZE_TRACK_SILENT',
            url: track.streamUrl,
            beatMode,
            cacheKey: track.cacheKey,
          });

          if (runId !== this.bpmRunId) return;
          const bpm = Number(result?.bpm);
          if (Number.isFinite(bpm)) {
            this.bpmByCacheKey.set(track.cacheKey, bpm);
            this.syncViewState(true);
          } else {
            this.bpmMissingKeys.add(track.cacheKey);
          }
        } catch (_) {
          if (runId !== this.bpmRunId) return;
          this.bpmMissingKeys.add(track.cacheKey);
        }
      }
    } finally {
      if (runId === this.bpmRunId) {
        this.bpmInFlight = false;
      }
    }
  }
}

/**
 * Factory for a stateful playlist controller instance.
 */
export function createPlaylistController(options: PlaylistControllerOptions): PlaylistController {
  return new PlaylistController(options);
}
