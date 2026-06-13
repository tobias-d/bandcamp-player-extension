import type { FetchTralbumRequest, TralbumFetchResponse } from '@/shared/types';
import {
  describePayloadShape,
  firstNonEmpty,
  isReleaseContext,
  normalizeReleaseUrl,
  readTrackIdFromUrl
} from '@/content/metadata/common';
import type { ReleaseIdentity } from '@/content/metadata/release';
import { releaseKey } from '@/content/metadata/identity';
import {
  extractAlbumIdentityFromTralbum,
  maybeCacheAlbumIdentityForLinkedRelease
} from '@/content/metadata/extractor/parent-album';
import { readCachedTrackArtist } from '@/content/metadata/extractor/artist-helpers';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import { normalizeApiPayload } from '@/content/metadata/extractor/api/payload';
import {
  removeTrackMetadataIndexForRelease,
  upsertTrackMetadataIndexForRelease
} from '@/content/metadata/extractor/api/track-index';
import { pickTrackArtistFromTralbum } from '@/content/metadata/extractor/track-artist';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';
import type {
  ApiCacheEntry,
  FetchIdentityResult
} from '@/content/metadata/extractor/types';
import {
  API_CACHE_TTL_MS,
  API_ERROR_BACKOFF_MS,
  API_LOCAL_LIMIT_BACKOFF_MS,
  API_MIN_REQUEST_INTERVAL_MS,
  API_RATE_BACKOFF_MS,
  TRACK_ARTIST_PROBE_INTERVAL_MS,
  apiBackoffUntilByRelease,
  apiCacheByRelease,
  apiInFlightByRelease,
  apiLastAttemptByRelease,
  cachedTrackArtistByTrackId,
  trackArtistNextProbeAtByTrackId,
  trackArtistProbeInFlightByTrackId,
  warnedUnexpectedPayloadByRelease
} from '@/content/metadata/extractor/state';
import { sendMessage } from '@/utils/messaging';
import { createLogger } from '@/utils/debug';

const logger = createLogger('METADATA');
const fetchGateByTrackId = new Map<string, { reason: string; releaseKey: string; at: number; remainingMs: number }>();
const DISCOVER_BACKOFF_CAP_MS = 4_000;

function isDiscoverContext(): boolean {
  return window.location.pathname.startsWith('/discover');
}

function capBackoffMsForContext(ms: number): number {
  if (!isDiscoverContext()) {
    return ms;
  }
  return Math.min(Math.max(0, ms), DISCOVER_BACKOFF_CAP_MS);
}

function recordFetchGate(trackId: string, releaseKeyValue: string, reason: string, remainingMs = 0): void {
  const key = String(trackId || '').trim();
  if (!key) {
    return;
  }
  fetchGateByTrackId.set(key, {
    reason,
    releaseKey: releaseKeyValue,
    at: Date.now(),
    remainingMs: Math.max(0, Math.round(remainingMs))
  });
  if (fetchGateByTrackId.size > 300) {
    const now = Date.now();
    for (const [track, value] of fetchGateByTrackId.entries()) {
      if (now - value.at > 2 * 60_000) {
        fetchGateByTrackId.delete(track);
      }
    }
  }
}

export function recordFetchGateReason(trackId: string, reason: string): void {
  recordFetchGate(trackId, '', reason, 0);
}

export function getTrackFetchGateDebug(trackId: string): string {
  const key = String(trackId || '').trim();
  if (!key) {
    return 'track=-';
  }
  const gate = fetchGateByTrackId.get(key);
  if (!gate) {
    return 'track=no-gate';
  }
  const ageMs = Math.max(0, Date.now() - gate.at);
  return `reason=${gate.reason} release=${gate.releaseKey || '-'} remain=${gate.remainingMs}ms age=${ageMs}ms`;
}

export type FetchTralbumForIdentity = (
  identity: ReleaseIdentity | null,
  requestUrl?: string,
  currentTrackId?: string,
  rootGeneration?: number
) => Promise<FetchIdentityResult> | null;

type FetchTralbumOptions = {
  requestUrl?: string;
  currentTrackId?: string;
  rootGeneration?: number;
  allowHtmlFallback?: boolean;
  isCurrentRootTrack: (trackId: string) => boolean;
  isCurrentRootGeneration: (trackId: string, generation: number) => boolean;
  getApiGlobalBackoffUntil: () => number;
  setApiGlobalBackoffUntil: (ts: number) => void;
};

