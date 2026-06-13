import { extractCanonicalReleaseUrlFromHtml, isLikelyReleaseUrl, normalizeUrl } from '@/background/handlers/tralbum/url';
import { extractTralbumFromHtml, hasTrackArrays } from '@/background/handlers/tralbum/payload';
import { fetchWithTimeout } from '@/background/handlers/tralbum/request';
import {
  HTML_FALLBACK_FETCH_TIMEOUT_MS,
  HTML_FALLBACK_RETRY_TIMEOUT_MS
} from '@/background/handlers/tralbum/constants';
import type { TralbumRateLimiter } from '@/background/handlers/tralbum/rate-limiter';

export interface HtmlFallbackResult {
  data: unknown | null;
  error: string;
}

export async function tryHtmlFallback(
  requestUrl: string,
  rateLimiter: TralbumRateLimiter,
  releaseKey = ''
): Promise<HtmlFallbackResult> {
  if (!isLikelyReleaseUrl(requestUrl)) {
    return {
      data: null,
      error: 'FETCH_TRALBUM html-fallback skipped: invalid-release-url'
    };
  }

  let releaseUrl = normalizeUrl(requestUrl);
  if (!releaseUrl) {
    return {
      data: null,
      error: 'FETCH_TRALBUM html-fallback skipped: malformed-release-url'
    };
  }

  const fetchRelease = async (
    url: string
  ): Promise<{ html: string; resolvedUrl: string; error: string }> => {
    const fetchHtmlResponse = async (timeoutMs: number): Promise<Response> => {
      rateLimiter.noteHttpAttempt();
      return fetchWithTimeout(url, {
        method: 'GET',
        credentials: 'include'
      }, timeoutMs);
    };

    let response: Response;
    try {
      response = await fetchHtmlResponse(HTML_FALLBACK_FETCH_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : '';
      const shouldRetryTimeout = (
        name === 'AbortError'
        || message === 'The operation was aborted.'
        || message === 'AbortError: signal is aborted without reason'
      );
      if (!shouldRetryTimeout) {
        throw error;
      }
      response = await fetchHtmlResponse(HTML_FALLBACK_RETRY_TIMEOUT_MS);
    }

    if (!response.ok) {
      rateLimiter.noteHttpStatus(response.status, releaseKey);
      return {
        html: '',
        resolvedUrl: normalizeUrl(response.url || url) || normalizeUrl(url),
        error: `FETCH_TRALBUM html-fallback failed: HTTP ${response.status} (${url})`
      };
    }

    const html = await response.text();
    return {
      html,
      resolvedUrl: normalizeUrl(response.url || url) || normalizeUrl(url),
      error: ''
    };
  };

  try {
    const initial = await fetchRelease(releaseUrl);
    if (initial.error) {
      return { data: null, error: initial.error };
    }

    releaseUrl = initial.resolvedUrl || releaseUrl;

    let tralbum = extractTralbumFromHtml(initial.html);
    if (tralbum && hasTrackArrays(tralbum)) {
      return { data: tralbum, error: '' };
    }

    const canonicalUrl = extractCanonicalReleaseUrlFromHtml(initial.html, releaseUrl);
    if (canonicalUrl && canonicalUrl !== releaseUrl) {
      const canonical = await fetchRelease(canonicalUrl);
      if (canonical.error) {
        return { data: null, error: canonical.error };
      }

      tralbum = extractTralbumFromHtml(canonical.html);
      if (tralbum && hasTrackArrays(tralbum)) {
        return { data: tralbum, error: '' };
      }
    }

    return {
      data: null,
      error: `FETCH_TRALBUM html-fallback no-track-arrays (${releaseUrl})`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      data: null,
      error: `FETCH_TRALBUM html-fallback error: ${message}`
    };
  }
}
