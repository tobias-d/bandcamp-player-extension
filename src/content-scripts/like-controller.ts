export type TrackLikeSource = 'track' | 'album' | 'none';

export interface LikeState {
  albumLiked: boolean;
  trackLiked: boolean;
  trackLikedEffective: boolean;
  trackLikeSource: TrackLikeSource;
  canToggleAlbumLike: boolean;
  canToggleTrackLike: boolean;
}

interface LikeControllerOptions {
  getCurrentSrc: () => string;
  findCurrentTrackRow: () => HTMLElement | null;
  scheduleRender: () => void;
  norm: (s: string | null | undefined) => string;
}

interface LikeController {
  getLikeState: () => LikeState;
  toggleAlbumLike: () => void;
  toggleTrackLike: () => void;
  init: () => void;
}

const ALBUM_LIKE_SELECTORS = [
  '.fav-album',
  '.fav_album',
  '.tralbumData .fav',
  '.trackInfo .fav',
  '.buyItemExtra .fav',
  '[data-bind*="toggle_album_favorite"]',
  '[data-bind*="toggle_favorite_album"]',
  '[data-bind*="album_favorite"]',
  '[aria-label*="album" i][aria-label*="wish" i]',
  '[title*="album" i][title*="wish" i]',
];

const TRACK_LIKE_SELECTORS = [
  '.fav-track',
  '.fav_track',
  '.track_fav',
  '[data-bind*="toggle_track_favorite"]',
  '[data-bind*="toggle_favorite_track"]',
  '[data-bind*="fav_track"]',
  '[data-bind*="track_favorite"]',
  '[aria-label*="track" i][aria-label*="wish" i]',
  '[title*="track" i][title*="wish" i]',
];

const GENERIC_LIKE_SELECTORS = [
  '[data-bind*="favorite"]',
  '[data-bind*="wishlist"]',
  '[aria-label*="wishlist" i]',
  '[title*="wishlist" i]',
  '.fav',
];

