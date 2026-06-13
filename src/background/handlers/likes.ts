import { COLLECTION_SUMMARY_API, LIKES_FANCOLLECTION_PAGE_SIZE } from '@/shared/constants';
import type { ContentMessage, FanEndpoint } from '@/shared/types';
import { readSharedLikesCache, writeSharedLikesCache } from '@/background/likes-cache';
import {
  readPersistentBoughtLikesCache,
  writePersistentBoughtLikesCache
} from '@/background/persistent-bought-likes-cache';
import { createLogger } from '@/utils/debug';
import { extractFanIdFromText, extractMutationCrumbFromText, extractViewerFanIdFromText } from '@/utils/html-parser';

const logger = createLogger('LIKES');

const FETCH_TIMEOUT_MS = 4_500;
const FAN_ITEMS_MIN_INTERVAL_MS = 500;
const FAN_ITEMS_ERROR_BACKOFF_MS = 30_000;
const FAN_ITEMS_RATE_BACKOFF_MS = 2 * 60 * 1000;
const fanItemsLastRequestAtByEndpoint = new Map<FanEndpoint, number>();
let fanItemsBackoffUntil = 0;

function normalizeDigits(value: unknown): string {
  return String(value ?? '').replace(/[^\d]/g, '').trim();
}

function readRetryAfterMs(response: Response): number {
  const raw = String(response.headers.get('retry-after') || '').trim();
  if (!raw) {
    return 0;
  }
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return 0;
}

function describeShape(payload: unknown): string {
  if (payload === null) {
    return 'null';
  }
  if (typeof payload !== 'object') {
    return typeof payload;
  }
  const keys = Object.keys(payload as Record<string, unknown>).slice(0, 8);
  return keys.length ? keys.join(',') : '(no-keys)';
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return '';
    }
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHttpUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function resolveMutationBaseOrigin(
  pageUrlRaw: string,
  requestContextFamilyRaw: string
): { origin: string; reason: string } {
  const requestContextFamily = String(requestContextFamilyRaw || '').trim().toLowerCase();
  if (requestContextFamily === 'release-pages') {
    const normalizedPageUrl = normalizeHttpUrl(pageUrlRaw);
    if (normalizedPageUrl) {
      try {
        const parsed = new URL(normalizedPageUrl);
        return {
          origin: parsed.origin,
          reason: 'release-origin-from-page-url'
        };
      } catch {
        // Fall through to deterministic fallback.
      }
    }
    return {
      origin: 'https://bandcamp.com',
      reason: 'release-origin-fallback-bandcamp'
    };
  }
  return {
    origin: 'https://bandcamp.com',
    reason: `context-bandcamp-origin:${requestContextFamily || 'unknown'}`
  };
}

function resolveMutationCustomDomainHost(pageUrlRaw: string): string {
  const normalizedPageUrl = normalizeHttpUrl(pageUrlRaw);
  if (!normalizedPageUrl) {
    return '';
  }
  try {
    const parsed = new URL(normalizedPageUrl);
    const host = String(parsed.host || '').toLowerCase().trim();
    if (!host || host === 'bandcamp.com') {
      return '';
    }
    // Bandcamp subdomains are not custom domains for this endpoint.
    if (host.endsWith('.bandcamp.com')) {
      return '';
    }
    return host;
  } catch {
    return '';
  }
}

