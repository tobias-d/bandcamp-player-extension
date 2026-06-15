import type { ContentMessage, TralbumFetchResponse } from '@/shared/types';
import { buildAttemptUrls } from '@/background/handlers/tralbum/attempt-urls';
import { TRALBUM_CACHE_TTL_MS } from '@/background/handlers/tralbum/constants';
import { maybeEnrichMissingDurations } from '@/background/handlers/tralbum/duration-enrichment';
import {
  noteAttemptEndpointFailure,
  noteAttemptEndpointSuccess,
  prepareAttemptUrlsForEndpointHealth
} from '@/background/handlers/tralbum/endpoint-health';
import { tryHtmlFallback } from '@/background/handlers/tralbum/html-fallback';
import { getReleaseKey, parseIdsFromUrl, toId, toType } from '@/background/handlers/tralbum/identity';
import { hasTrackArrays, minExpectedCoverage, normalizePayloadData, readErrorFromPayload, getPayloadTrackQuality } from '@/background/handlers/tralbum/payload';
import { createTralbumRateLimiter } from '@/background/handlers/tralbum/rate-limiter';
import { fetchWithTimeout } from '@/background/handlers/tralbum/request';
import { isLikelyReleaseUrl, parseOriginFromUrl } from '@/background/handlers/tralbum/url';
import { TTLCache } from '@/utils/cache';
import { createLogger } from '@/utils/debug';

const logger = createLogger('MESSAGING');

const TRALBUM_CACHE_MAX_ENTRIES = 200;

interface TralbumCacheValue {
  data: unknown;
  // Whether each enrichment dimension has already been attempted for this entry.
  // Enrichment is bounded to once per dimension per cache lifetime so a release
  // that legitimately stays below the coverage threshold does not re-fetch on
  // every cache hit. htmlEnriched can still flip on a later request that newly
  // permits HTML fallback.
  durationEnriched: boolean;
  htmlEnriched: boolean;
}

const tralbumCache = new TTLCache<string, TralbumCacheValue>(TRALBUM_CACHE_TTL_MS, TRALBUM_CACHE_MAX_ENTRIES);
const tralbumInFlight = new Map<string, Promise<TralbumFetchResponse>>();
const rateLimiter = createTralbumRateLimiter();

function shouldCountForEndpointHealth(status?: number): boolean {
  if (!Number.isFinite(status)) {
    return true;
  }
  const code = Number(status);
  return code === 429 || code === 403 || code >= 500;
}


function shouldTryDurationEnrichment(data: unknown): boolean {
  const quality = getPayloadTrackQuality(data);
  if (quality.trackCount <= 1) {
    return false;
  }

  return quality.tracksWithDuration < minExpectedCoverage(quality.trackCount);
}

// Enrich a cached entry, but only for dimensions not already attempted. Returns
// the (possibly updated) entry and whether anything changed so the caller can
// decide to re-store. This is what bounds enrichment to once per dimension.
async function enrichCachedEntry(
  entry: TralbumCacheValue,
  releaseUrl: string,
  origin: string,
  releaseKey: string,
  allowHtmlFallback: boolean
): Promise<{ entry: TralbumCacheValue; changed: boolean }> {
  let data = entry.data;
  let durationEnriched = entry.durationEnriched;
  let htmlEnriched = entry.htmlEnriched;
  let changed = false;

  if (!durationEnriched) {
    if (shouldTryDurationEnrichment(data)) {
      data = await maybeEnrichMissingDurations(data, releaseUrl, origin, rateLimiter, releaseKey);
    }
    durationEnriched = true;
    changed = true;
  }

  if (!htmlEnriched && allowHtmlFallback) {
    data = await maybeEnrichMissingStreams(data, releaseUrl, origin, releaseKey, allowHtmlFallback);
    htmlEnriched = true;
    changed = true;
  }

  return { entry: { data, durationEnriched, htmlEnriched }, changed };
}

async function maybeEnrichMissingStreams(
  data: unknown,
  releaseUrl: string,
  origin: string,
  releaseKey: string,
  allowHtmlFallback: boolean
): Promise<unknown> {
  if (!allowHtmlFallback) {
    return data;
  }

  const quality = getPayloadTrackQuality(data);
  if (quality.trackCount <= 1) {
    return data;
  }

  const minExpectedStreams = minExpectedCoverage(quality.trackCount);
  const hasEnoughStreamCoverage = quality.tracksWithStream >= minExpectedStreams;
  const hasEnoughDirectStreamCoverage = quality.tracksWithDirectStream >= minExpectedStreams;
  if (hasEnoughStreamCoverage && hasEnoughDirectStreamCoverage) {
    return data;
  }

  const htmlFallback = await tryHtmlFallback(releaseUrl, rateLimiter, releaseKey);
  if (!(htmlFallback.data && hasTrackArrays(htmlFallback.data))) {
    return data;
  }

  const fallbackData = normalizePayloadData(htmlFallback.data);
  const fallbackQuality = getPayloadTrackQuality(fallbackData);
  const improvesDirectStreams = fallbackQuality.tracksWithDirectStream > quality.tracksWithDirectStream;
  const improvesStreamCoverage = fallbackQuality.tracksWithStream > quality.tracksWithStream;
  if (!improvesDirectStreams && !improvesStreamCoverage) {
    return data;
  }

  return fallbackData;
}