function hasConcreteIdentity(identity: ReleaseIdentity | null | undefined): identity is ReleaseIdentity {
  return Boolean(
    identity &&
    String(identity.bandId || '').trim() &&
    String(identity.tralbumId || '').trim()
  );
}

function buildFetchCacheKey(identity: ReleaseIdentity | null | undefined, requestUrl: string): string {
  if (hasConcreteIdentity(identity)) {
    return releaseKey(identity);
  }
  const normalizedRequestUrl = normalizeReleaseUrl(requestUrl) || String(requestUrl || '').trim();
  return normalizedRequestUrl ? `url:${normalizedRequestUrl}` : '';
}

function cacheFetchedTralbum(
  key: string,
  tralbum: NonNullable<ReturnType<typeof normalizeApiPayload>>,
  requestUrl: string,
  identity: ReleaseIdentity | null
): void {
  const ts = Date.now();
  apiCacheByRelease.set(key, {
    releaseKey: key,
    tralbum,
    ts
  });
  upsertTrackMetadataIndexForRelease(key, tralbum, ts);

  const normalizedReleaseUrl = normalizeReleaseUrl(requestUrl);
  const baseIdentity = hasConcreteIdentity(identity) ? identity : null;
  if (normalizedReleaseUrl) {
    maybeCacheAlbumIdentityForLinkedRelease(normalizedReleaseUrl, tralbum, baseIdentity);
  }

  const albumIdentity = extractAlbumIdentityFromTralbum(tralbum, baseIdentity);
  const tracks = getTrackList(tralbum);
  const cacheIdentity =
    baseIdentity && baseIdentity.tralbumType === 'a'
      ? baseIdentity
      : baseIdentity?.tralbumType === 't' && tracks.length <= 1
      ? null
      : albumIdentity;
  if (!cacheIdentity) {
    return;
  }

  const cacheKey = releaseKey(cacheIdentity);
  if (!cacheKey || cacheKey === key) {
    return;
  }
  apiCacheByRelease.set(cacheKey, {
    releaseKey: cacheKey,
    tralbum,
    ts
  });
  upsertTrackMetadataIndexForRelease(cacheKey, tralbum, ts);
}

export function getValidCachedApiEntry(identity: ReleaseIdentity): ApiCacheEntry | null {
  const key = releaseKey(identity);
  const entry = apiCacheByRelease.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > API_CACHE_TTL_MS) {
    removeTrackMetadataIndexForRelease(key);
    return null;
  }
  return entry;
}

export function getValidCachedApiEntryForRequestUrl(requestUrl: string): ApiCacheEntry | null {
  const key = buildFetchCacheKey(null, requestUrl);
  if (!key) {
    return null;
  }
  const entry = apiCacheByRelease.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > API_CACHE_TTL_MS) {
    removeTrackMetadataIndexForRelease(key);
    return null;
  }
  return entry;
}

