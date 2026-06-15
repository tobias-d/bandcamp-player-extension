import type { PageGlobals } from '@/shared/types';
import {
  isBandcampReleaseUrl,
  isReleaseContext,
  normalizeUrl,
  readTrackIdFromUrl
} from '@/content/metadata/common';
import {
  getNowPlayingDomReleaseIdentity,
  getNowPlayingStrictDomReleaseIdentity,
  getNowPlayingLinkedReleaseUrl,
  resolveBandIdFromHintsForTralbum,
  type ReleaseIdentity
} from '@/content/metadata/release';
import { releaseKey } from '@/content/metadata/identity';
import {
  clearTriedReleases,
  getCachedAlbumIdentityForReleaseUrl,
  getResolvedIdentityForTrack,
  logProbeState,
  logStrictDomProbeState,
  markTriedRelease,
  pruneTrackScopedState
} from '@/content/metadata/extractor/probe-state';
import {
  extractAlbumIdentityFromTralbum,
  maybeCacheAlbumIdentityForLinkedRelease
} from '@/content/metadata/extractor/parent-album';
import { addDiscoverTrackOnlyCandidate, buildProbeCandidates } from '@/content/metadata/extractor/api/candidates';
import { pickTrackArtistFromTralbum } from '@/content/metadata/extractor/track-artist';
import { getTrackList, tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import {
  API_ENSURE_GLOBAL_INTERVAL_MS,
  API_ENSURE_KEY_INTERVAL_MS,
  API_PROBE_INTERVAL_MS,
  ROOT_PROBE_CANDIDATE_CAP,
  ROOT_PROBE_DOM_PRIORITY_CAP,
  ROOT_PROBE_SETTLE_MS,
  cachedTrackArtistByTrackId,
  ensureNextAllowedAtByKey,
  nextProbeAtByTrackId,
  resolvedIdentityByTrackId,
  triedReleaseKeysByTrackId
} from '@/content/metadata/extractor/state';
import {
  getValidCachedApiEntry,
  maybeProbeTrackArtistForRoot,
  recordFetchGateReason,
  type FetchTralbumForIdentity
} from '@/content/metadata/extractor/api/fetch';
import type { TralbumLike } from '@/content/metadata/extractor/types';
import { maybeExpandToParentAlbum } from '@/content/metadata/extractor/api/parent-album';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import {
  findCachedTrackAlbum,
  findCachedTrackArtist,
  findCachedTrackTitle,
  getCachedApiTralbum,
  resolveCachedTrackMetadata
} from '@/content/metadata/extractor/api/cache';
import { removeTrackMetadataIndexForRelease } from '@/content/metadata/extractor/api/track-index';
import { createRootGuardedFetchTralbum } from '@/content/metadata/extractor/api/fetch-wrapper';
let ensureGlobalNextAllowedAt = 0;
let apiGlobalBackoffUntil = 0;
let globalTralbumFetchInFlight = false;
let lastRootProbeTrackId = '';
let lastRootProbeTrackChangedAtMs = 0;
let activeRootTrackId = '';
let activeRootGeneration = 0;
const DISCOVER_ROOT_PROBE_SETTLE_MS = 250;
const DISCOVER_API_PROBE_INTERVAL_MS = 700;
const DISCOVER_RETRYABLE_ERROR_BACKOFF_MIN_MS = 900;
const DISCOVER_RETRYABLE_ERROR_BACKOFF_MAX_MS = 1600;
const fetchTralbumForIdentity: FetchTralbumForIdentity = createRootGuardedFetchTralbum(
  isCurrentRootTrack,
  isCurrentRootGeneration,
  () => apiGlobalBackoffUntil,
  (nextAllowedAt) => {
    apiGlobalBackoffUntil = Math.max(apiGlobalBackoffUntil, nextAllowedAt);
  }
);
export {
  findCachedTrackAlbum,
  findCachedTrackArtist,
  findCachedTrackTitle,
  getCachedApiTralbum,
  resolveCachedTrackMetadata
} from '@/content/metadata/extractor/api/cache';

export function prewarmTralbumReleaseUrl(releaseUrl: string): ReturnType<FetchTralbumForIdentity> {
  const requestUrl = String(releaseUrl || '').trim();
  if (!requestUrl) {
    return null;
  }
  return fetchTralbumForIdentity(null, requestUrl, '', -1);
}

function hasDiscoverImmediateHints(trackId: string, linkedReleaseUrl: string): boolean {
  if (!window.location.pathname.startsWith('/discover')) {
    return false;
  }
  if (!String(trackId || '').trim()) {
    return false;
  }
  const releaseUrl = String(linkedReleaseUrl || '').trim();
  if (!releaseUrl) {
    return false;
  }
  return /^https?:\/\/[^/]+\/(album|track)\//i.test(releaseUrl);
}

function shouldProbeLinkedReleaseUrlDirectly(input: {
  trackId: string;
  linkedReleaseUrl: string;
  releaseContext: boolean;
  continueAlbumResolution: boolean;
  strictDomIdentity: ReleaseIdentity | null;
}): boolean {
  if (
    input.releaseContext ||
    input.continueAlbumResolution ||
    input.strictDomIdentity ||
    !String(input.trackId || '').trim()
  ) {
    return false;
  }
  const linkedReleaseUrl = String(input.linkedReleaseUrl || '').trim();
  return isBandcampReleaseUrl(linkedReleaseUrl) && /\/(album|track)\//i.test(linkedReleaseUrl);
}

function readTrackStreamUrl(trackRaw: unknown): string {
  if (!trackRaw || typeof trackRaw !== 'object') {
    return '';
  }
  const track = trackRaw as Record<string, unknown>;
  const file = (track.file ?? null) as Record<string, unknown> | null;
  const fromFile = String(file?.['mp3-128'] ?? file?.['mp3-v0'] ?? file?.['mp3-320'] ?? '').trim();
  if (fromFile) {
    return fromFile;
  }
  const streaming = track['streaming_url'] ?? track['streamingUrl'];
  if (typeof streaming === 'string') {
    const raw = streaming.trim();
    if (raw) {
      return raw;
    }
  }
  if (streaming && typeof streaming === 'object') {
    const streamRecord = streaming as Record<string, unknown>;
    const fromStreaming = String(streamRecord['mp3-128'] ?? streamRecord['mp3-v0'] ?? streamRecord['mp3-320'] ?? '').trim();
    if (fromStreaming) {
      return fromStreaming;
    }
  }
  return String(track['stream_url'] ?? track['streamUrl'] ?? '').trim();
}

function hasStrongStreamCoverage(tralbum: unknown): boolean {
  if (!tralbum || typeof tralbum !== 'object') {
    return false;
  }
  const tracks = getTrackList(tralbum as { trackinfo?: Array<Record<string, unknown>>; tracks?: Array<Record<string, unknown>> });
  if (tracks.length <= 1) {
    return false;
  }
  const streamCount = tracks.reduce((count, track) => (readTrackStreamUrl(track).length > 0 ? count + 1 : count), 0);
  const minExpected = Math.min(tracks.length, Math.ceil(tracks.length * 0.6));
  return streamCount >= minExpected;
}

function shouldInvalidateWeakCoverageCache(identity: ReleaseIdentity, tralbum: unknown): boolean {
  if (!tralbum || typeof tralbum !== 'object') {
    return false;
  }
  const tracks = getTrackList(tralbum as { trackinfo?: Array<Record<string, unknown>>; tracks?: Array<Record<string, unknown>> });
  if (identity.tralbumType === 'a' && tracks.length > 0) {
    return false;
  }
  // Only invalidate when payload is effectively track-only. Multi-track releases can
  // legitimately have sparse streams (e.g. unreleased tracks) and should stay cached.
  if (tracks.length > 1) {
    return false;
  }
  return !hasStrongStreamCoverage(tralbum);
}

function invalidateWeakCache(identity: ReleaseIdentity): void {
  const key = releaseKey(identity);
  removeTrackMetadataIndexForRelease(key);
}

function formatStrictDomProbeState(stage: string, identity: ReleaseIdentity, tralbum?: TralbumLike): string {
  const sourceKey = releaseKey(identity);
  const albumIdentity =
    (tralbum ? extractAlbumIdentityFromTralbum(tralbum, identity) : null)
    ?? (identity.tralbumType === 'a' ? identity : null);
  const albumSuffix = albumIdentity ? ` -> album:${releaseKey(albumIdentity)}` : '';
  return `${stage}:${sourceKey}${albumSuffix}`;
}

function getReleaseContextCachedMatch(
  candidates: ReleaseIdentity[],
  trackId: string,
  sourceUrl: string
): { identity: ReleaseIdentity; tralbum: TralbumLike } | null {
  for (const identity of candidates) {
    const cached = getValidCachedApiEntry(identity);
    if (!cached) {
      continue;
    }
    if (!tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl)) {
      continue;
    }
    return {
      identity,
      tralbum: cached.tralbum
    };
  }
  return null;
}

