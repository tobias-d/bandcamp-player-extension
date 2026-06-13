import type { PageGlobals } from '@/shared/types';

export type FanPageSection = 'collection' | 'wishlist';
export type PageOwnership = 'own' | 'foreign' | 'unknown';
export type PageGroup = 'own' | 'foreign' | 'non-fan';
export type LikeMutationContextFamily =
  | 'release-pages'
  | 'recommendations'
  | 'feed'
  | 'discover'
  | 'fan-root'
  | 'non-target';
export type LikeMutationContextVariant =
  | 'album'
  | 'track'
  | 'recommendations'
  | 'feed'
  | 'discover'
  | 'own-collection'
  | 'own-wishlist'
  | 'foreign-collection'
  | 'foreign-wishlist'
  | 'fan-root-unknown'
  | 'non-target';
export type LegacyPageType =
  | 'discover'
  | 'feed'
  | 'recommendations'
  | 'bandcamp-root'
  | 'album'
  | 'track'
  | 'label'
  | 'other';

export type PageMode =
  | 'own-collection'
  | 'own-wishlist'
  | 'foreign-collection'
  | 'foreign-wishlist'
  | LegacyPageType;

export interface PageContext {
  pageType: LegacyPageType;
  mode: PageMode;
  group: PageGroup;
  section: FanPageSection | 'none';
  ownership: PageOwnership;
  fanSlug: string;
  pageFanId: string;
  viewerFanId: string;
  shouldRunPlayerScript: boolean;
  isRootLike: boolean;
  isFanRoot: boolean;
  likeContextFamily: LikeMutationContextFamily;
  likeContextVariant: LikeMutationContextVariant;
}

function toCanonicalUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

function isAlbumTrackPair(a: string, b: string): boolean {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  const leftTrackRightAlbum = left.includes('/track/') && right.includes('/album/');
  const leftAlbumRightTrack = left.includes('/album/') && right.includes('/track/');
  return leftTrackRightAlbum || leftAlbumRightTrack;
}

export function resolveLikeMutationRuntimeContext(
  pageContext: PageContext,
  activeReleaseUrl: string,
  pageUrl = window.location.href
): { family: LikeMutationContextFamily; variant: LikeMutationContextVariant } {
  const base = {
    family: pageContext.likeContextFamily,
    variant: pageContext.likeContextVariant
  };
  if (pageContext.pageType !== 'album' && pageContext.pageType !== 'track') {
    return base;
  }

  if (base.family !== 'release-pages') {
    return base;
  }

  const canonicalPageUrl = toCanonicalUrl(pageUrl);
  const canonicalActiveReleaseUrl = toCanonicalUrl(activeReleaseUrl);
  if (!canonicalPageUrl || !canonicalActiveReleaseUrl) {
    return base;
  }
  if (canonicalPageUrl === canonicalActiveReleaseUrl) {
    return base;
  }
  if (isAlbumTrackPair(canonicalPageUrl, canonicalActiveReleaseUrl)) {
    return base;
  }

  return {
    family: 'recommendations',
    variant: 'recommendations'
  };
}

export function shouldUseApiOnlyLikeIdentity(
  pageContext: Pick<PageContext, 'pageType'>
): boolean {
  const pageType = String(pageContext.pageType || '').trim();
  // Keep release pages on existing behavior; all non-release pages can use API-only identity.
  if (pageType === 'album' || pageType === 'track') {
    return false;
  }
  return true;
}

interface DetectPageContextInput {
  pageGlobals?: PageGlobals | null;
  viewerFanIdHint?: string;
  locationLike?: Pick<Location, 'hostname' | 'pathname' | 'search'>;
}