export function fetchTralbumForIdentity(
  identity: ReleaseIdentity | null,
  {
    requestUrl = '',
    currentTrackId = '',
    rootGeneration = -1,
    allowHtmlFallback = false,
    isCurrentRootTrack,
    isCurrentRootGeneration,
    getApiGlobalBackoffUntil,
    setApiGlobalBackoffUntil
  }: FetchTralbumOptions
): Promise<FetchIdentityResult> | null {
  const trackKey = String(currentTrackId || '').trim();
  const requestKey = buildFetchCacheKey(identity, requestUrl);
  if (currentTrackId && rootGeneration >= 0 && !isCurrentRootGeneration(currentTrackId, rootGeneration)) {
    recordFetchGate(trackKey, requestKey || '-', 'stale-generation', 0);
    return null;
  }
  if (currentTrackId && !isCurrentRootTrack(currentTrackId)) {
    recordFetchGate(trackKey, requestKey || '-', 'stale-track', 0);
    return null;
  }
  const key = requestKey;
  if (!key) {
    recordFetchGate(trackKey, '-', 'missing-request-key', 0);
    return null;
  }
  const now = Date.now();
  const globalBackoffUntil = getApiGlobalBackoffUntil();
  if (now < globalBackoffUntil) {
    const globalRemainingMs = globalBackoffUntil - now;
    if (!isDiscoverContext() || globalRemainingMs <= DISCOVER_BACKOFF_CAP_MS) {
      recordFetchGate(trackKey, key, 'global-backoff', globalRemainingMs);
      return null;
    }
    // Discover can jump rapidly between unrelated releases; do not let a long
    // global backoff from earlier failures starve new tracks for many seconds.
    recordFetchGate(trackKey, key, 'global-backoff-bypass', globalRemainingMs);
  }
  const cached = hasConcreteIdentity(identity) ? getValidCachedApiEntry(identity) : null;
  if (cached) {
    recordFetchGate(trackKey, key, 'cache-hit', 0);
    return Promise.resolve({ tralbum: cached.tralbum, retryable: false });
  }

  const existing = apiInFlightByRelease.get(key);
  if (existing) {
    recordFetchGate(trackKey, key, 'in-flight', 0);
    return existing;
  }

  const backoffUntil = apiBackoffUntilByRelease.get(key) ?? 0;
  if (now < backoffUntil) {
    const releaseRemainingMs = backoffUntil - now;
    if (!isDiscoverContext() || releaseRemainingMs <= DISCOVER_BACKOFF_CAP_MS) {
      recordFetchGate(trackKey, key, 'release-backoff', releaseRemainingMs);
      return null;
    }
    // Same rule as global backoff: cap long per-release suppression in Discover.
    recordFetchGate(trackKey, key, 'release-backoff-bypass', releaseRemainingMs);
  }

  const lastAttempt = apiLastAttemptByRelease.get(key) ?? 0;
  if (now - lastAttempt < API_MIN_REQUEST_INTERVAL_MS) {
    recordFetchGate(trackKey, key, 'min-interval', API_MIN_REQUEST_INTERVAL_MS - (now - lastAttempt));
    return null;
  }
  apiLastAttemptByRelease.set(key, now);
  recordFetchGate(trackKey, key, 'request-start', 0);

  const request: FetchTralbumRequest = {
    type: 'FETCH_TRALBUM',
    url: requestUrl || window.location.href,
    bandId: identity?.bandId || '',
    tralbumId: identity?.tralbumId || '',
    tralbumType: identity?.tralbumType || 'a',
    trackId: currentTrackId || undefined,
    allowHtmlFallback: allowHtmlFallback || !hasConcreteIdentity(identity)
  };

  const inFlight = sendMessage<TralbumFetchResponse>(request)
    .then((response) => {
      if (!response?.ok) {
        const errorMessage = String(response?.error ?? 'unknown error');
        const lower = errorMessage.toLowerCase();
        const retryAfterMatch = lower.match(/retry-in:(\d+)ms/);
        const retryAfterMs = retryAfterMatch?.[1] ? Number.parseInt(retryAfterMatch[1], 10) : 0;
        const isLocalLimited = lower.includes('fetch_tralbum limited:');
        const isMinIntervalLimited = lower.includes('limited: min-interval');
        const isPerMinuteLimited = lower.includes('limited: per-minute-cap');
        const isLocalBackoffActive = lower.includes('limited: backoff-active');
        const isRemoteRateLimited =
          lower.includes('http 429') ||
          lower.includes('http 403');
        const isServerOrNetwork =
          lower.includes('http 5') ||
          lower.includes('network') ||
          lower.includes('failed');

        if (isMinIntervalLimited) {
          apiBackoffUntilByRelease.set(key, Date.now() + capBackoffMsForContext(API_MIN_REQUEST_INTERVAL_MS));
        } else if (isPerMinuteLimited || isLocalBackoffActive || isLocalLimited) {
          const boundedBackoffMs = capBackoffMsForContext(Math.max(API_LOCAL_LIMIT_BACKOFF_MS, retryAfterMs || 0));
          const nextAllowedAt = Date.now() + boundedBackoffMs;
          apiBackoffUntilByRelease.set(key, nextAllowedAt);
          if (isPerMinuteLimited || (isLocalBackoffActive && !isDiscoverContext())) {
            setApiGlobalBackoffUntil(nextAllowedAt);
          }
        } else if (isRemoteRateLimited) {
          apiBackoffUntilByRelease.set(key, Date.now() + capBackoffMsForContext(API_RATE_BACKOFF_MS));
        } else if (isServerOrNetwork) {
          apiBackoffUntilByRelease.set(key, Date.now() + capBackoffMsForContext(API_ERROR_BACKOFF_MS));
        }

        logger.warn('FETCH_TRALBUM failed', errorMessage);
        recordFetchGate(trackKey, key, 'request-error', 0);
        return {
          tralbum: null,
          retryable:
            isMinIntervalLimited ||
            isPerMinuteLimited ||
            isLocalBackoffActive ||
            isLocalLimited ||
            isRemoteRateLimited ||
            isServerOrNetwork,
          retryAfterMs:
            isPerMinuteLimited || isLocalBackoffActive || isLocalLimited
              ? capBackoffMsForContext(Math.max(API_LOCAL_LIMIT_BACKOFF_MS, retryAfterMs || 0))
              : 0
        } as FetchIdentityResult;
      }

      const tralbum = normalizeApiPayload(response.data);
      if (!tralbum) {
        apiBackoffUntilByRelease.set(key, Date.now() + capBackoffMsForContext(API_ERROR_BACKOFF_MS));
        if (!warnedUnexpectedPayloadByRelease.has(key)) {
          warnedUnexpectedPayloadByRelease.add(key);
          logger.warn('FETCH_TRALBUM returned unexpected payload shape', {
            releaseKey: key,
            shape: describePayloadShape(response.data)
          });
        }
        return {
          tralbum: null,
          retryable: false
        } as FetchIdentityResult;
      }

      apiBackoffUntilByRelease.delete(key);
      warnedUnexpectedPayloadByRelease.delete(key);
      if (response.debugDecision) {
        logger.debug('FETCH_TRALBUM decision', response.debugDecision, key);
      }
      cacheFetchedTralbum(key, tralbum, requestUrl, identity);

      return {
        tralbum,
        retryable: false
      } as FetchIdentityResult;
    })
    .catch((error) => {
      apiBackoffUntilByRelease.set(key, Date.now() + capBackoffMsForContext(API_ERROR_BACKOFF_MS));
      logger.warn('FETCH_TRALBUM message failed', error);
      recordFetchGate(trackKey, key, 'message-failed', capBackoffMsForContext(API_ERROR_BACKOFF_MS));
      return {
        tralbum: null,
        retryable: true
      } as FetchIdentityResult;
    })
    .finally(() => {
      apiInFlightByRelease.delete(key);
    });

  apiInFlightByRelease.set(key, inFlight);
  return inFlight;
}

