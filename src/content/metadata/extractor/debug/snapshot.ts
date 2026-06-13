import { getLatestPageGlobals, getRecentApiIdentityHints } from '@/content/discover/origin-bridge';
import { isReleaseContext, readTrackIdFromUrl } from '@/content/metadata/common';
import {
  getNowPlayingDomDebugDetails,
  getNowPlayingDomReleaseIdentity,
  getNowPlayingStrictDomReleaseIdentity,
  getNowPlayingLinkedReleaseUrl,
  type ReleaseIdentity
} from '@/content/metadata/release';
import {
  collectIdLikeHints,
  getFanIdFromGlobals,
  toReleaseIdentity
} from '@/content/metadata/identity';
import {
  getLastProbeStateForTrack,
  getLastStrictDomProbeStateForTrack,
  getResolvedIdentityForTrack
} from '@/content/metadata/extractor/probe-state';
import { getValidCachedApiEntry } from '@/content/metadata/extractor/api/probe';
import { getMetadataPathCountersSnapshot } from '@/content/metadata/extractor/debug/counters';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import { tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import type { TralbumLike } from '@/content/metadata/extractor/types';

function formatIdentity(identity: ReleaseIdentity | null): string {
  if (!identity) {
    return '-';
  }
  return `${identity.bandId}:${identity.tralbumId}:${identity.tralbumType}`;
}

function hasDomTrackMatch(domDetails: string, trackId: string): boolean {
  if (!trackId || !domDetails || domDetails === '-') {
    return false;
  }
  return domDetails.includes(`data-trackid=${trackId}`) || domDetails.includes(`data-track-id=${trackId}`);
}

function buildStrictIdentityDebug(params: {
  sourceUrl: string;
  trackId: string;
  domIdentity: ReleaseIdentity | null;
  domDetails: string;
  primaryIdentity: ReleaseIdentity | null;
  pageTralbum: unknown;
  apiTrackHintCount: number;
  cachedIdentity: string;
  cachedTrackMatch: boolean;
}): string {
  const {
    sourceUrl,
    trackId,
    domIdentity,
    domDetails,
    primaryIdentity,
    pageTralbum,
    apiTrackHintCount,
    cachedIdentity,
    cachedTrackMatch
  } = params;
  const pageTralbumMatch =
    Boolean(pageTralbum && typeof pageTralbum === 'object' && tralbumMatchesCurrentTrack(pageTralbum as TralbumLike, trackId, sourceUrl));
  const domTrackMatch = Boolean(
    domIdentity &&
    (
      (domIdentity.tralbumType === 't' && domIdentity.tralbumId === trackId) ||
      hasDomTrackMatch(domDetails, trackId)
    )
  );
  const domSourceLabel = domDetails.startsWith('strict-track-bound:')
    ? 'DOM.strict-track-bound'
    : 'DOM.data-trackid';
  const apiTrackMatch = apiTrackHintCount > 0;
  const matched =
    pageTralbumMatch
      ? `1 source=TralbumData identity=${formatIdentity(primaryIdentity)}`
      : domTrackMatch
        ? `1 source=${domSourceLabel} identity=${formatIdentity(domIdentity)}`
        : apiTrackMatch
          ? `1 source=API_HINT.trackId identity=-`
          : cachedTrackMatch
            ? `1 source=ApiCache.track identity=${cachedIdentity}`
            : '0 source=- identity=-';

  return [
    `matched=${matched}`,
    `trackId=${trackId || '-'}`,
    `pageTralbum=${pageTralbumMatch ? '1' : '0'}`,
    `dom=${domTrackMatch ? '1' : '0'}`,
    `apiTrackHints=${apiTrackHintCount}`,
    `cache=${cachedTrackMatch ? '1' : '0'}`
  ].join(' ');
}

export function getMetadataDebugSnapshot(currentSrc = ''): {
  trackId: string;
  linkedReleaseUrl: string;
  domIdentity: string;
  domDetails: string;
  strictIdentity: string;
  globals: string;
  candidates: number;
  primaryIdentity: string;
  resolvedIdentity: string;
  cachedIdentity: string;
  keyHints: string;
  bandHints: string;
  itemHints: string;
  typeHints: string;
  apiHintCount: number;
  apiHints: string;
  apiTrackHintCount: number;
  fanId: string;
  apiCandidateStrictAccepted: number;
  apiCandidateRejected: number;
  fallbackUsed: number;
  apiProbeState: string;
  strictApiState: string;
  pathLastDecision: string;
} {
  const sourceUrl = currentSrc || getLikelyCurrentSrc();
  const trackId = readTrackIdFromUrl(sourceUrl);
  const linkedReleaseUrl = getNowPlayingLinkedReleaseUrl();
  const releaseContext = isReleaseContext();
  const strictDomIdentity = !releaseContext
    ? getNowPlayingStrictDomReleaseIdentity(sourceUrl, linkedReleaseUrl)
    : null;
  const domIdentity = releaseContext
    ? getNowPlayingDomReleaseIdentity(linkedReleaseUrl)
    : strictDomIdentity;
  const domDetails = releaseContext
    ? getNowPlayingDomDebugDetails(linkedReleaseUrl)
    : (strictDomIdentity ? `strict-track-bound:${formatIdentity(strictDomIdentity)}` : '-');
  const globals = getLatestPageGlobals();
  const primary = toReleaseIdentity(globals);
  const resolved = getResolvedIdentityForTrack(trackId);
  const candidates = [
    ...(domIdentity ? [domIdentity] : []),
    ...(resolved ? [resolved] : []),
    ...(primary ? [primary] : [])
  ];
  const hints = collectIdLikeHints(globals);
  const apiHints = getRecentApiIdentityHints(5 * 60 * 1000);
  const apiTrackHints = apiHints.filter((hint) => String(hint.trackId ?? '') === trackId);
  const fanId = getFanIdFromGlobals(globals);
  const pathCounters = getMetadataPathCountersSnapshot();
  const strictApiState = getLastStrictDomProbeStateForTrack(trackId);
  const rawApiProbeState = getLastProbeStateForTrack(trackId);
  const resolvedCache = resolved ? getValidCachedApiEntry(resolved) : null;

  let cachedIdentity = '-';
  let cachedTrackMatch = false;
  if (!releaseContext && strictApiState.startsWith('ready:') && resolved && resolvedCache) {
    cachedIdentity = formatIdentity(resolved);
    cachedTrackMatch = tralbumMatchesCurrentTrack(resolvedCache.tralbum, trackId, sourceUrl);
  }
  for (const candidate of candidates) {
    const cached = getValidCachedApiEntry(candidate);
    if (!cached) {
      continue;
    }
    const candidateMatchesTrack = tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl);
    if (candidateMatchesTrack && cachedIdentity === '-') {
      cachedIdentity = formatIdentity(candidate);
      cachedTrackMatch = true;
      break;
    }
    if (cachedIdentity === '-') {
      cachedIdentity = formatIdentity(candidate);
    }
  }

  const globalsSummary = globals
    ? `page=${Boolean(globals.page)} tralbum=${Boolean(globals.tralbum)} band=${Boolean(globals.band)} collection=${Boolean(globals.collection)} wishlist=${Boolean(globals.wishlist)}`
    : 'none';

  return {
    trackId,
    linkedReleaseUrl: linkedReleaseUrl || '-',
    domIdentity: formatIdentity(domIdentity),
    domDetails,
    strictIdentity: buildStrictIdentityDebug({
      sourceUrl,
      trackId,
      domIdentity,
      domDetails,
      primaryIdentity: primary,
      pageTralbum: globals?.tralbum ?? null,
      apiTrackHintCount: apiTrackHints.length,
      cachedIdentity,
      cachedTrackMatch
    }),
    globals: globalsSummary,
    candidates: candidates.length,
    primaryIdentity: formatIdentity(primary),
    resolvedIdentity: formatIdentity(resolved),
    cachedIdentity,
    keyHints: hints.keyHints.join(', ') || '-',
    bandHints: hints.bandHints.join(', ') || '-',
    itemHints: hints.itemHints.join(', ') || '-',
    typeHints: hints.typeHints.join(', ') || '-',
    apiHintCount: apiHints.length,
    apiHints:
      apiHints
        .slice(0, 4)
        .map((hint) => `${hint.bandId}:${hint.tralbumId}:${hint.tralbumType || '-'}`)
        .join(', ') || '-',
    apiTrackHintCount: apiTrackHints.length,
    fanId: fanId || '-',
    apiCandidateStrictAccepted: pathCounters.apiCandidateStrictAccepted,
    apiCandidateRejected: pathCounters.apiCandidateRejected,
    fallbackUsed: pathCounters.fallbackUsed,
    apiProbeState:
      !releaseContext && strictApiState.startsWith('ready:') && resolved
        ? `resolved:${formatIdentity(resolved)}`
        : rawApiProbeState,
    strictApiState,
    pathLastDecision: pathCounters.lastDecision
  };
}