async function resolveMutationCrumbFromPage(pageUrlRaw: string, endpointPath: string): Promise<string> {
  const normalizedPageUrl = normalizeHttpUrl(pageUrlRaw);
  const endpointKey = String(endpointPath || '').trim().replace(/^\//, '');
  const candidates = new Set<string>();
  if (normalizedPageUrl) {
    candidates.add(normalizedPageUrl);
  }
  if (normalizedPageUrl) {
    try {
      const parsed = new URL(normalizedPageUrl);
      if (parsed.hostname.endsWith('.bandcamp.com')) {
        candidates.add(`https://${parsed.hostname}/`);
      }
    } catch {
      // Ignore malformed URL fallback.
    }
  }
  candidates.add('https://bandcamp.com/');

  for (const candidate of candidates) {
    try {
      const response = await fetchWithTimeout(candidate, {
        method: 'GET',
        credentials: 'include',
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!response.ok) {
        continue;
      }
      const html = await response.text();
      const crumb = String(extractMutationCrumbFromText(html, endpointKey) || '').trim();
      if (crumb) {
        return crumb;
      }
    } catch {
      // Continue probing remaining candidates.
    }
  }

  return '';
}

function findFanIdInPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  let scanned = 0;

  while (queue.length > 0 && scanned < 8000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }
    visited.add(node);
    scanned += 1;

    const record = node as Record<string, unknown>;
    const candidate = normalizeDigits(
      record['fan_id'] ?? record['fanId'] ?? record['fanid'] ?? record['id']
    );
    if (candidate) {
      return candidate;
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return '';
}

async function fetchCollectionSummaryForCurrentFan(): Promise<{
  ok: boolean;
  status: number;
  payload: unknown;
  retryAfterMs: number;
}> {
  const url = `https://bandcamp.com${COLLECTION_SUMMARY_API}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'include'
  });
  const payload = await parseResponseBody(response);
  return {
    ok: response.ok,
    status: response.status,
    payload,
    retryAfterMs: readRetryAfterMs(response)
  };
}

async function fetchFanIdFromHtml(url: string): Promise<string> {
  const normalizedUrl = normalizeHttpUrl(url);
  if (!normalizedUrl) {
    return '';
  }

  try {
    const response = await fetchWithTimeout(normalizedUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    if (!response.ok) {
      return '';
    }
    const html = await response.text();
    return normalizeDigits(
      extractViewerFanIdFromText(html) ||
      extractFanIdFromText(html) ||
      ''
    );
  } catch {
    return '';
  }
}

export async function handleResolveFanId(
  msg: Extract<ContentMessage, { type: 'RESOLVE_FAN_ID' }>
): Promise<unknown> {
  const hintedFanId = normalizeDigits(msg.fanIdHint);
  if (hintedFanId) {
    return {
      ok: true,
      fanId: hintedFanId,
      source: 'message-fan-id-hint',
      ts: Date.now()
    };
  }

  try {
    const htmlCandidates = new Map<string, string>();
    htmlCandidates.set('bandcamp-html-root', 'https://bandcamp.com/');

    for (const [source, candidateUrl] of htmlCandidates) {
      const fanIdFromHtml = await fetchFanIdFromHtml(candidateUrl);
      if (fanIdFromHtml) {
        return {
          ok: true,
          fanId: fanIdFromHtml,
          source,
          ts: Date.now()
        };
      }
    }

    const summary = await fetchCollectionSummaryForCurrentFan();
    if (summary.ok) {
      const fanIdFromSummary = normalizeDigits(extractFanIdFromSummaryPayload(summary.payload));
      if (fanIdFromSummary) {
        return {
          ok: true,
          fanId: fanIdFromSummary,
          source: 'collection-summary-current',
          ts: Date.now()
        };
      }
    }

    return {
      ok: false,
      error: 'fan-id-unavailable',
      reason: summary.ok ? 'collection-summary-missing-fan-id' : `collection-summary-http-${summary.status}`,
      status: summary.status,
      ts: Date.now()
    };
  } catch {
    return {
      ok: false,
      error: 'fan-id-unavailable',
      reason: 'collection-summary-current-error',
      ts: Date.now()
    };
  }
}

export async function handleGetSharedLikesCache(
  msg: Extract<ContentMessage, { type: 'GET_SHARED_LIKES_CACHE' }>
): Promise<unknown> {
  const snapshot = readSharedLikesCache(msg.fanId);
  return {
    ok: Boolean(snapshot),
    snapshot,
    ts: Date.now()
  };
}

export async function handleSetSharedLikesCache(
  msg: Extract<ContentMessage, { type: 'SET_SHARED_LIKES_CACHE' }>
): Promise<unknown> {
  const snapshot = writeSharedLikesCache(msg.snapshot);
  return {
    ok: Boolean(snapshot),
    snapshot,
    ts: Date.now()
  };
}

export async function handleGetPersistentBoughtLikesCache(
  msg: Extract<ContentMessage, { type: 'GET_PERSISTENT_BOUGHT_LIKES_CACHE' }>
): Promise<unknown> {
  const snapshot = await readPersistentBoughtLikesCache(msg.fanId);
  return {
    ok: Boolean(snapshot),
    snapshot,
    ts: Date.now()
  };
}

export async function handleSetPersistentBoughtLikesCache(
  msg: Extract<ContentMessage, { type: 'SET_PERSISTENT_BOUGHT_LIKES_CACHE' }>
): Promise<unknown> {
  const snapshot = await writePersistentBoughtLikesCache(msg.snapshot);
  return {
    ok: Boolean(snapshot),
    snapshot,
    ts: Date.now()
  };
}

export async function handleFetchFancollectionItems(
  msg: Extract<ContentMessage, { type: 'FETCH_FANCOLLECTION_ITEMS' }>
): Promise<unknown> {
  const endpoint = msg.endpoint;
  if (endpoint !== 'wishlist_items' && endpoint !== 'collection_items') {
    return { ok: false, error: 'invalid-endpoint', ts: Date.now() };
  }

  const fanId = normalizeDigits(msg.fanId);
  if (!fanId) {
    return { ok: false, error: 'fan-id-missing', ts: Date.now() };
  }

  const olderThanToken = String(msg.olderThanToken || '').trim();
  if (!olderThanToken) {
    return {
      ok: false,
      error: 'missing-key-older_than_token',
      status: 400,
      ts: Date.now()
    };
  }

  const countRaw = Number(msg.count);
  const count = Number.isFinite(countRaw) && countRaw > 0
    ? Math.min(LIKES_FANCOLLECTION_PAGE_SIZE, Math.max(1, Math.floor(countRaw)))
    : LIKES_FANCOLLECTION_PAGE_SIZE;
  const payload = {
    fan_id: Number(fanId),
    older_than_token: olderThanToken,
    count
  };

  const url = `https://bandcamp.com/api/fancollection/1/${endpoint}`;
  const now = Date.now();
  if (now < fanItemsBackoffUntil) {
    const waitMs = Math.max(250, fanItemsBackoffUntil - now);
    return {
      ok: false,
      endpoint,
      status: 429,
      retryAfterMs: waitMs,
      error: `limited:backoff-active:${waitMs}`,
      ts: now
    };
  }

  const lastEndpointRequestAt = fanItemsLastRequestAtByEndpoint.get(endpoint) ?? 0;
  if (now - lastEndpointRequestAt < FAN_ITEMS_MIN_INTERVAL_MS) {
    const waitMs = Math.max(120, FAN_ITEMS_MIN_INTERVAL_MS - (now - lastEndpointRequestAt));
    return {
      ok: false,
      endpoint,
      status: 429,
      retryAfterMs: waitMs,
      error: `limited:min-interval:${waitMs}`,
      ts: now
    };
  }

  fanItemsLastRequestAtByEndpoint.set(endpoint, now);
  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload)
    });

    const body = await parseResponseBody(response);
    if (!response.ok) {
      logger.warn('LIKES fetch endpoint failed', {
        endpoint,
        status: response.status
      });
      const retryAfterMs = readRetryAfterMs(response);
      if (response.status === 429 || response.status === 403) {
        fanItemsBackoffUntil = Math.max(
          fanItemsBackoffUntil,
          Date.now() + Math.max(FAN_ITEMS_RATE_BACKOFF_MS, retryAfterMs || 0)
        );
      } else if (response.status >= 500) {
        fanItemsBackoffUntil = Math.max(fanItemsBackoffUntil, Date.now() + FAN_ITEMS_ERROR_BACKOFF_MS);
      }
      return {
        ok: false,
        endpoint,
        status: response.status,
        retryAfterMs,
        error: `HTTP ${response.status}: ${typeof body === 'string' ? body.slice(0, 240) : JSON.stringify(body).slice(0, 240)}`,
        shape: describeShape(body),
        ts: Date.now()
      };
    }

    if (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)) {
      const record = body as Record<string, unknown>;
      return {
        ok: false,
        endpoint,
        status: response.status,
        error: `API error: ${String(record.error_message || record.error || 'unknown')}`,
        shape: describeShape(body),
        ts: Date.now()
      };
    }

    return {
      ok: true,
      endpoint,
      status: response.status,
      data: body,
      ts: Date.now()
    };
  } catch (error) {
    fanItemsBackoffUntil = Math.max(fanItemsBackoffUntil, Date.now() + FAN_ITEMS_ERROR_BACKOFF_MS);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      endpoint,
      error: `network-error:${message}`,
      ts: Date.now()
    };
  }
}