export function maybeProbeTrackArtistForRoot(
  trackId: string,
  linkedReleaseUrl: string,
  domIdentity: ReleaseIdentity | null,
  resolvedIdentity: ReleaseIdentity | null,
  fetchTralbum: FetchTralbumForIdentity
): void {
  if (!trackId || isReleaseContext()) {
    return;
  }
  const activeTrackId = readTrackIdFromUrl(getLikelyCurrentSrc());
  if (activeTrackId && activeTrackId !== trackId) {
    return;
  }
  if (readCachedTrackArtist(trackId)) {
    return;
  }
  if (trackArtistProbeInFlightByTrackId.has(trackId)) {
    return;
  }

  const now = Date.now();
  const nextProbeAt = trackArtistNextProbeAtByTrackId.get(trackId) ?? 0;
  if (now < nextProbeAt) {
    return;
  }

  const resolvedCached = resolvedIdentity ? getValidCachedApiEntry(resolvedIdentity)?.tralbum ?? null : null;
  if (resolvedCached) {
    const fromResolvedCache = pickTrackArtistFromTralbum(
      resolvedCached,
      trackId,
      resolvedIdentity?.tralbumId ?? '',
      resolvedIdentity?.tralbumType === 't'
    );
    if (fromResolvedCache) {
      cachedTrackArtistByTrackId.set(trackId, {
        artist: fromResolvedCache.artist,
        source: fromResolvedCache.source,
        ts: Date.now()
      });
      return;
    }
  }

  const bandId = firstNonEmpty(
    domIdentity && domIdentity.tralbumType === 't' && domIdentity.tralbumId === trackId ? domIdentity.bandId : '',
    resolvedIdentity?.bandId ?? ''
  );
  if (!bandId) {
    return;
  }

  const identity: ReleaseIdentity = {
    bandId,
    tralbumId: trackId,
    tralbumType: 't'
  };
  const request = fetchTralbum(identity, linkedReleaseUrl || window.location.href, trackId);
  if (!request) {
    return;
  }
  trackArtistNextProbeAtByTrackId.set(trackId, now + TRACK_ARTIST_PROBE_INTERVAL_MS);

  const inFlight = request
    .then((result) => {
      if (!result.tralbum) {
        return;
      }
      const fromTrackPayload = pickTrackArtistFromTralbum(result.tralbum, trackId, identity.tralbumId, true);
      if (!fromTrackPayload) {
        return;
      }
      cachedTrackArtistByTrackId.set(trackId, {
        artist: fromTrackPayload.artist,
        source: fromTrackPayload.source,
        ts: Date.now()
      });
    })
    .finally(() => {
      trackArtistProbeInFlightByTrackId.delete(trackId);
    });

  trackArtistProbeInFlightByTrackId.set(trackId, inFlight);
}