function pickReleaseContextProbeTarget(
  candidates: ReleaseIdentity[],
  trackId: string
): ReleaseIdentity | null {
  if (!candidates.length) {
    return null;
  }
  if (trackId) {
    const exactTrackIdentity = candidates.find(
      (identity) => identity.tralbumType === 't' && identity.tralbumId === trackId
    );
    if (exactTrackIdentity) {
      return exactTrackIdentity;
    }
  }
  return candidates[0] ?? null;
}
export function noteActiveRootTrack(trackId: string): number {
  if (isReleaseContext() || !trackId) {
    return activeRootGeneration;
  }
  if (trackId === activeRootTrackId) {
    return activeRootGeneration;
  }
  activeRootTrackId = trackId;
  activeRootGeneration += 1;
  lastRootProbeTrackId = trackId;
  lastRootProbeTrackChangedAtMs = Date.now();
  pruneTrackScopedState(trackId);
  return activeRootGeneration;
}
export function isCurrentRootTrack(trackId: string): boolean {
  if (isReleaseContext() || !trackId) {
    return true;
  }
  return trackId === activeRootTrackId;
}
export function isCurrentRootGeneration(trackId: string, generation: number): boolean {
  if (isReleaseContext() || !trackId) {
    return true;
  }
  return trackId === activeRootTrackId && generation === activeRootGeneration;
}