const RESERVED_FAN_SLUGS = new Set([
  '',
  'discover',
  'feed',
  'recommended',
  'wishlist',
  'collection',
  'cart',
  'music',
  'about',
  'help',
  'login',
  'signup',
  'terms',
  'privacy'
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readNumericId(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const match = raw.match(/\d+/);
  return match?.[0] ?? '';
}

function normalizeSlugCandidate(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  if (/^[a-z0-9_-]+$/.test(raw)) {
    return raw;
  }

  try {
    const parsed = new URL(raw, window.location.href);
    const host = parsed.hostname.toLowerCase();
    if (host === 'bandcamp.com' || host === 'www.bandcamp.com') {
      const fromPath = parsed.pathname.split('/').filter(Boolean)[0] || '';
      return String(fromPath || '').trim().toLowerCase();
    }
    if (host.endsWith('.bandcamp.com') && host !== 'daily.bandcamp.com') {
      return host.slice(0, -'.bandcamp.com'.length).trim().toLowerCase();
    }
  } catch {
    // Ignore malformed URL candidates.
  }

  return '';
}

function readViewerSlugFromWindowContext(): string {
  const globals = window as unknown as Record<string, unknown>;
  const pageData = asRecord(globals['PageData']);
  const identities = asRecord(globals['Identities']);
  let identityFan: Record<string, unknown> | null = null;
  if (identities && typeof identities['fan'] === 'function') {
    try {
      identityFan = asRecord((identities['fan'] as () => unknown)());
    } catch {
      identityFan = null;
    }
  }

  const candidates: unknown[] = [
    pageData?.['viewer_username'],
    pageData?.['viewerUserName'],
    pageData?.['viewer_slug'],
    pageData?.['viewerSlug'],
    pageData?.['viewer_fan_url'],
    pageData?.['viewerFanUrl'],
    pageData?.['viewer_url'],
    pageData?.['viewerUrl'],
    identityFan?.['username'],
    identityFan?.['fan_username'],
    identityFan?.['fanUsername'],
    identityFan?.['fan_url'],
    identityFan?.['fanUrl'],
    identityFan?.['url']
  ];

  for (const candidate of candidates) {
    const normalized = normalizeSlugCandidate(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function readPageFanId(globals: PageGlobals | null | undefined): string {
  const fanRecord = asRecord(globals?.fan ?? null);
  if (fanRecord) {
    const direct = readNumericId(
      fanRecord['fan_id'] ??
        fanRecord['fanId'] ??
        fanRecord['fanid'] ??
        fanRecord['id'] ??
        fanRecord['user_id'] ??
        fanRecord['userId']
    );
    if (direct) {
      return direct;
    }
  }

  const pageRecord = asRecord(globals?.page ?? null);
  if (pageRecord) {
    const fromPage = readNumericId(
      pageRecord['fan_id'] ??
        pageRecord['fanId'] ??
        pageRecord['fanid'] ??
        pageRecord['fan_id_num']
    );
    if (fromPage) {
      return fromPage;
    }
  }

  return '';
}

function readPageFanIdStrict(): string {
  const globals = window as unknown as Record<string, unknown>;
  const pageData = asRecord(globals['PageData']);
  const identities = asRecord(globals['Identities']);
  let identityFan: Record<string, unknown> | null = null;
  if (identities && typeof identities['fan'] === 'function') {
    try {
      identityFan = asRecord((identities['fan'] as () => unknown)());
    } catch {
      identityFan = null;
    }
  }

  const candidates: unknown[] = [
    pageData?.['fan_id'],
    pageData?.['fanId'],
    pageData?.['fanid'],
    pageData?.['page_fan_id'],
    pageData?.['pageFanId'],
    pageData?.['fan_id_num'],
    identityFan?.['fan_id'],
    identityFan?.['fanId'],
    identityFan?.['fanid'],
    identityFan?.['id'],
    identityFan?.['user_id'],
    identityFan?.['userId']
  ];

  for (const candidate of candidates) {
    const normalized = readNumericId(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function readViewerFanIdStrict(): string {
  const globals = window as unknown as Record<string, unknown>;
  const identities = asRecord(globals['Identities']);
  const pageData = asRecord(globals['PageData']);

  const fromIdentities = readNumericId(identities?.['current_fan_id'] ?? identities?.['currentFanId']);
  if (fromIdentities) {
    return fromIdentities;
  }

  const fromPage = readNumericId(pageData?.['viewer_fan_id'] ?? pageData?.['viewerFanId']);
  if (fromPage) {
    return fromPage;
  }

  return '';
}

export function inferFanSlugFromLocation(
  locationLike: Pick<Location, 'hostname' | 'pathname'> = window.location
): string {
  const host = String(locationLike.hostname || '').toLowerCase();
  if (host !== 'bandcamp.com' && host !== 'www.bandcamp.com') {
    return '';
  }
  const parts = String(locationLike.pathname || '').split('/').filter(Boolean);
  const slug = String(parts[0] || '').trim().toLowerCase();
  if (!slug || RESERVED_FAN_SLUGS.has(slug)) {
    return '';
  }
  return slug;
}

function isBandcampRootHost(hostnameRaw: string): boolean {
  const host = String(hostnameRaw || '').toLowerCase();
  return host === 'bandcamp.com' || host === 'www.bandcamp.com';
}

function isBandcampHost(hostnameRaw: string): boolean {
  const host = String(hostnameRaw || '').toLowerCase();
  return host === 'bandcamp.com' || host === 'www.bandcamp.com' || host.endsWith('.bandcamp.com');
}

function isBandcampUtilityPath(pathnameRaw: string): boolean {
  const pathname = String(pathnameRaw || '').toLowerCase();
  return (
    pathname === '/download' ||
    pathname.startsWith('/download/') ||
    pathname === '/lani_d/playlist' ||
    pathname.startsWith('/lani_d/playlist/') ||
    pathname.startsWith('/cart/checkout')
  );
}

function detectLegacyPageType(locationLike: Pick<Location, 'hostname' | 'pathname'>): LegacyPageType {
  const hostname = String(locationLike.hostname || '').toLowerCase();
  const pathname = String(locationLike.pathname || '');

  if (pathname.startsWith('/discover')) {
    return 'discover';
  }

  if (isBandcampRootHost(hostname)) {
    if (isBandcampUtilityPath(pathname)) {
      return 'other';
    }
    if (pathname.includes('/feed')) {
      return 'feed';
    }
    if (pathname.includes('/recommended')) {
      return 'recommendations';
    }
    return 'bandcamp-root';
  }

  if (pathname.includes('/album/')) {
    return 'album';
  }

  if (pathname.includes('/track/')) {
    return 'track';
  }

  if (pathname.includes('/music')) {
    return 'label';
  }

  return 'other';
}

function detectFanSection(
  locationLike: Pick<Location, 'pathname' | 'search'>,
  fanSlug: string
): FanPageSection | 'none' {
  if (!fanSlug) {
    return 'none';
  }

  const path = String(locationLike.pathname || '').toLowerCase();
  if (path.includes('/wishlist')) {
    return 'wishlist';
  }
  if (path.includes('/collection')) {
    return 'collection';
  }

  const search = String(locationLike.search || '').toLowerCase();
  if (/[?&](tab|view|section)=wishlist(?:&|$)/.test(search)) {
    return 'wishlist';
  }
  if (/[?&](tab|view|section)=collection(?:&|$)/.test(search)) {
    return 'collection';
  }

  // Fan root defaults to collection when section cannot be inferred from URL.
  return 'collection';
}

export function detectPageContext(input: DetectPageContextInput = {}): PageContext {
  const locationLike = input.locationLike ?? window.location;
  const hostname = String(locationLike.hostname || '').toLowerCase();
  const pathname = String(locationLike.pathname || '');
  const pageType = detectLegacyPageType(locationLike);
  const fanSlug = inferFanSlugFromLocation(locationLike);
  const isFanRoot = pageType === 'bandcamp-root' && Boolean(fanSlug);
  const section = detectFanSection(locationLike, fanSlug);
  const pageFanId = readPageFanId(input.pageGlobals) || readPageFanIdStrict();
  const viewerFanId = readViewerFanIdStrict() || readNumericId(input.viewerFanIdHint);
  const viewerSlug = readViewerSlugFromWindowContext();

  let ownership: PageOwnership = 'unknown';
  if (isFanRoot) {
    if (viewerFanId && pageFanId) {
      ownership = viewerFanId === pageFanId ? 'own' : 'foreign';
    } else if (viewerSlug && fanSlug) {
      ownership = viewerSlug === fanSlug ? 'own' : 'foreign';
    }
  }

  const group: PageGroup = ownership === 'own' ? 'own' : ownership === 'foreign' ? 'foreign' : 'non-fan';
  const mode: PageMode = isFanRoot
    ? ownership === 'own'
      ? section === 'wishlist'
        ? 'own-wishlist'
        : 'own-collection'
      : ownership === 'foreign'
        ? section === 'wishlist'
          ? 'foreign-wishlist'
          : 'foreign-collection'
        : pageType
    : pageType;

  const shouldRunPlayerScript = !(
    hostname === 'daily.bandcamp.com' ||
    (isBandcampHost(hostname) && isBandcampUtilityPath(pathname)) ||
    (isBandcampRootHost(hostname) &&
      (pathname === '/' || pathname === '/discover' || pathname.startsWith('/discover/')))
  );

  const likeContext = (() => {
    if (isFanRoot) {
      if (mode === 'own-collection' || mode === 'own-wishlist' || mode === 'foreign-collection' || mode === 'foreign-wishlist') {
        return {
          family: 'fan-root' as LikeMutationContextFamily,
          variant: mode as LikeMutationContextVariant
        };
      }
      return {
        family: 'fan-root' as LikeMutationContextFamily,
        variant: 'fan-root-unknown' as LikeMutationContextVariant
      };
    }
    if (pageType === 'discover') {
      return {
        family: 'discover' as LikeMutationContextFamily,
        variant: 'discover' as LikeMutationContextVariant
      };
    }
    if (pageType === 'feed') {
      return {
        family: 'feed' as LikeMutationContextFamily,
        variant: 'feed' as LikeMutationContextVariant
      };
    }
    if (pageType === 'recommendations') {
      return {
        family: 'recommendations' as LikeMutationContextFamily,
        variant: 'recommendations' as LikeMutationContextVariant
      };
    }
    if (pageType === 'album') {
      return {
        family: 'release-pages' as LikeMutationContextFamily,
        variant: 'album' as LikeMutationContextVariant
      };
    }
    if (pageType === 'track') {
      return {
        family: 'release-pages' as LikeMutationContextFamily,
        variant: 'track' as LikeMutationContextVariant
      };
    }
    return {
      family: 'non-target' as LikeMutationContextFamily,
      variant: 'non-target' as LikeMutationContextVariant
    };
  })();

  return {
    pageType,
    mode,
    group,
    section,
    ownership,
    fanSlug,
    pageFanId,
    viewerFanId,
    shouldRunPlayerScript,
    isRootLike: pageType === 'bandcamp-root' || pageType === 'feed' || pageType === 'recommendations',
    isFanRoot,
    likeContextFamily: likeContext.family,
    likeContextVariant: likeContext.variant
  };
}