export async function handleToggleWishlistItem(
  msg: Extract<ContentMessage, { type: 'TOGGLE_WISHLIST_ITEM' }>
): Promise<unknown> {
  const action = msg.action === 'uncollect' ? 'uncollect' : 'collect';
  const endpoint = action === 'collect' ? '/collect_item_cb' : '/uncollect_item_cb';
  const fanId = normalizeDigits(msg.fanId);
  const itemId = normalizeDigits(msg.itemId);
  const bandId = normalizeDigits(msg.bandId);
  let crumb = String(msg.crumb || '').trim();
  const itemTypeShort = msg.itemType === 'track' ? 't' : 'a';
  const itemTypeLong = msg.itemType === 'track' ? 'track' : 'album';
  const pageUrl = String(msg.pageUrl || '').trim();
  const requestContextFamily = String(msg.requestContextFamily || '').trim().toLowerCase();
  const requestContextVariant = String(msg.requestContextVariant || '').trim().toLowerCase();
  const baseOriginInfo = resolveMutationBaseOrigin(pageUrl, requestContextFamily);
  const baseOrigin = baseOriginInfo.origin;
  const customDomainHost = resolveMutationCustomDomainHost(pageUrl);

  if (!fanId) {
    return { ok: false, error: 'fan-id-missing', action, ts: Date.now() };
  }
  if (!itemId) {
    return { ok: false, error: 'item-id-missing', action, ts: Date.now() };
  }
  if (!crumb) {
    crumb = await resolveMutationCrumbFromPage(pageUrl, endpoint);
  }
  if (!crumb) {
    return {
      ok: false,
      error: 'crumb-missing',
      reason: pageUrl ? 'crumb-missing:fallback-failed' : 'crumb-missing:no-page-url',
      action,
      ts: Date.now()
    };
  }

  type AttemptSpec = {
    label: string;
    itemTypeMode: 'short' | 'long' | 'none';
    includeBandId: boolean;
  };
  const attemptSpecs: AttemptSpec[] =
    action === 'collect'
      ? [
          { label: 'full-short', itemTypeMode: 'short', includeBandId: true },
          { label: 'full-long', itemTypeMode: 'long', includeBandId: true },
          { label: 'no-band-short', itemTypeMode: 'short', includeBandId: false },
          { label: 'no-band-long', itemTypeMode: 'long', includeBandId: false }
        ]
      : [
          { label: 'full-short', itemTypeMode: 'short', includeBandId: true },
          { label: 'full-long', itemTypeMode: 'long', includeBandId: true },
          { label: 'no-band-short', itemTypeMode: 'short', includeBandId: false },
          { label: 'no-band-long', itemTypeMode: 'long', includeBandId: false },
          { label: 'minimal', itemTypeMode: 'none', includeBandId: false }
        ];

  let lastFailure: {
    status: number;
    error: string;
    reason: string;
    attempt: string;
  } | null = null;
  let refreshedCrumbAfterGenericError = false;

  try {
    for (const spec of attemptSpecs) {
      let attemptCrumb = crumb;
      for (let crumbRetry = 0; crumbRetry < 2; crumbRetry += 1) {
        const params = new URLSearchParams();
        params.set('fan_id', fanId);
        params.set('item_id', itemId);
        params.set('crumb', attemptCrumb);
        if (spec.itemTypeMode === 'short') {
          params.set('item_type', itemTypeShort);
        } else if (spec.itemTypeMode === 'long') {
          params.set('item_type', itemTypeLong);
        }
        if (spec.includeBandId && bandId) {
          params.set('band_id', bandId);
        }
        if (customDomainHost) {
          params.set('custom_domain_host', customDomainHost);
        }

        const response = await fetchWithTimeout(`${baseOrigin}${endpoint}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest'
          },
          body: params.toString()
        });

        const body = await parseResponseBody(response);
        const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
        const bodyError = bodyRecord ? bodyRecord['error'] : null;
        const bodyErrorMessage = bodyRecord ? String(bodyRecord['error_message'] || '').trim() : '';
        const bodyCrumb = bodyRecord ? String(bodyRecord['crumb'] || '').trim() : '';
        const invalidCrumb = String(bodyError || '').trim().toLowerCase() === 'invalid_crumb' && Boolean(bodyCrumb);

        if (!response.ok) {
          if (invalidCrumb && crumbRetry < 1 && bodyCrumb) {
            attemptCrumb = bodyCrumb;
            crumb = bodyCrumb;
            continue;
          }
          return {
            ok: false,
            action,
            status: response.status,
            retryAfterMs: readRetryAfterMs(response),
            error: `HTTP ${response.status}: ${
              typeof body === 'string' ? body.slice(0, 240) : JSON.stringify(body).slice(0, 240)
            };attempt=${spec.label}`,
            reason: `attempt=${spec.label};origin=${baseOrigin};originReason=${baseOriginInfo.reason};ctx=${requestContextFamily || '-'}:${requestContextVariant || '-'}`,
            ts: Date.now()
          };
        }

        if (bodyRecord && bodyError) {
          if (invalidCrumb && crumbRetry < 1 && bodyCrumb) {
            attemptCrumb = bodyCrumb;
            crumb = bodyCrumb;
            continue;
          }

          const reasonPreview = (() => {
            try {
              return JSON.stringify(bodyRecord).slice(0, 280);
            } catch {
              return '';
            }
          })();
          lastFailure = {
            status: response.status,
            error: `API error: ${String(bodyErrorMessage || bodyError || 'unknown')}`,
            reason: reasonPreview,
            attempt: spec.label
          };

          const genericApiError = bodyError === true && !bodyErrorMessage;
          if (genericApiError) {
            if (!refreshedCrumbAfterGenericError) {
              refreshedCrumbAfterGenericError = true;
              const refreshedCrumb = await resolveMutationCrumbFromPage(pageUrl, endpoint);
              if (refreshedCrumb && refreshedCrumb !== attemptCrumb) {
                attemptCrumb = refreshedCrumb;
                crumb = refreshedCrumb;
                continue;
              }
            }
            break;
          }

          return {
            ok: false,
            action,
            status: response.status,
              error: `${lastFailure.error};attempt=${spec.label}`,
              reason: `${reasonPreview};attempt=${spec.label};origin=${baseOrigin};originReason=${baseOriginInfo.reason};ctx=${requestContextFamily || '-'}:${requestContextVariant || '-'}`,
              ts: Date.now()
            };
        }

        return {
          ok: true,
          action,
          status: response.status,
          data: body,
          attempt: spec.label,
          origin: baseOrigin,
          originReason: baseOriginInfo.reason,
          contextFamily: requestContextFamily || '',
          contextVariant: requestContextVariant || '',
          ts: Date.now()
        };
      }
    }

    if (lastFailure) {
      return {
        ok: false,
        action,
        status: lastFailure.status,
        error: `${lastFailure.error};attempt=${lastFailure.attempt}`,
        reason: `${lastFailure.reason};attempt=${lastFailure.attempt};origin=${baseOrigin};originReason=${baseOriginInfo.reason};ctx=${requestContextFamily || '-'}:${requestContextVariant || '-'}`,
        ts: Date.now()
      };
    }

    return {
      ok: false,
      action,
      error: 'mutation-failed-no-attempts',
      ts: Date.now()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action,
      error: `network-error:${message}`,
      ts: Date.now()
    };
  }
}

export function extractFanIdFromSummaryPayload(payload: unknown): string {
  return findFanIdInPayload(payload);
}