export function createLikeController(options: LikeControllerOptions): LikeController {
  let likeInteractionBound = false;
  const likeFallbackByKey = new Map<string, { albumLiked?: boolean; trackLiked?: boolean }>();

  function isElementVisible(el: Element | null): el is HTMLElement {
    if (!el || !(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textBlob(el: Element | null): string {
    if (!el) return '';
    const attrs = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-bind'),
      el.getAttribute('class'),
    ]
      .map((x) => options.norm(x))
      .filter(Boolean);
    const txt = options.norm(el.textContent);
    return `${attrs.join(' ')} ${txt}`.toLowerCase();
  }

  function readLikeFromControl(el: Element | null): boolean | null {
    if (!el) return null;

    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed === 'true') return true;
    if (ariaPressed === 'false') return false;

    const classes = options.norm(el.getAttribute('class')).toLowerCase();
    if (/\b(liked|hearted|favorited|faved|is-on|is-active|is-liked)\b/.test(classes)) return true;
    if (/\b(unliked|not-favorited|is-off)\b/.test(classes)) return false;
    if (/\bfav\b/.test(classes) && /\bon\b/.test(classes)) return true;

    const blob = textBlob(el);
    if (/remove[^a-z]+from[^a-z]+wishlist|wishlisted|in[^a-z]+collection|unfavorite/.test(blob)) return true;
    if (/add[^a-z]+to[^a-z]+wishlist|wishlist[^a-z]+this|favorite[^a-z]+this/.test(blob)) return false;

    return null;
  }

  function findFirstLikeControl(root: ParentNode, selectors: string[]): HTMLElement | null {
    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector));
      for (const candidate of candidates) {
        if (isElementVisible(candidate)) return candidate;
      }
    }
    return null;
  }

  function findAnyLikeControl(root: ParentNode, selectors: string[]): HTMLElement | null {
    for (const selector of selectors) {
      const candidates = Array.from(root.querySelectorAll(selector));
      for (const candidate of candidates) {
        if (candidate instanceof HTMLElement) return candidate;
      }
    }
    return null;
  }

  function getLikeEventPath(event: Event): Element[] {
    const pathFn = (event as any).composedPath;
    if (typeof pathFn === 'function') {
      const raw = pathFn.call(event);
      return Array.isArray(raw) ? raw.filter((x): x is Element => x instanceof Element) : [];
    }
    const target = event.target instanceof Element ? event.target : null;
    const out: Element[] = [];
    let cur: Element | null = target;
    let hops = 0;
    while (cur && hops < 8) {
      out.push(cur);
      cur = cur.parentElement;
      hops += 1;
    }
    return out;
  }

  function isLikeInteractionPath(path: Element[]): boolean {
    const selector = [...ALBUM_LIKE_SELECTORS, ...TRACK_LIKE_SELECTORS, ...GENERIC_LIKE_SELECTORS].join(',');
    for (const el of path) {
      if (el.matches(selector) || el.closest(selector)) return true;
    }
    return false;
  }

  function classifyLikePath(path: Element[]): 'album' | 'track' | 'unknown' {
    const albumSelector = ALBUM_LIKE_SELECTORS.join(',');
    const trackSelector = TRACK_LIKE_SELECTORS.join(',');
    const row = options.findCurrentTrackRow();
    for (const el of path) {
      if (el.matches(trackSelector) || el.closest(trackSelector)) return 'track';
      if (el.matches(albumSelector) || el.closest(albumSelector)) return 'album';
      if (row && row.contains(el)) return 'track';
    }
    return 'unknown';
  }

  function toClickableControl(el: HTMLElement | null): HTMLElement | null {
    if (!el) return null;

    const bind = options.norm(el.getAttribute('data-bind')).toLowerCase();
    const cls = options.norm(el.getAttribute('class')).toLowerCase();
    if (/\b(click|favorite|wishlist|fav)\b/.test(bind) || /\b(fav|favorite|wishlist|heart)\b/.test(cls)) {
      return el;
    }

    const selfInteractive = el.matches('button, a, input, [role="button"]');
    if (selfInteractive) return el;

    const nestedInteractive = el.querySelector('button, a, input, [role="button"]') as HTMLElement | null;
    if (nestedInteractive) return nestedInteractive;

    return null;
  }

  function getAlbumLikeKey(): string {
    return `album:${window.location.origin}${window.location.pathname}`;
  }

  function getTrackLikeKey(): string {
    const src = options.norm(options.getCurrentSrc());
    if (src) return `track:${src}`;
    return `track:${window.location.origin}${window.location.pathname}`;
  }

  function extractDataAttribute(selector: string, attr: string): any | null {
    const element = document.querySelector(selector);
    if (!element) return null;

    const raw = element.getAttribute(attr);
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readBoolKey(obj: any, keys: string[]): boolean | null {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of keys) {
      if (typeof obj[key] === 'boolean') return obj[key];
      if (obj[key] === 1) return true;
      if (obj[key] === 0) return false;
    }
    return null;
  }

  function readAlbumLikeFromTralbumData(): boolean | null {
    const tralbum = extractDataAttribute('script[data-tralbum]', 'data-tralbum');
    if (!tralbum) return null;

    const top = readBoolKey(tralbum, ['is_favorite', 'is_favorited', 'is_favourited', 'is_wishlisted', 'fav']);
    if (typeof top === 'boolean') return top;

    const current = readBoolKey(tralbum.current, [
      'is_favorite',
      'is_favorited',
      'is_favourited',
      'is_wishlisted',
      'fav',
    ]);
    if (typeof current === 'boolean') return current;

    return null;
  }

  function mergeLikeFallbackState(patch: { albumLiked?: boolean; trackLiked?: boolean }): void {
    const albumKey = getAlbumLikeKey();
    const trackKey = getTrackLikeKey();

    if (typeof patch.albumLiked === 'boolean') {
      const next = { ...(likeFallbackByKey.get(albumKey) || {}), albumLiked: patch.albumLiked };
      likeFallbackByKey.set(albumKey, next);
    }

    if (typeof patch.trackLiked === 'boolean') {
      const next = { ...(likeFallbackByKey.get(trackKey) || {}), trackLiked: patch.trackLiked };
      likeFallbackByKey.set(trackKey, next);
    }
  }

  function getCurrentTrackContexts(): HTMLElement[] {
    const contexts: HTMLElement[] = [];
    const currentRow = options.findCurrentTrackRow();
    if (currentRow) contexts.push(currentRow);

    const trackSelectors = ['.inline_player', '.inlineplayer', '.collection-player', '#collection-player'];
    for (const selector of trackSelectors) {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el && !contexts.includes(el)) contexts.push(el);
    }
    return contexts;
  }

  function findTrackLikeControlInRow(row: HTMLElement, includeHidden = false): HTMLElement | null {
    const finder = includeHidden ? findAnyLikeControl : findFirstLikeControl;
    const direct = finder(row, TRACK_LIKE_SELECTORS);
    if (direct) return direct;

    const generic = finder(row, GENERIC_LIKE_SELECTORS);
    if (generic) {
      const blob = textBlob(generic);
      if (!/\balbum\b/.test(blob)) return generic;
    }

    return null;
  }

  function findTrackLikeControl(): HTMLElement | null {
    const contexts = getCurrentTrackContexts();
    for (const context of contexts) {
      const control = findTrackLikeControlInRow(context, false);
      if (control) return control;
    }
    return findFirstLikeControl(document, TRACK_LIKE_SELECTORS);
  }

  function findTrackLikeControlAny(): HTMLElement | null {
    const contexts = getCurrentTrackContexts();
    for (const context of contexts) {
      const control = findTrackLikeControlInRow(context, true);
      if (control) return control;
    }
    return findAnyLikeControl(document, TRACK_LIKE_SELECTORS);
  }

  function findAlbumLikeControl(): HTMLElement | null {
    const direct = findFirstLikeControl(document, ALBUM_LIKE_SELECTORS);
    if (direct) return direct;

    const headerAreas = ['#name-section', '#band-name-location', '#tralbumArt', '#tralbumData', '.trackInfo'];
    for (const selector of headerAreas) {
      const area = document.querySelector(selector);
      if (!area) continue;
      const fallback = findFirstLikeControl(area, GENERIC_LIKE_SELECTORS);
      if (fallback) return fallback;
    }

    return null;
  }

  function findAlbumLikeControlAny(): HTMLElement | null {
    const direct = findAnyLikeControl(document, ALBUM_LIKE_SELECTORS);
    if (direct) return direct;

    const headerAreas = ['#name-section', '#band-name-location', '#tralbumArt', '#tralbumData', '.trackInfo'];
    for (const selector of headerAreas) {
      const area = document.querySelector(selector);
      if (!area) continue;
      const fallback = findAnyLikeControl(area, GENERIC_LIKE_SELECTORS);
      if (fallback) return fallback;
    }

    return null;
  }

  function getLikeState(): LikeState {
    const albumControlVisible = findAlbumLikeControl();
    const trackControlVisible = findTrackLikeControl();
    const albumControlAny = findAlbumLikeControlAny();
    const trackControlAny = findTrackLikeControlAny();
    const currentTrackRow = options.findCurrentTrackRow();
    const fallbackAlbum = likeFallbackByKey.get(getAlbumLikeKey());
    const fallbackTrack = likeFallbackByKey.get(getTrackLikeKey());

    const albumObservedDom = readLikeFromControl(albumControlVisible || albumControlAny);
    const albumObservedData = readAlbumLikeFromTralbumData();
    const albumObserved = typeof albumObservedDom === 'boolean' ? albumObservedDom : albumObservedData;
    const trackObserved = readLikeFromControl(trackControlVisible || trackControlAny);

    const albumLiked =
      typeof fallbackAlbum?.albumLiked === 'boolean'
        ? fallbackAlbum.albumLiked
        : typeof albumObserved === 'boolean'
        ? albumObserved
        : false;

    const trackLiked =
      typeof trackObserved === 'boolean'
        ? trackObserved
        : typeof fallbackTrack?.trackLiked === 'boolean'
        ? fallbackTrack.trackLiked
        : false;

    const trackLikedEffective = albumLiked || trackLiked;
    const trackLikeSource: TrackLikeSource = trackLiked ? 'track' : albumLiked ? 'album' : 'none';

    return {
      albumLiked,
      trackLiked,
      trackLikedEffective,
      trackLikeSource,
      canToggleAlbumLike: Boolean(albumControlVisible || albumControlAny),
      canToggleTrackLike: Boolean(trackControlVisible || trackControlAny || currentTrackRow),
    };
  }

  function clickLikeControl(control: HTMLElement | null): boolean {
    const target = toClickableControl(control);
    if (!target || typeof target.click !== 'function') return false;
    try {
      target.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function scheduleLikeRefresh(): void {
    options.scheduleRender();
    setTimeout(() => options.scheduleRender(), 150);
    setTimeout(() => options.scheduleRender(), 600);
  }

  function toggleAlbumLike(): void {
    const before = getLikeState();
    const control = findAlbumLikeControl();
    if (!clickLikeControl(control)) return;
    mergeLikeFallbackState({ albumLiked: !before.albumLiked });
    scheduleLikeRefresh();
  }

  function toggleTrackLike(): void {
    let control = findTrackLikeControl();

    if (!control) {
      const row = options.findCurrentTrackRow();
      if (row) {
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        control = findTrackLikeControl();
      }
    }

    if (!control) {
      const row = options.findCurrentTrackRow();
      if (row) {
        control = findTrackLikeControlInRow(row, true);
      }
    }

    if (clickLikeControl(control)) {
      const before = getLikeState();
      mergeLikeFallbackState({ trackLiked: !before.trackLiked });
      scheduleLikeRefresh();
      return;
    }

    const row = options.findCurrentTrackRow();
    if (row) {
      setTimeout(() => {
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        const delayed = findTrackLikeControlInRow(row, true) || findTrackLikeControlAny();
        if (!clickLikeControl(delayed)) return;
        const before = getLikeState();
        mergeLikeFallbackState({ trackLiked: !before.trackLiked });
        scheduleLikeRefresh();
      }, 80);
      return;
    }

    scheduleLikeRefresh();
  }

  function init(): void {
    if (likeInteractionBound) return;
    likeInteractionBound = true;

    document.addEventListener(
      'click',
      (event) => {
        const path = getLikeEventPath(event);
        if (!isLikeInteractionPath(path)) return;
        const before = getLikeState();
        const kind = classifyLikePath(path);
        if (kind === 'album') {
          mergeLikeFallbackState({ albumLiked: !before.albumLiked });
        } else if (kind === 'track') {
          mergeLikeFallbackState({ trackLiked: !before.trackLiked });
        }
        scheduleLikeRefresh();
      },
      true
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const path = getLikeEventPath(event);
        if (!isLikeInteractionPath(path)) return;
        const before = getLikeState();
        const kind = classifyLikePath(path);
        if (kind === 'album') {
          mergeLikeFallbackState({ albumLiked: !before.albumLiked });
        } else if (kind === 'track') {
          mergeLikeFallbackState({ trackLiked: !before.trackLiked });
        }
        scheduleLikeRefresh();
      },
      true
    );
  }

  return {
    getLikeState,
    toggleAlbumLike,
    toggleTrackLike,
    init,
  };
}