async function buildSuccessFromFallback(
  fallback: Awaited<ReturnType<typeof tryHtmlFallback>>,
  releaseUrl: string,
  origin: string,
  releaseKey: string
): Promise<TralbumFetchResponse | null> {
  if (!(fallback.data && hasTrackArrays(fallback.data))) {
    return null;
  }

  let data = normalizePayloadData(fallback.data);
  data = await maybeEnrichMissingDurations(data, releaseUrl, origin, rateLimiter, releaseKey);
  // Data is already HTML-sourced, so both enrichment dimensions are exhausted.
  tralbumCache.set(releaseKey, {
    data,
    durationEnriched: true,
    htmlEnriched: true
  });
  return {
    ok: true,
    data
  };
}

export async function handleFetchTralbum(
  msg: Extract<ContentMessage, { type: 'FETCH_TRALBUM' }>
): Promise<TralbumFetchResponse> {
  let bandId = toId(msg.bandId);
  let tralbumId = toId(msg.tralbumId);
  let tralbumType = toType(msg.tralbumType) || 'a';
  let trackId = toId(msg.trackId);

  const releaseUrl = String(msg.url || '');
  const origin = parseOriginFromUrl(releaseUrl || 'https://bandcamp.com');

  if ((!bandId || !tralbumId) && releaseUrl) {
    const idsFromUrl = parseIdsFromUrl(releaseUrl);
    bandId = bandId || idsFromUrl.bandId;
    tralbumId = tralbumId || idsFromUrl.tralbumId;
    tralbumType = idsFromUrl.tralbumType || tralbumType;
    trackId = trackId || idsFromUrl.trackId;
  }

  const canFallbackFromReleaseUrl = isLikelyReleaseUrl(releaseUrl);
  const allowHtmlFallback = msg.allowHtmlFallback !== false;

  if (!tralbumId && !trackId && !canFallbackFromReleaseUrl) {
    const error = `FETCH_TRALBUM missing ids (bandId=${bandId || '-'}, tralbumId=${tralbumId || '-'}, trackId=${trackId || '-'})`;
    logger.warn(error);
    return { ok: false, error };
  }

  const releaseKey = (tralbumId || trackId)
    ? getReleaseKey({
        bandId,
        tralbumId,
        trackId,
        tralbumType
      })
    : `url:${releaseUrl.trim().toLowerCase() || origin.toLowerCase()}`;

  const now = Date.now();
  const cached = tralbumCache.get(releaseKey);
  if (cached) {
    const result = await enrichCachedEntry(cached, releaseUrl, origin, releaseKey, allowHtmlFallback);
    if (result.changed) {
      tralbumCache.set(releaseKey, result.entry);
    }
    return {
      ok: true,
      data: result.entry.data,
      debugDecision: 'cached'
    };
  }

  const existing = tralbumInFlight.get(releaseKey);
  if (existing) {
    return existing.then(r => ({ ...r, debugDecision: r.debugDecision ?? 'in-flight' }));
  }

  const limitReason = rateLimiter.shouldRateLimit(now, releaseKey);
  if (limitReason) {
    logger.warn('FETCH_TRALBUM blocked by limiter', limitReason, releaseKey);
    return {
      ok: false,
      error: `FETCH_TRALBUM limited: ${limitReason}`
    };
  }

  const attemptUrls = buildAttemptUrls({
    origin,
    bandId,
    tralbumId,
    tralbumType,
    trackId
  });
  const attemptUrlPlan = prepareAttemptUrlsForEndpointHealth(attemptUrls);
  const candidateAttemptUrls = attemptUrlPlan.urls;
  if (attemptUrlPlan.suppressedInfoCount > 0) {
    logger.debug(
      'FETCH_TRALBUM de-prioritized endpoints',
      `suppressedInfo=${attemptUrlPlan.suppressedInfoCount}`,
      releaseKey
    );
  }

  const releaseUrlLooksResolvable = isLikelyReleaseUrl(releaseUrl);
  // Prefer HTML first when we only have a release URL and cannot build any API attempts.
  // This now also covers normal Bandcamp track/album pages whose numeric ids are not known yet.
  const preferHtmlFirst = allowHtmlFallback && releaseUrlLooksResolvable && candidateAttemptUrls.length === 0;

  if (!candidateAttemptUrls.length && !preferHtmlFirst) {
    return {
      ok: false,
      error: 'FETCH_TRALBUM no-attempt-urls'
    };
  }

  const requestPromise = (async (): Promise<TralbumFetchResponse> => {
    try {
      rateLimiter.noteRequestStart(releaseKey);

      let lastError = 'FETCH_TRALBUM no-usable-payload';
      const attemptErrors: string[] = [];

      if (preferHtmlFirst) {
        const htmlFallback = await tryHtmlFallback(releaseUrl, rateLimiter, releaseKey);
        const htmlResult = await buildSuccessFromFallback(htmlFallback, releaseUrl, origin, releaseKey);
        if (htmlResult?.ok) {
          return { ...htmlResult, debugDecision: 'html-preferred' };
        }

        if (htmlFallback.error) {
          lastError = htmlFallback.error;
          attemptErrors.push(htmlFallback.error);
        }

        // When the request can only be resolved via HTML, don't immediately
        // retry the same fallback path again at the end of the request. That
        // only duplicates slow timeout failures and makes the prototype report
        // noisier without improving recovery.
        if (!candidateAttemptUrls.length) {
          return {
            ok: false,
            error: attemptErrors.length ? attemptErrors.join(' || ') : lastError
          };
        }
      }

      for (const attemptUrl of candidateAttemptUrls) {
        try {
          rateLimiter.noteHttpAttempt();
          const response = await fetchWithTimeout(attemptUrl, {
            method: 'GET',
            credentials: 'include'
          });

          if (!response.ok) {
            rateLimiter.noteHttpStatus(response.status, releaseKey);
            if (shouldCountForEndpointHealth(response.status)) {
              noteAttemptEndpointFailure(attemptUrl);
            }
            lastError = `FETCH_TRALBUM API failed: HTTP ${response.status} (${attemptUrl})`;
            attemptErrors.push(lastError);
            continue;
          }

          const payload = (await response.json()) as unknown;
          const payloadError = readErrorFromPayload(payload);
          if (payloadError) {
            lastError = `FETCH_TRALBUM API payload error: ${payloadError} (${attemptUrl})`;
            attemptErrors.push(lastError);
            continue;
          }

          let data = normalizePayloadData(payload);
          if (!hasTrackArrays(data)) {
            lastError = `FETCH_TRALBUM no-track-arrays (${attemptUrl})`;
            attemptErrors.push(lastError);
            continue;
          }

          data = await maybeEnrichMissingDurations(data, releaseUrl, origin, rateLimiter, releaseKey);
          data = await maybeEnrichMissingStreams(data, releaseUrl, origin, releaseKey, allowHtmlFallback);
          noteAttemptEndpointSuccess(attemptUrl);
          // Duration enrichment always ran; HTML stream enrichment ran only when
          // permitted, so a later HTML-permitted request can still upgrade it.
          tralbumCache.set(releaseKey, {
            data,
            durationEnriched: true,
            htmlEnriched: allowHtmlFallback
          });

          return {
            ok: true,
            data,
            debugDecision: 'api'
          };
        } catch (attemptError) {
          noteAttemptEndpointFailure(attemptUrl);
          const message = attemptError instanceof Error ? attemptError.message : String(attemptError);
          lastError = `FETCH_TRALBUM attempt error: ${message} (${attemptUrl})`;
          attemptErrors.push(lastError);
        }
      }

      if (allowHtmlFallback && releaseUrlLooksResolvable) {
        const finalFallback = await tryHtmlFallback(releaseUrl, rateLimiter, releaseKey);
        const htmlFallbackResult = await buildSuccessFromFallback(finalFallback, releaseUrl, origin, releaseKey);
        if (htmlFallbackResult?.ok) {
          return { ...htmlFallbackResult, debugDecision: 'html-fallback' };
        }

        if (finalFallback.error) {
          attemptErrors.push(finalFallback.error);
        }
      }

      return {
        ok: false,
        error: attemptErrors.length ? attemptErrors.join(' || ') : lastError
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rateLimiter.noteHttpStatus(500, releaseKey);
      logger.warn('FETCH_TRALBUM request failed', message);
      return {
        ok: false,
        error: message
      };
    } finally {
      tralbumInFlight.delete(releaseKey);
    }
  })();

  tralbumInFlight.set(releaseKey, requestPromise);
  return requestPromise;
}
