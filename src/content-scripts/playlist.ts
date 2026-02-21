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
  artist?: string;
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

interface CachedLinkedPlaylist {
  trackinfo: BandcampTrackInfo[];
  artist: string;
  ts: number;
}

interface InternalPlaylistTrack {
  index: number;
  title: string;
  artist: string;
  durationSec: number;
  trackId: string;
  streamUrl: string;
  pageUrl: string;
  cacheKey: string;
  isPlayingHint: boolean;
}

const EXTERNAL_PLAYLIST_AUDIO_ID = '__bc_playlist_external_audio__';
const PLAYLIST_EXPANDED_PREF_KEY = '__BC_BPM_PLAYLIST_EXPANDED__';
const LINKED_PLAYLIST_CACHE_TTL_MS = 15 * 60 * 1000;
const LINKED_PLAYLIST_MIN_FETCH_INTERVAL_MS = 2500;
const LINKED_PLAYLIST_MAX_FETCHES_PER_MIN = 8;
const LINKED_PLAYLIST_BACKOFF_MS = 10 * 60 * 1000;
let selectedPlaybackRunId = 0;

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

function canonicalReleaseUrl(raw: string): string {
  const normalized = normalizeUrl(raw);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return normalized;
  }
}

function extractTrackIdFromSrc(src: string): string {
  const value = String(src || '');
  const pathMatch = value.match(/\/(\d+)(?:\?|$)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const queryMatch = value.match(/[?&](?:track_id|id)=(\d+)(?:&|$)/i);
  return queryMatch?.[1] || '';
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

function readPlaylistExpandedPref(): boolean {
  try {
    const raw = localStorage.getItem(PLAYLIST_EXPANDED_PREF_KEY);
    if (raw == null) return true;
    return raw === '1';
  } catch (_) {
    return true;
  }
}

function writePlaylistExpandedPref(expanded: boolean): void {
  try {
    localStorage.setItem(PLAYLIST_EXPANDED_PREF_KEY, expanded ? '1' : '0');
  } catch (_) {
    // Ignore storage write failures.
  }
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

function getNowPlayingTitleFromDom(): string {
  const selectors = [
    '.play_status .track-title',
    '.play_status .title',
    '#footer-player .track-title',
    '#footer-player .title',
    '.playing_track .track-title',
    '.playing_track .title',
    '.playback-controls .track-title',
    '.playback-controls .title',
    '.bc-player .track-title',
    '.bc-player .title',
    '.player .track-title',
    '.player .title',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const title = norm(el?.textContent || '');
    if (title) return title;
  }
  return '';
}

function getNowPlayingArtistFromDom(): string {
  const selectors = [
    '.play_status .artist',
    '.play_status .by',
    '#footer-player .artist',
    '#footer-player .by',
    '.playing_track .artist',
    '.playing_track .by',
    '.playback-controls .artist',
    '.playback-controls .by',
    '.bc-player .artist',
    '.bc-player .by',
    '.player .artist',
    '.player .by',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const artist = norm(el?.textContent || '').replace(/^by\s+/i, '');
    if (artist) return artist;
  }
  return '';
}

function slugifyBandcampName(input: string): string {
  return norm(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseArtistTitle(rawTitle: string): { artist: string; title: string } {
  const v = norm(rawTitle);
  if (!v) return { artist: '', title: '' };
  const sep = v.match(/^(.+?)\s+[—–-]\s+(.+)$/);
  if (sep) {
    return { artist: norm(sep[1]), title: norm(sep[2]) };
  }
  return { artist: '', title: v };
}

function hostMatchesArtistHint(rawUrl: string, artistHints: string[]): boolean {
  if (!artistHints.length) return false;
  const url = normalizeUrl(rawUrl);
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    const sub = host.split('.')[0] || '';
    if (!sub) return false;
    return artistHints.some((hint) => hint && (sub === hint || sub.includes(hint) || hint.includes(sub)));
  } catch {
    return false;
  }
}

function getBestGlobalBandcampLink(nowPlayingTitle: string, nowPlayingArtist: string): string {
  const parsed = parseArtistTitle(nowPlayingTitle);
  const effectiveTitle = norm(parsed.title || nowPlayingTitle);
  const effectiveArtist = norm(nowPlayingArtist || parsed.artist);
  const titleSlug = slugifyBandcampName(effectiveTitle);
  const titleNorm = normalizeCmpText(effectiveTitle);
  const artistHints = [slugifyBandcampName(effectiveArtist)].filter(Boolean);
  if (!titleSlug && !titleNorm && !artistHints.length) return '';

  const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  let bestUrl = '';
  let bestScore = -1;

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    if (!isBandcampTrackOrAlbumUrl(href)) continue;
    const absolute = normalizeUrl(href);
    if (!absolute) continue;

    let score = 0;
    try {
      const parsedUrl = new URL(absolute);
      const pathLower = parsedUrl.pathname.toLowerCase();
      if (titleSlug && pathLower.includes(titleSlug)) score += 6;
      if (artistHints.length && hostMatchesArtistHint(absolute, artistHints)) score += 4;
    } catch {
      // Ignore URL parse errors.
    }

    const anchorText = normalizeCmpText(anchor.textContent || '');
    const containerText = normalizeCmpText(
      anchor.closest('article, li, .collection-item, .track_row, .trackrow, tr.track_row_view, .playing_track')?.textContent || ''
    );
    if (titleNorm) {
      if (anchorText && (anchorText === titleNorm || anchorText.includes(titleNorm) || titleNorm.includes(anchorText))) {
        score += 3;
      }
      if (
        containerText &&
        (containerText === titleNorm || containerText.includes(titleNorm) || titleNorm.includes(containerText))
      ) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestUrl = absolute;
    }
  }

  return bestScore >= 5 ? bestUrl : '';
}

function getLinkedUrlFromEmbedIframes(nowPlayingTitle: string, nowPlayingArtist: string): string {
  const titleSlug = slugifyBandcampName(nowPlayingTitle);
  const artistHints = [slugifyBandcampName(nowPlayingArtist)].filter(Boolean);
  const frames = Array.from(document.querySelectorAll('iframe[src]')) as HTMLIFrameElement[];
  for (const frame of frames) {
    const rawSrc = frame.getAttribute('src') || '';
    const src = normalizeUrl(rawSrc);
    if (!src) continue;
    const lower = src.toLowerCase();
    if (!lower.includes('bandcamp.com')) continue;
    if (!/embeddedplayer|player/.test(lower)) continue;

    const decoded = decodeURIComponent(src);
    const directMatch = decoded.match(/https?:\/\/[^"'\s]+\/(?:album|track)\/[^"'\s?]+/i);
    if (directMatch?.[0]) {
      const candidate = normalizeUrl(directMatch[0]);
      if (candidate && isBandcampTrackOrAlbumUrl(candidate)) {
        if (!artistHints.length || hostMatchesArtistHint(candidate, artistHints)) {
          if (!titleSlug || candidate.toLowerCase().includes(titleSlug)) return candidate;
        }
      }
    }
  }
  return '';
}

function getLinkedUrlFromLocalTralbum(tralbum: BandcampTralbumData | null, nowPlayingTitle: string): string {
  const trackinfo = Array.isArray(tralbum?.trackinfo) ? tralbum!.trackinfo! : [];
  if (!trackinfo.length) return '';

  const nowTitle = normalizeCmpText(nowPlayingTitle || tralbum?.current?.title || '');
  let candidate: BandcampTrackInfo | null = null;

  if (nowTitle) {
    candidate =
      trackinfo.find((track) => normalizeCmpText(track?.title || '') === nowTitle) ||
      trackinfo.find((track) => {
        const title = normalizeCmpText(track?.title || '');
        return Boolean(title) && (title.includes(nowTitle) || nowTitle.includes(title));
      }) ||
      null;
  }

  if (!candidate) {
    candidate = trackinfo.find((track) => Boolean(track?.is_playing)) || trackinfo[0] || null;
  }

  const pageUrl = candidate ? getTrackPageUrl(candidate) : '';
  if (!isBandcampTrackOrAlbumUrl(pageUrl)) return '';
  return normalizeUrl(pageUrl);
}

function anchorMatchesNowTitle(anchor: HTMLAnchorElement, nowTitleNorm: string, artistHints: string[]): boolean {
  const href = anchor.getAttribute('href') || anchor.href || '';
  if (!nowTitleNorm) {
    return hostMatchesArtistHint(href, artistHints);
  }
  const textCandidates = [
    norm(anchor.textContent || ''),
    norm(anchor.getAttribute('title') || ''),
    norm(anchor.closest('.track_row, .trackrow, tr.track_row_view, .playing_track, .collection-item, article, li')?.textContent || ''),
  ];
  for (const text of textCandidates) {
    const cmp = normalizeCmpText(text);
    if (!cmp) continue;
    if (cmp === nowTitleNorm || cmp.includes(nowTitleNorm) || nowTitleNorm.includes(cmp)) {
      if (!artistHints.length || hostMatchesArtistHint(href, artistHints)) return true;
    }
  }
  // Title not found near anchor text; allow host-based artist hint as fallback.
  return hostMatchesArtistHint(href, artistHints);
}

function getCollectionPlayerLinkedUrl(nowPlayingTitle = '', nowPlayingArtist = ''): string {
  const directCollectionNowPlayingSelectors = [
    '.collection-item-container.playing a.item-link[href]',
    '.collection-item-container.track_play_hilite.playing a.item-link[href]',
    '.collection-item-container.track_play_hilite a.item-link[href]',
    '.collection-item-container.playing a[href*="/album/"]',
    '.collection-item-container.track_play_hilite.playing a[href*="/album/"]',
    '.collection-item-container.track_play_hilite a[href*="/album/"]',
    '.collection-item-container.playing a[href*="/track/"]',
    '.collection-item-container.track_play_hilite.playing a[href*="/track/"]',
    '.collection-item-container.track_play_hilite a[href*="/track/"]',
  ];
  for (const selector of directCollectionNowPlayingSelectors) {
    const anchor = document.querySelector(selector) as HTMLAnchorElement | null;
    if (!anchor) continue;
    const href = anchor.getAttribute('href') || '';
    if (!isBandcampTrackOrAlbumUrl(href)) continue;
    const normalized = normalizeUrl(href);
    if (normalized) return normalized;
  }

  const nowTitleNorm = normalizeCmpText(nowPlayingTitle);
  const artistHints = [slugifyBandcampName(nowPlayingArtist)].filter(Boolean);
  const directSelectors = [
    '.play_status .track-title a[href]',
    '.play_status .title a[href]',
    '.play_status .fromAlbum a[href]',
    '.collection-player .track-title a[href]',
    '.collection-player .fromAlbum a[href]',
    '#collection-player .track-title a[href]',
    '#collection-player .fromAlbum a[href]',
    '#track_play_waypoint a[href]',
    '#footer-player a[href*="/album/"]',
    '#footer-player a[href*="/track/"]',
    '.playing_track a[href*="/album/"]',
    '.playing_track a[href*="/track/"]',
    '.playback-controls a[href*="/album/"]',
    '.playback-controls a[href*="/track/"]',
    '.bc-player a[href*="/album/"]',
    '.bc-player a[href*="/track/"]',
    '.story.playing a.item-link[href*="/album/"]',
    '.story.playing a.item-link[href*="/track/"]',
    '.story-innards.playing a.item-link[href*="/album/"]',
    '.story-innards.playing a.item-link[href*="/track/"]',
    '.track_play_hilite.playing a.item-link[href*="/album/"]',
    '.track_play_hilite.playing a.item-link[href*="/track/"]',
    '.track_play_hilite a.item-link[href*="/album/"]',
    '.track_play_hilite a.item-link[href*="/track/"]',
  ];

  for (const selector of directSelectors) {
    const anchor = document.querySelector(selector) as HTMLAnchorElement | null;
    if (!anchor) continue;
    if (!anchorMatchesNowTitle(anchor, nowTitleNorm, artistHints)) continue;
    const href = anchor.getAttribute('href') || '';
    if (!isBandcampTrackOrAlbumUrl(href)) continue;
    const normalized = normalizeUrl(href);
    if (normalized) return normalized;
  }

  const roots = [
    '.play_status',
    '.collection-player',
    '#collection-player',
    '#track_play_waypoint',
    '#footer-player',
    '.playing_track',
    '.playback-controls',
    '.bc-player',
    '.player',
    '.story.playing',
    '.story-innards.playing',
    '.track_play_hilite.playing',
    '.story-list',
    'li.story.fp',
  ];
  for (const rootSelector of roots) {
    const root = document.querySelector(rootSelector);
    if (!root) continue;
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      if (!anchorMatchesNowTitle(anchor, nowTitleNorm, artistHints)) continue;
      const href = anchor.getAttribute('href') || '';
      if (!isBandcampTrackOrAlbumUrl(href)) continue;
      const normalized = normalizeUrl(href);
      if (normalized) return normalized;
    }
  }

  const activeRoots = Array.from(
    document.querySelectorAll(
      [
        '.track_play_waypoint.playing',
        '.waypoint.track_play_waypoint.playing',
        '.waypoint.playing',
        '.track_play_hilite.playing',
        '.story.playing',
        '.story-innards.playing',
        '[class*="recommend"][class*="playing"]',
        '[class*="recommend"] .playing',
        '[class*="related"] .playing',
      ].join(', ')
    )
  ) as HTMLElement[];

  for (const root of activeRoots) {
    const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (!isBandcampTrackOrAlbumUrl(href)) continue;
      if (!anchorMatchesNowTitle(anchor, nowTitleNorm, artistHints)) continue;
      const normalized = normalizeUrl(href);
      if (normalized) return normalized;
    }
  }

  return getBestGlobalBandcampLink(nowPlayingTitle, nowPlayingArtist);
}

function toInternalTracks(trackinfo: BandcampTrackInfo[]): InternalPlaylistTrack[] {
  const out: InternalPlaylistTrack[] = [];
  for (let i = 0; i < trackinfo.length; i += 1) {
    const track = trackinfo[i] || {};
    const trackId = norm(String(track?.track_id ?? track?.id ?? ''));
    const artist = norm(track?.artist || '');
    const streamUrl = pickTrackFileUrl(track?.file);
    const pageUrl = getTrackPageUrl(track);
    const durationSec = Number(track?.duration);
    const title = norm(track?.title) || `Track ${i + 1}`;

    out.push({
      index: i,
      title,
      artist,
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

function trackinfoContainsCurrentSource(trackinfo: BandcampTrackInfo[], currentAudioSrc: string): boolean {
  if (!Array.isArray(trackinfo) || !trackinfo.length) return false;
  const currentTrackId = extractTrackIdFromSrc(currentAudioSrc);
  const normalizedCurrent = normalizeUrl(currentAudioSrc);

  if (currentTrackId) {
    const byId = trackinfo.some((track) => {
      const trackId = norm(String(track?.track_id ?? track?.id ?? ''));
      return Boolean(trackId) && trackId === currentTrackId;
    });
    if (byId) return true;
  }

  if (normalizedCurrent) {
    const byUrl = trackinfo.some((track) => {
      const streamUrl = pickTrackFileUrl(track?.file);
      return Boolean(streamUrl) && streamUrl === normalizedCurrent;
    });
    if (byUrl) return true;
  }

  return false;
}

function hasActiveRecommendationPlaybackContext(): boolean {
  const selectors = [
    '#recommendations_container .album-art-container.playing',
    '.recs-section .album-art-container.playing',
    '.recommended-album .album-art-container.playing',
    '.story.playing',
    '.story-innards.playing',
    '.track_play_hilite.playing',
    '.track_play_waypoint.playing',
    '.waypoint.track_play_waypoint.playing',
    '.waypoint.playing',
    '[class*="recommend"][class*="playing"]',
    '[class*="related"][class*="playing"]',
  ];
  return selectors.some((selector) => Boolean(document.querySelector(selector)));
}

function hasRecommendationSectionContext(): boolean {
  const selectors = ['#recommendations_container', '.recs-section', '.recommendations-container', '.bc-recs'];
  return selectors.some((selector) => Boolean(document.querySelector(selector)));
}

function isElementInIfYouLikeSection(element: Element | null): boolean {
  let node: Element | null = element;
  let depth = 0;
  while (node && depth < 8) {
    const text = normalizeCmpText(node.textContent || '');
    if (text.includes('you may also like') || text.includes('if you like')) {
      return true;
    }
    node = node.parentElement;
    depth += 1;
  }
  return false;
}

function getPlayingRecommendationListItem(): HTMLElement | null {
  const active = document.querySelector(
    '#recommendations_container .album-art-container.playing, .recs-section .album-art-container.playing, .recommended-album .album-art-container.playing'
  ) as HTMLElement | null;
  if (!active) return null;
  return active.closest('li.recommended-album, li[class*="recommended"]') as HTMLElement | null;
}

function getBandcampLinkFromRecommendationItem(item: Element | null): string {
  if (!item) return '';
  const selectors = ['a[href*="/album/"]', 'a[href*="/track/"]', 'a[href]'];
  for (const selector of selectors) {
    const anchors = Array.from(item.querySelectorAll(selector)) as HTMLAnchorElement[];
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || '';
      if (!isBandcampTrackOrAlbumUrl(href)) continue;
      const normalized = normalizeUrl(href);
      if (normalized) return normalized;
    }
  }
  return '';
}

function getLinkedUrlFromIfYouLikeSection(nowPlayingTitle = '', nowPlayingArtist = ''): string {
  const titleNorm = normalizeCmpText(nowPlayingTitle);
  const artistNorm = normalizeCmpText(nowPlayingArtist);
  const activeItem = getPlayingRecommendationListItem();
  const activeUrl = getBandcampLinkFromRecommendationItem(activeItem);
  if (activeUrl) return activeUrl;
  if (!titleNorm && !artistNorm) return '';

  const recommendedItems = Array.from(
    document.querySelectorAll('#recommendations_container li.recommended-album, .recs-section li.recommended-album, li.recommended-album')
  ) as HTMLElement[];
  for (const item of recommendedItems) {
    if (!isElementInIfYouLikeSection(item)) continue;
    const itemText = normalizeCmpText(item.textContent || '');
    if (!itemText) continue;
    const titleMatches = titleNorm && (itemText.includes(titleNorm) || titleNorm.includes(itemText));
    const artistMatches = artistNorm && (itemText.includes(artistNorm) || artistNorm.includes(itemText));
    if (!titleMatches && !artistMatches) continue;
    const url = getBandcampLinkFromRecommendationItem(item);
    if (url) return url;
  }

  const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || '';
    if (!isBandcampTrackOrAlbumUrl(href)) continue;
    if (!isElementInIfYouLikeSection(anchor)) continue;

    const textNorm = normalizeCmpText(anchor.textContent || '');
    if (!textNorm) continue;

    const titleMatches = titleNorm && (textNorm.includes(titleNorm) || titleNorm.includes(textNorm));
    const artistMatches = artistNorm && (textNorm.includes(artistNorm) || artistNorm.includes(textNorm));
    if (!titleMatches && !artistMatches) continue;

    const normalized = normalizeUrl(href);
    if (normalized) return normalized;
  }

  return '';
}

function shouldResolveLinkedPlaylist(localTrackinfo: BandcampTrackInfo[], currentAudioSrc: string): boolean {
  if (localTrackinfo.length <= 1) return true;
  const normalizedSrc = normalizeUrl(currentAudioSrc);
  if (!normalizedSrc) return false;
  if (trackinfoContainsCurrentSource(localTrackinfo, normalizedSrc)) return false;
  if (hasActiveRecommendationPlaybackContext()) return true;
  if (hasRecommendationSectionContext()) return true;
  return false;
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

function getExternalPlaylistAudio(): HTMLAudioElement | null {
  const el = document.getElementById(EXTERNAL_PLAYLIST_AUDIO_ID);
  return el instanceof HTMLAudioElement ? el : null;
}

function ensureExternalPlaylistAudio(): HTMLAudioElement {
  const existing = getExternalPlaylistAudio();
  if (existing) return existing;

  const audio = document.createElement('audio');
  audio.id = EXTERNAL_PLAYLIST_AUDIO_ID;
  audio.preload = 'auto';
  audio.style.display = 'none';
  audio.setAttribute('data-bc-playlist-external', '1');
  (document.body || document.documentElement).appendChild(audio);
  return audio;
}

function stopExternalPlaylistAudio(): void {
  const audio = getExternalPlaylistAudio();
  if (!audio) return;
  pauseAudioSafe(audio);
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
  const runId = ++selectedPlaybackRunId;
  const maxRetries = preferImmediateFallback ? 6 : 12;
  const retryMs = preferImmediateFallback ? 70 : 120;
  const fallbackAttempt = preferImmediateFallback ? 4 : maxRetries;
  let attempt = 0;
  const normalizedTarget = normalizeUrl(targetStreamUrl);
  let fallbackTriggered = false;

  const tick = () => {
    if (runId !== selectedPlaybackRunId) return;
    attempt += 1;
    const targetAudio = normalizedTarget ? findAudioByStreamUrl(normalizedTarget) : null;

    if (targetAudio) {
      tryPlayAudio(targetAudio);
      if (attempt < maxRetries && targetAudio.paused) {
        setTimeout(() => {
          if (runId !== selectedPlaybackRunId) return;
          tick();
        }, retryMs);
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
        setTimeout(() => {
          if (runId !== selectedPlaybackRunId) return;
          tick();
        }, retryMs);
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
        setTimeout(() => {
          if (runId !== selectedPlaybackRunId) return;
          tick();
        }, retryMs);
      }
      return;
    }

    tryPlayAudio(active);

    if (attempt < maxRetries && active.paused) {
      setTimeout(() => {
        if (runId !== selectedPlaybackRunId) return;
        tick();
      }, retryMs);
    }
  };

  setTimeout(() => {
    if (runId !== selectedPlaybackRunId) return;
    tick();
  }, 0);
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

function playViaExternalAudioSource(streamUrl: string): boolean {
  const normalized = normalizeUrl(streamUrl);
  if (!normalized) return false;

  const audio = ensureExternalPlaylistAudio();
  if (!audio) return false;

  const audios = getAudioElements();
  for (const el of audios) {
    if (el === audio) continue;
    pauseAudioSafe(el);
  }

  const currentSrc = normalizeUrl(audio.currentSrc || audio.src || '');
  if (currentSrc !== normalized) {
    try {
      audio.src = normalized;
      audio.load();
    } catch {
      return false;
    }
  }

  tryPlayAudio(audio);
  return true;
}

function syncBandcampUiPausedState(): void {
  const playingIndicators = [
    '.track_play_waypoint.playing',
    '.waypoint.track_play_waypoint.playing',
    '.track_row.playing',
    '.trackrow.playing',
    'tr.track_row_view.playing',
    '.playbutton.playing',
    '.playbutton.pause',
    '.play_status.playing',
  ];

  for (const selector of playingIndicators) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    const pauseTarget =
      (el.closest('.story, .story-innards, .track_row, .trackrow, tr.track_row_view') as HTMLElement | null) || el;
    if (clickTrackContainer(pauseTarget)) return;
  }

  // Last resort: global play button toggle if present.
  clickGlobalPrevNext(0);
}

class PlaylistController {
  private readonly sendRuntimeMessage: <T = any>(message: any) => Promise<T>;
  private readonly onChange: (() => void) | null;
  private readonly getBeatMode: (() => BeatMode) | null;

  private tracks: InternalPlaylistTrack[] = [];
  private viewState: PlaylistState = {
    tracks: [],
    currentIndex: -1,
    expanded: readPlaylistExpandedPref(),
    loading: false,
  };

  private bpmByCacheKey = new Map<string, number>();
  private bpmMissingKeys = new Set<string>();
  private currentAudioSrc = '';
  private currentTrackTitleHint = '';
  private currentArtistHint = '';
  private externalPlaylistMode = false;
  private externalPlaylistArtistHint = '';
  private nativeTrackId = '';
  private lastLocationHref = '';
  private resolveRunId = 0;
  private resolveInFlight = false;
  private lastRetryResolveAt = 0;
  private linkedPlaylistCache = new Map<string, CachedLinkedPlaylist>();
  private linkedFetchTimestamps: number[] = [];
  private linkedFetchBackoffUntil = 0;
  private lastLinkedFetchAt = 0;
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

  getDisplayMetadata(): { artistName: string; trackTitle: string; combined: string } | null {
    if (!this.externalPlaylistMode || !this.tracks.length) return null;
    const index = getCurrentTrackIndex(this.tracks, this.currentAudioSrc);
    if (index < 0) return null;
    const track = this.tracks[index];
    if (!track) return null;

    const trackTitle = norm(track.title);
    const artistName = norm(track.artist || this.externalPlaylistArtistHint || this.currentArtistHint);
    if (!trackTitle && !artistName) return null;

    const combined =
      artistName && trackTitle ? `${artistName} — ${trackTitle}` : trackTitle || artistName || this.currentTrackTitleHint || '---';
    return { artistName, trackTitle, combined };
  }

  refresh(currentAudioSrc: string, currentTrackBpm?: number, currentTrackTitle?: string, currentArtist?: string): void {
    const nextSrc = normalizeUrl(currentAudioSrc);
    const locationHref = window.location.href;
    const srcChanged = nextSrc !== this.currentAudioSrc;
    const locationChanged = locationHref !== this.lastLocationHref;
    this.currentAudioSrc = nextSrc;
    this.currentTrackTitleHint = norm(currentTrackTitle || '');
    this.currentArtistHint = norm(currentArtist || '');
    this.lastLocationHref = locationHref;

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
      if (currentIndex < 0 && this.currentAudioSrc) {
        // Current source is outside the loaded playlist: clear stale rows immediately.
        this.tracks = [];
        this.viewState = {
          ...this.viewState,
          tracks: [],
          currentIndex: -1,
          loading: true,
        };
        this.notifyChange();

        const now = Date.now();
        if (now - this.lastRetryResolveAt >= 1500) {
          this.lastRetryResolveAt = now;
          if (this.resolveInFlight) {
            // Invalidate the previous run so only the newest source can populate the list.
            this.resolveRunId += 1;
            this.resolveInFlight = false;
          }
          void this.resolvePlaylist();
        }
      }
      return;
    }

    if (this.resolveInFlight) {
      // Only invalidate an in-flight run if the source context actually changed.
      // Otherwise let the active resolve finish to avoid loading loops.
      if (srcChanged || locationChanged) {
        this.resolveRunId += 1;
        this.resolveInFlight = false;
      } else {
        return;
      }
    }
    // Clear stale rows immediately when switching to a source that requires
    // playlist re-resolution, so old playlist content is not shown while loading.
    this.tracks = [];
    this.viewState = {
      ...this.viewState,
      tracks: [],
      currentIndex: -1,
      loading: true,
    };
    this.notifyChange();
    void this.resolvePlaylist();
  }

  toggleExpanded(): void {
    const nextExpanded = !this.viewState.expanded;
    this.viewState = {
      ...this.viewState,
      expanded: nextExpanded,
    };
    writePlaylistExpandedPref(nextExpanded);
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

    if (this.externalPlaylistMode) {
      // In external playlist mode we fully decouple from page controls.
      // Always route track selection through the dedicated external audio.
      const played = playViaExternalAudioSource(track.streamUrl);
      if (played) {
        return true;
      }
      return false;
    }

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

  jumpRelative(direction: number): boolean {
    if (!this.tracks.length) return false;
    if (this.tracks.length < 2) return false;
    const currentIndex = getCurrentTrackIndex(this.tracks, this.currentAudioSrc);
    if (currentIndex < 0) return false;
    const base = currentIndex;
    const nextIndex = (base + (direction > 0 ? 1 : -1) + this.tracks.length) % this.tracks.length;
    return this.jumpToTrack(nextIndex);
  }

  private notifyChange(): void {
    if (typeof this.onChange === 'function') {
      this.onChange();
    }
  }

  private canFetchLinkedPlaylist(now: number): boolean {
    if (now < this.linkedFetchBackoffUntil) return false;
    if (now - this.lastLinkedFetchAt < LINKED_PLAYLIST_MIN_FETCH_INTERVAL_MS) return false;
    this.linkedFetchTimestamps = this.linkedFetchTimestamps.filter((ts) => now - ts <= 60_000);
    if (this.linkedFetchTimestamps.length >= LINKED_PLAYLIST_MAX_FETCHES_PER_MIN) return false;
    return true;
  }

  private async fetchLinkedPlaylistWithGuards(
    linkedUrl: string
  ): Promise<{ trackinfo: BandcampTrackInfo[]; artist: string } | null> {
    const now = Date.now();
    const cacheKey = canonicalReleaseUrl(linkedUrl) || normalizeUrl(linkedUrl);
    if (!cacheKey) return null;

    const cached = this.linkedPlaylistCache.get(cacheKey);
    if (cached && now - cached.ts <= LINKED_PLAYLIST_CACHE_TTL_MS) {
      return {
        trackinfo: cached.trackinfo,
        artist: cached.artist,
      };
    }

    if (!this.canFetchLinkedPlaylist(now)) {
      return null;
    }

    this.lastLinkedFetchAt = now;
    this.linkedFetchTimestamps.push(now);

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
      const fetchedArtist = norm(response?.tralbum?.artist);

      if (fetchedTrackinfo.length > 0) {
        this.linkedPlaylistCache.set(cacheKey, {
          trackinfo: fetchedTrackinfo,
          artist: fetchedArtist,
          ts: Date.now(),
        });
        return {
          trackinfo: fetchedTrackinfo,
          artist: fetchedArtist,
        };
      }

      // Short negative cache to avoid hammering same URL.
      this.linkedPlaylistCache.set(cacheKey, {
        trackinfo: [],
        artist: fetchedArtist,
        ts: Date.now() - (LINKED_PLAYLIST_CACHE_TTL_MS - 60_000),
      });
      return null;
    } catch (error: any) {
      const msg = String(error?.message || error || '');
      if (/429|403|fetch failed:\s*(429|403)/i.test(msg)) {
        this.linkedFetchBackoffUntil = Date.now() + LINKED_PLAYLIST_BACKOFF_MS;
      }
      return null;
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
      const localTrackinfo = Array.isArray(localTralbum?.trackinfo) ? localTralbum!.trackinfo! : [];
      let trackinfo = localTrackinfo;
      let resolvedFromLinkedSource = false;
      let resolvedArtistHint = this.currentArtistHint || norm(localTralbum?.artist);

      const nowPlayingTitle =
        getNowPlayingTitleFromDom() ||
        this.currentTrackTitleHint ||
        norm(localTralbum?.current?.title) ||
        norm(localTralbum?.trackinfo?.[0]?.title);
      const nowPlayingArtist = getNowPlayingArtistFromDom() || this.currentArtistHint || norm(localTralbum?.artist);
      const shouldTryLinked =
        shouldResolveLinkedPlaylist(localTrackinfo, this.currentAudioSrc) ||
        (!trackinfoContainsCurrentSource(localTrackinfo, this.currentAudioSrc) &&
          Boolean(getLinkedUrlFromIfYouLikeSection(nowPlayingTitle, nowPlayingArtist)));

      if (shouldTryLinked) {
        const recommendationContext = hasActiveRecommendationPlaybackContext();
        const linkedUrl = recommendationContext
          ? getLinkedUrlFromIfYouLikeSection(nowPlayingTitle, nowPlayingArtist) ||
            getCollectionPlayerLinkedUrl(nowPlayingTitle, nowPlayingArtist) ||
            getLinkedUrlFromEmbedIframes(nowPlayingTitle, nowPlayingArtist) ||
            getLinkedUrlFromLocalTralbum(localTralbum, nowPlayingTitle)
          : getLinkedUrlFromLocalTralbum(localTralbum, nowPlayingTitle) ||
            getLinkedUrlFromIfYouLikeSection(nowPlayingTitle, nowPlayingArtist) ||
            getCollectionPlayerLinkedUrl(nowPlayingTitle, nowPlayingArtist) ||
            getLinkedUrlFromEmbedIframes(nowPlayingTitle, nowPlayingArtist);
        if (linkedUrl) {
          const fetched = await this.fetchLinkedPlaylistWithGuards(linkedUrl);
          if (fetched?.trackinfo?.length) {
            trackinfo = fetched.trackinfo;
            resolvedFromLinkedSource = true;
            resolvedArtistHint = fetched.artist || resolvedArtistHint;
          }
        }
      }

      if (runId !== this.resolveRunId) return;

      this.externalPlaylistMode = resolvedFromLinkedSource;
      this.externalPlaylistArtistHint = resolvedFromLinkedSource ? resolvedArtistHint : '';
      this.nativeTrackId =
        extractTrackIdFromSrc(this.currentAudioSrc) ||
        norm(String(localTralbum?.trackinfo?.[0]?.track_id ?? localTralbum?.trackinfo?.[0]?.id ?? ''));

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