export { getValidCachedApiEntry } from '@/content/metadata/extractor/api/fetch';

export function ensureTralbumApiFetch(
  globals: PageGlobals | null,
  currentSrc = '',
  options: { trackArtistProbe?: boolean; intent?: 'metadata' | 'playlist' } = {}
): void {
  const intent = options.intent ?? 'playlist';
  const sourceUrl = currentSrc || getLikelyCurrentSrc();
  const trackId = readTrackIdFromUrl(sourceUrl);
  const rootGeneration = noteActiveRootTrack(trackId);
  if (!isCurrentRootGeneration(trackId, rootGeneration)) {
    logProbeState(trackId, 'root-cutover');
    return;
  }
  const linkedReleaseUrl = getNowPlayingLinkedReleaseUrl();
  const wantsAlbumLinkedRelease = linkedReleaseUrl.includes('/album/');
  let linkedAlbumIdentity = getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl);
  const releaseContext = isReleaseContext();
  const strictDomIdentity = !releaseContext
    ? getNowPlayingStrictDomReleaseIdentity(sourceUrl, linkedReleaseUrl)
    : null;
  const domIdentity = releaseContext
    ? getNowPlayingDomReleaseIdentity(linkedReleaseUrl)
    : strictDomIdentity;
  const activeTrackId = readTrackIdFromUrl(getLikelyCurrentSrc());
  if (!isReleaseContext() && trackId && activeTrackId && activeTrackId !== trackId) {
    logProbeState(trackId, 'root-stale-track');
    return;
  }
  const currentResolved = getResolvedIdentityForTrack(trackId);
  let continueAlbumResolution = false;

  if (!currentResolved) {
    const cachedTralbum = getCachedApiTralbum(globals, sourceUrl);
    if (cachedTralbum && tralbumMatchesCurrentTrack(cachedTralbum, trackId, sourceUrl)) {
      const cachedIdentity = extractAlbumIdentityFromTralbum(cachedTralbum, null);
      if (trackId && cachedIdentity) {
        resolvedIdentityByTrackId.set(trackId, cachedIdentity);
        clearTriedReleases(trackId);
        nextProbeAtByTrackId.delete(trackId);
      }
      const tracks = getTrackList(cachedTralbum);
      let cacheState = 'api-cache-track';
      if (cachedIdentity) {
        cacheState = `api-cache:${releaseKey(cachedIdentity)}`;
      } else if (tracks.length > 1) {
        cacheState = 'api-cache-full-playlist';
      }
      logProbeState(trackId, cacheState);
      return;
    }
  }

  if (currentResolved) {
    const cached = getValidCachedApiEntry(currentResolved);
    if (cached && tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl)) {
      maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, cached.tralbum, currentResolved);
      if (options.trackArtistProbe && currentResolved) {
        maybeProbeTrackArtistForRoot(trackId, linkedReleaseUrl, domIdentity, currentResolved, fetchTralbumForIdentity);
      }
      maybeExpandToParentAlbum(
        trackId,
        sourceUrl,
        linkedReleaseUrl || window.location.href,
        linkedReleaseUrl,
        currentResolved,
        cached.tralbum,
        getValidCachedApiEntry,
        fetchTralbumForIdentity
      );
      const shouldInvalidateWeakCache = shouldInvalidateWeakCoverageCache(currentResolved, cached.tralbum);
      const shouldContinue =
        wantsAlbumLinkedRelease &&
        shouldInvalidateWeakCache;
      if (!shouldContinue) {
        return;
      }
      if (shouldInvalidateWeakCache) {
        invalidateWeakCache(currentResolved);
      }
      continueAlbumResolution = true;
      linkedAlbumIdentity = getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl) ?? linkedAlbumIdentity;
      logProbeState(trackId, `root-track-single:${releaseKey(currentResolved)}`);
    }
    if (cached && !tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl)) {
      resolvedIdentityByTrackId.delete(trackId);
      clearTriedReleases(trackId);
    }
  }

  if (!continueAlbumResolution && strictDomIdentity && trackId) {
    const strictKey = releaseKey(strictDomIdentity);
    const cached = getValidCachedApiEntry(strictDomIdentity);
    if (cached && tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl)) {
      logProbeState(trackId, `strict-dom-cache:${strictKey}`);
      logStrictDomProbeState(trackId, formatStrictDomProbeState('cache', strictDomIdentity, cached.tralbum));
      resolvedIdentityByTrackId.set(trackId, strictDomIdentity);
      maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, cached.tralbum, strictDomIdentity);
      clearTriedReleases(trackId);
      nextProbeAtByTrackId.delete(trackId);
      maybeExpandToParentAlbum(
        trackId,
        sourceUrl,
        linkedReleaseUrl || window.location.href,
        linkedReleaseUrl,
        strictDomIdentity,
        cached.tralbum,
        getValidCachedApiEntry,
        fetchTralbumForIdentity
      );
      return;
    }

    const strictRequestAt = Date.now();
    if (globalTralbumFetchInFlight || strictRequestAt < ensureGlobalNextAllowedAt) {
      return;
    }
    ensureGlobalNextAllowedAt = strictRequestAt + API_ENSURE_GLOBAL_INTERVAL_MS;
    const request = fetchTralbumForIdentity(strictDomIdentity, linkedReleaseUrl || window.location.href, trackId, rootGeneration);
    if (request) {
      globalTralbumFetchInFlight = true;
      void request.finally(() => { globalTralbumFetchInFlight = false; });
      logProbeState(trackId, `strict-dom-request:${strictKey}`);
      logStrictDomProbeState(trackId, formatStrictDomProbeState('request', strictDomIdentity));
      resolvedIdentityByTrackId.set(trackId, strictDomIdentity);
      clearTriedReleases(trackId);
      nextProbeAtByTrackId.delete(trackId);
      void request.then((result) => {
        if (!isCurrentRootGeneration(trackId, rootGeneration)) {
          return;
        }
        if (!result.tralbum) {
          logProbeState(trackId, `strict-dom-empty:${strictKey}`);
          logStrictDomProbeState(trackId, formatStrictDomProbeState('empty', strictDomIdentity));
          resolvedIdentityByTrackId.delete(trackId);
          return;
        }
        if (tralbumMatchesCurrentTrack(result.tralbum, trackId, sourceUrl)) {
          logProbeState(trackId, `strict-dom-ready:${strictKey}`);
          logStrictDomProbeState(trackId, formatStrictDomProbeState('ready', strictDomIdentity, result.tralbum));
          resolvedIdentityByTrackId.set(trackId, strictDomIdentity);
          maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, strictDomIdentity);
          clearTriedReleases(trackId);
          nextProbeAtByTrackId.delete(trackId);
          maybeExpandToParentAlbum(
            trackId,
            sourceUrl,
            linkedReleaseUrl || window.location.href,
            linkedReleaseUrl,
            strictDomIdentity,
            result.tralbum,
            getValidCachedApiEntry,
            fetchTralbumForIdentity
          );
          return;
        }
        logProbeState(trackId, `strict-dom-mismatch:${strictKey}`);
        logStrictDomProbeState(trackId, formatStrictDomProbeState('mismatch', strictDomIdentity));
        resolvedIdentityByTrackId.delete(trackId);
        markTriedRelease(trackId, strictKey);
      });
      return;
    }
  }

  const nowMs = Date.now();
  if (!continueAlbumResolution) {
    if (nowMs < ensureGlobalNextAllowedAt) {
      return;
    }
    ensureGlobalNextAllowedAt = nowMs + API_ENSURE_GLOBAL_INTERVAL_MS;
    const ensureKey = `${trackId || '-'}|${normalizeUrl(sourceUrl)}|${linkedReleaseUrl || '-'}`;
    const nextAllowedAt = ensureNextAllowedAtByKey.get(ensureKey) ?? 0;
    if (nowMs < nextAllowedAt) {
      return;
    }
    ensureNextAllowedAtByKey.set(ensureKey, nowMs + API_ENSURE_KEY_INTERVAL_MS);
    if (ensureNextAllowedAtByKey.size > 500) {
      for (const [key, ts] of ensureNextAllowedAtByKey.entries()) {
        if (nowMs - ts > 2 * 60_000) {
          ensureNextAllowedAtByKey.delete(key);
        }
      }
    }
  }

  const { candidates: probeCandidates } = buildProbeCandidates({
    trackId,
    linkedReleaseUrl,
    globals,
    linkedAlbumIdentity,
    currentResolved,
    continueAlbumResolution,
    domIdentity,
    intent,
    rootProbeCandidateCap: ROOT_PROBE_CANDIDATE_CAP,
    rootProbeDomPriorityCap: ROOT_PROBE_DOM_PRIORITY_CAP
  });
  let candidates = probeCandidates;

  let shouldProbeTrackArtist = true;
  if (trackId && linkedAlbumIdentity) {
    const linkedAlbumCached = getValidCachedApiEntry(linkedAlbumIdentity)?.tralbum ?? null;
    if (linkedAlbumCached) {
      const fromAlbum = pickTrackArtistFromTralbum(linkedAlbumCached, trackId, linkedAlbumIdentity.tralbumId, false);
      if (fromAlbum) {
        cachedTrackArtistByTrackId.set(trackId, {
          artist: fromAlbum.artist,
          source: fromAlbum.source,
          ts: Date.now()
        });
        shouldProbeTrackArtist = false;
      }
    }
  }
  if (shouldProbeTrackArtist && options.trackArtistProbe && currentResolved) {
    maybeProbeTrackArtistForRoot(
      trackId,
      linkedReleaseUrl,
      domIdentity,
      currentResolved,
      fetchTralbumForIdentity
    );
  }

  if (shouldProbeLinkedReleaseUrlDirectly({
    trackId,
    linkedReleaseUrl,
    releaseContext,
    continueAlbumResolution,
    strictDomIdentity
  })) {
    const request = fetchTralbumForIdentity(null, linkedReleaseUrl, trackId, rootGeneration);
    if (request) {
      logProbeState(trackId, `linked-release-url:${linkedReleaseUrl}`);
      void request.then((result) => {
        if (!trackId || !isCurrentRootGeneration(trackId, rootGeneration) || !result.tralbum) {
          return;
        }
        if (!tralbumMatchesCurrentTrack(result.tralbum, trackId, sourceUrl)) {
          logProbeState(trackId, `linked-release-mismatch:${linkedReleaseUrl}`);
          return;
        }
        const linkedIdentity =
          getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl) ??
          extractAlbumIdentityFromTralbum(result.tralbum, null);
        if (linkedIdentity) {
          resolvedIdentityByTrackId.set(trackId, linkedIdentity);
          maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, linkedIdentity);
          clearTriedReleases(trackId);
          nextProbeAtByTrackId.delete(trackId);
          logProbeState(trackId, `linked-release-ready:${releaseKey(linkedIdentity)}`);
          return;
        }
        logProbeState(trackId, 'linked-release-ready:url-only');
      });
      return;
    }
  }

  if (!candidates.length && window.location.pathname.startsWith('/discover') && trackId && linkedReleaseUrl) {
    const hintedBandId = resolveBandIdFromHintsForTralbum(trackId, linkedReleaseUrl);
    candidates = addDiscoverTrackOnlyCandidate(candidates, hintedBandId, trackId);
    if (!candidates.length) {
      const request = fetchTralbumForIdentity(null, linkedReleaseUrl || window.location.href, trackId, rootGeneration);
      if (request) {
        logProbeState(trackId, `discover-release-url:${linkedReleaseUrl}`);
        void request.then((result) => {
          if (!trackId || !isCurrentRootGeneration(trackId, rootGeneration) || !result.tralbum) {
            return;
          }
          // Never lock identity from a release-only hint: require the fetched
          // tralbum to actually contain the current track, matching every other
          // resolution path (and the discover "trust track id over release url" rule).
          if (!tralbumMatchesCurrentTrack(result.tralbum, trackId, sourceUrl)) {
            logProbeState(trackId, `discover-release-mismatch:${linkedReleaseUrl}`);
            return;
          }
          const linkedAlbumIdentity = getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl);
          if (!linkedAlbumIdentity) {
            logProbeState(trackId, 'discover-release-ready:url-only');
            return;
          }
          logProbeState(trackId, `discover-release-ready:${releaseKey(linkedAlbumIdentity)}`);
          resolvedIdentityByTrackId.set(trackId, linkedAlbumIdentity);
          maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, linkedAlbumIdentity);
        });
        return;
      }
    } else if (!isBandcampReleaseUrl(linkedReleaseUrl)) {
      logProbeState(trackId, `discover-track-only:non-bandcamp:${trackId}`);
    } else {
      logProbeState(trackId, `discover-track-only:${trackId}`);
    }
  }

  if (!candidates.length) {
    logProbeState(trackId, 'no-candidates');
    return;
  }

  if (isReleaseContext()) {
    const cachedMatch = getReleaseContextCachedMatch(candidates, trackId, sourceUrl);
    if (cachedMatch && trackId) {
      logProbeState(trackId, `release-target-cached:${releaseKey(cachedMatch.identity)}`);
      resolvedIdentityByTrackId.set(trackId, cachedMatch.identity);
      maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, cachedMatch.tralbum, cachedMatch.identity);
      clearTriedReleases(trackId);
      return;
    }

    const target = pickReleaseContextProbeTarget(candidates, trackId);
    if (!target) {
      logProbeState(trackId, 'release-no-target');
      return;
    }
    logProbeState(trackId, `release-target:${releaseKey(target)}`);
    if (globalTralbumFetchInFlight) {
      logProbeState(trackId, 'global-fetch-in-flight');
      recordFetchGateReason(trackId, 'global-fetch-in-flight');
      return;
    }
    const request = fetchTralbumForIdentity(target, window.location.href, trackId, rootGeneration);
    if (request) {
      globalTralbumFetchInFlight = true;
      void request.finally(() => { globalTralbumFetchInFlight = false; });
      if (trackId) {
        void request.then((result) => {
          if (!isCurrentRootGeneration(trackId, rootGeneration)) {
            return;
          }
          if (result.tralbum && tralbumMatchesCurrentTrack(result.tralbum, trackId, sourceUrl)) {
            resolvedIdentityByTrackId.set(trackId, target);
            maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, target);
            clearTriedReleases(trackId);
          }
        });
      }
    }
    return;
  }

  if (!trackId) {
    logProbeState(trackId, isReleaseContext() ? 'release-no-trackid' : 'root-no-trackid');
    return;
  }

  if (!isReleaseContext()) {
    if (trackId !== lastRootProbeTrackId) {
      lastRootProbeTrackId = trackId;
      lastRootProbeTrackChangedAtMs = Date.now();
    }
  }

  let tried = triedReleaseKeysByTrackId.get(trackId);
  if (!tried) {
    tried = new Set<string>();
    triedReleaseKeysByTrackId.set(trackId, tried);
  }

  for (const identity of candidates) {
    const key = releaseKey(identity);
    if (tried.has(key)) {
      continue;
    }
    const cached = getValidCachedApiEntry(identity);
    if (!cached) {
      continue;
    }
    const shouldInvalidateWeakCache = shouldInvalidateWeakCoverageCache(identity, cached.tralbum);
    if (wantsAlbumLinkedRelease && shouldInvalidateWeakCache) {
      invalidateWeakCache(identity);
      continue;
    }
    if (tralbumMatchesCurrentTrack(cached.tralbum, trackId, sourceUrl)) {
      resolvedIdentityByTrackId.set(trackId, identity);
      maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, cached.tralbum, identity);
      clearTriedReleases(trackId);
      nextProbeAtByTrackId.delete(trackId);
      maybeExpandToParentAlbum(
        trackId,
        sourceUrl,
        linkedReleaseUrl || window.location.href,
        linkedReleaseUrl,
        identity,
        cached.tralbum,
        getValidCachedApiEntry,
        fetchTralbumForIdentity
      );
      return;
    }
    tried.add(key);
  }

  const now = Date.now();
  if (!isReleaseContext() && !continueAlbumResolution) {
    const settleMs = hasDiscoverImmediateHints(trackId, linkedReleaseUrl)
      ? 0
      : window.location.pathname.startsWith('/discover')
      ? DISCOVER_ROOT_PROBE_SETTLE_MS
      : ROOT_PROBE_SETTLE_MS;
    const settleRemaining = settleMs - (now - lastRootProbeTrackChangedAtMs);
    if (settleRemaining > 0) {
      const existing = nextProbeAtByTrackId.get(trackId) ?? 0;
      nextProbeAtByTrackId.set(trackId, Math.max(existing, now + settleRemaining));
      logProbeState(trackId, `probe-settle:${settleRemaining}`);
      return;
    }
  }
  const nextProbeAt = nextProbeAtByTrackId.get(trackId) ?? 0;
  if (now < nextProbeAt) {
    logProbeState(trackId, `probe-wait:${Math.max(0, nextProbeAt - now)}`);
    return;
  }

  const nextTarget = candidates.find((identity) => {
    const key = releaseKey(identity);
    return !tried.has(key);
  });

  if (!nextTarget) {
    logProbeState(trackId, 'probe-exhausted');
    return;
  }

  const targetKey = releaseKey(nextTarget);
  logProbeState(trackId, `probe-target:${targetKey}`);
  if (globalTralbumFetchInFlight) {
    logProbeState(trackId, 'global-fetch-in-flight');
    recordFetchGateReason(trackId, 'global-fetch-in-flight');
    return;
  }
  const probeIntervalMs = window.location.pathname.startsWith('/discover')
    ? DISCOVER_API_PROBE_INTERVAL_MS
    : API_PROBE_INTERVAL_MS;
  nextProbeAtByTrackId.set(trackId, now + probeIntervalMs);
  const request = fetchTralbumForIdentity(nextTarget, linkedReleaseUrl || window.location.href, trackId, rootGeneration);
  if (!request) {
    return;
  }
  globalTralbumFetchInFlight = true;
  void request.finally(() => { globalTralbumFetchInFlight = false; });

  void request.then((result) => {
    if (!isCurrentRootGeneration(trackId, rootGeneration)) {
      return;
    }
    if (!result.tralbum) {
      if (result.retryable) {
        if (trackId) {
          const discoverContext = window.location.pathname.startsWith('/discover');
          const rawRetryAfterMs = Math.max(0, Number(result.retryAfterMs || 0));
          const boundedRetryAfterMs = discoverContext
            ? Math.min(
                DISCOVER_RETRYABLE_ERROR_BACKOFF_MAX_MS,
                Math.max(
                  DISCOVER_RETRYABLE_ERROR_BACKOFF_MIN_MS,
                  rawRetryAfterMs || DISCOVER_RETRYABLE_ERROR_BACKOFF_MIN_MS
                )
              )
            : rawRetryAfterMs;
          if (boundedRetryAfterMs > 0) {
          const now = Date.now();
          const current = nextProbeAtByTrackId.get(trackId) ?? 0;
            nextProbeAtByTrackId.set(trackId, Math.max(current, now + boundedRetryAfterMs));
          }
        }
        return;
      }
      markTriedRelease(trackId, releaseKey(nextTarget));
      return;
    }

    if (tralbumMatchesCurrentTrack(result.tralbum, trackId, sourceUrl)) {
      resolvedIdentityByTrackId.set(trackId, nextTarget);
      maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, nextTarget);
      clearTriedReleases(trackId);
      nextProbeAtByTrackId.delete(trackId);
      maybeExpandToParentAlbum(
        trackId,
        sourceUrl,
        linkedReleaseUrl || window.location.href,
        linkedReleaseUrl,
        nextTarget,
        result.tralbum,
        getValidCachedApiEntry,
        fetchTralbumForIdentity
      );
      return;
    }

    markTriedRelease(trackId, releaseKey(nextTarget));
  });
}
