import { decodeAudio } from '@/background/audio/decoder';
import { fetchSharedEncodedAudio } from '@/background/audio/encoded-audio-cache';
import {
  getCachedDecodedAudio,
  getOrCreateDecodedAudio
} from '@/background/cache';
import { createLogger } from '@/utils/debug';

const logger = createLogger('ANALYZER');

// ---------------------------------------------------------------------------
// Abort utilities
// ---------------------------------------------------------------------------

export function createAbortError(): Error {
  const error = new Error('Analysis aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw createAbortError();
  }

  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    })
  ]);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// 2 MB ~ 120 seconds of MP3-128 (128kbps = 16KB/s)
export const PARTIAL_FETCH_MAX_BYTES = 2_097_152;
// Don't bother with Range requests for files smaller than this
export const PARTIAL_FETCH_MIN_TOTAL_BYTES = 512_000;

const ALLOWED_AUDIO_FETCH_HOSTS = ['bandcamp.com', 'bcbits.com'];

class RangeFetchUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RangeFetchUnsupportedError';
  }
}

function isAllowedAudioFetchHostname(hostname: string): boolean {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  return ALLOWED_AUDIO_FETCH_HOSTS.some(
    (allowedHost) =>
      normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`)
  );
}

function assertAllowedAudioFetchUrl(url: string): string {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    throw new Error('Audio fetch url missing');
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl, 'https://bandcamp.com');
  } catch {
    throw new Error(`Audio fetch blocked: invalid url (${normalizedUrl})`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Audio fetch blocked: unsupported protocol (${parsed.protocol || 'unknown'})`);
  }

  if (!isAllowedAudioFetchHostname(parsed.hostname)) {
    throw new Error(`Audio fetch blocked: unsupported host (${parsed.hostname || 'unknown'})`);
  }

  return parsed.toString();
}

function buildDecodedAudioExecutionKey(
  cacheIdentity: string,
  url: string,
  mode: 'partial' | 'full'
): string {
  return `${cacheIdentity}|${mode}|${String(url || '').trim()}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisTimingBreakdown {
  fetchMs: number;
  decodeMs: number;
  tempoMs: number;
}

export interface DecodedAudioResolution {
  audioBuffer: AudioBuffer;
  timing: Pick<AnalysisTimingBreakdown, 'fetchMs' | 'decodeMs'>;
  isPartial: boolean;
  resolveMs: number;
  completeness: 'partial' | 'full';
  resolvedUrl: string;
}

interface PartialFetchResult {
  arrayBuffer: ArrayBuffer;
  isPartial: boolean;
  totalSize: number | null;
  resolvedUrl: string;
}

// ---------------------------------------------------------------------------
// Audio fetch
// ---------------------------------------------------------------------------

export async function fetchAudioArrayBuffer(
  url: string,
  signal?: AbortSignal | null
): Promise<{ arrayBuffer: ArrayBuffer; resolvedUrl: string }> {
  const fetchUrl = assertAllowedAudioFetchUrl(url);
  // Route full-audio fetches through the shared trackId-keyed cache so the
  // current track is downloaded once across analysis/waveform and predecode.
  // The shared fetch runs to completion; honour our own cancellation after.
  const shared = await fetchSharedEncodedAudio(fetchUrl, async () => {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      // Raw media caching is owned by the extension's analysis caches, not the browser HTTP cache.
      cache: 'no-store',
      credentials: 'include'
    });
    if (!response.ok) {
      throw new Error(`Audio fetch failed: HTTP ${response.status}`);
    }
    return {
      arrayBuffer: await response.arrayBuffer(),
      contentType: String(response.headers.get('content-type') || '').trim() || undefined,
      resolvedUrl: String(response.url || fetchUrl || '').trim()
    };
  });
  throwIfAborted(signal);
  return {
    arrayBuffer: shared.arrayBuffer,
    resolvedUrl: shared.resolvedUrl
  };
}

async function fetchPartialAudioArrayBuffer(
  url: string,
  maxBytes: number,
  signal?: AbortSignal | null
): Promise<PartialFetchResult> {
  const fetchUrl = assertAllowedAudioFetchUrl(url);
  const response = await fetch(fetchUrl, {
    method: 'GET',
    // Keep partial analysis fetches out of the browser HTTP cache for the same reason.
    cache: 'no-store',
    credentials: 'include',
    headers: { Range: `bytes=0-${maxBytes - 1}` },
    signal: signal ?? undefined
  });

  if (response.status === 206) {
    const contentRange = response.headers.get('Content-Range');
    const totalMatch = contentRange?.match(/\/(\d+)/);
    const totalSize = totalMatch ? parseInt(totalMatch[1], 10) : null;
    return {
      arrayBuffer: await response.arrayBuffer(),
      isPartial: true,
      totalSize: Number.isFinite(totalSize) ? totalSize : null,
      resolvedUrl: String(response.url || fetchUrl || '').trim()
    };
  }

  if (response.ok) {
    void response.body?.cancel();
    throw new RangeFetchUnsupportedError(`Range request ignored: HTTP ${response.status}`);
  }

  throw new Error(`Audio fetch failed: HTTP ${response.status}`);
}

// ---------------------------------------------------------------------------
// Decoded audio resolution (with partial fetch + full upgrade)
// ---------------------------------------------------------------------------

let partialFetchDisabled = false;

export const fullAudioUpgradeInFlight = new Set<string>();
const fullAudioUpgradePromises = new Map<string, Promise<void>>();
const latestFullAudioUpgradePromiseByCacheIdentity = new Map<string, Promise<void>>();
const fullAudioUpgradeCountByCacheIdentity = new Map<string, number>();

export async function scheduleFullAudioUpgrade(
  cacheIdentity: string,
  url: string,
  signal?: AbortSignal | null
): Promise<void> {
  const normalizedUrl = assertAllowedAudioFetchUrl(url);
  const executionKey = buildDecodedAudioExecutionKey(cacheIdentity, normalizedUrl, 'full');
  const existing = fullAudioUpgradePromises.get(executionKey);
  if (existing) {
    return existing;
  }

  let promise: Promise<void> | null = null;
  promise = (async () => {
    fullAudioUpgradeCountByCacheIdentity.set(
      cacheIdentity,
      (fullAudioUpgradeCountByCacheIdentity.get(cacheIdentity) || 0) + 1
    );
    fullAudioUpgradeInFlight.add(cacheIdentity);
    try {
      if (signal?.aborted) return;
      await getOrCreateDecodedAudio(cacheIdentity, async () => {
        const fetched = await fetchAudioArrayBuffer(normalizedUrl, signal);
        if (signal?.aborted) {
          throw createAbortError();
        }
        const fullBuffer = await decodeAudio(fetched.arrayBuffer);
        if (signal?.aborted) {
          throw createAbortError();
        }
        return {
          audioBuffer: fullBuffer,
          completeness: 'full' as const,
          resolvedUrl: String(fetched.resolvedUrl || normalizedUrl || '').trim()
        };
      }, {
        requireFull: true,
        inFlightKey: executionKey
      });
      logger.debug(`Full audio upgrade complete for ${cacheIdentity}`);
    } catch (error) {
      if (!isAbortError(error)) {
        logger.warn('Full audio upgrade failed', error);
      }
      throw error;
    } finally {
      const remaining = Math.max(0, (fullAudioUpgradeCountByCacheIdentity.get(cacheIdentity) || 1) - 1);
      if (remaining > 0) {
        fullAudioUpgradeCountByCacheIdentity.set(cacheIdentity, remaining);
      } else {
        fullAudioUpgradeCountByCacheIdentity.delete(cacheIdentity);
        fullAudioUpgradeInFlight.delete(cacheIdentity);
      }
      fullAudioUpgradePromises.delete(executionKey);
      if (latestFullAudioUpgradePromiseByCacheIdentity.get(cacheIdentity) === promise) {
        latestFullAudioUpgradePromiseByCacheIdentity.delete(cacheIdentity);
      }
    }
  })();

  fullAudioUpgradePromises.set(executionKey, promise);
  latestFullAudioUpgradePromiseByCacheIdentity.set(cacheIdentity, promise);
  return promise;
}

export async function getDecodedAudioWithTiming(
  cacheIdentity: string,
  normalizedUrl: string,
  signal?: AbortSignal | null,
  options?: { usePartialFetch?: boolean; requireFull?: boolean; inFlightKey?: string }
): Promise<DecodedAudioResolution> {
  let fetchMs = 0;
  let decodeMs = 0;
  let isPartial = false;
  const fetchUrl = assertAllowedAudioFetchUrl(normalizedUrl);
  let resolvedUrl = String(fetchUrl || '').trim();
  const resolveStartedAt = performance.now();
  const requireFull = Boolean(options?.requireFull);
  const inFlightKey = String(options?.inFlightKey || '').trim();

  if (requireFull) {
    const cachedFull = getCachedDecodedAudio(cacheIdentity);
    if (cachedFull?.completeness === 'full') {
      return {
        audioBuffer: cachedFull.audioBuffer,
        timing: { fetchMs: 0, decodeMs: 0 },
        isPartial: false,
        resolveMs: Math.round(performance.now() - resolveStartedAt),
        completeness: 'full',
        resolvedUrl: String(cachedFull.resolvedUrl || resolvedUrl || '').trim()
      };
    }

    const upgradePromise = latestFullAudioUpgradePromiseByCacheIdentity.get(cacheIdentity);
    if (upgradePromise) {
      await upgradePromise.catch(() => undefined);
      const upgraded = getCachedDecodedAudio(cacheIdentity);
      if (upgraded?.completeness === 'full') {
        return {
          audioBuffer: upgraded.audioBuffer,
          timing: { fetchMs: 0, decodeMs: 0 },
          isPartial: false,
          resolveMs: Math.round(performance.now() - resolveStartedAt),
          completeness: 'full',
          resolvedUrl: String(upgraded.resolvedUrl || resolvedUrl || '').trim()
        };
      }
    }
  }

  let factoryRan = false;
  const decoded = await getOrCreateDecodedAudio(cacheIdentity, async () => {
    factoryRan = true;
    throwIfAborted(signal);
    const usePartial = Boolean(options?.usePartialFetch) && !requireFull && !partialFetchDisabled;

    if (usePartial) {
      try {
        const fetchStartedAt = performance.now();
        const partial = await fetchPartialAudioArrayBuffer(fetchUrl, PARTIAL_FETCH_MAX_BYTES, signal);
        fetchMs = Math.round(performance.now() - fetchStartedAt);
        resolvedUrl = String(partial.resolvedUrl || fetchUrl || '').trim();
        throwIfAborted(signal);

        // Only use partial if the file is big enough to benefit
        if (partial.isPartial && (partial.totalSize === null || partial.totalSize > PARTIAL_FETCH_MIN_TOTAL_BYTES)) {
          // Start the full-track upgrade as soon as we know partial audio is useful,
          // so key analysis can inherit the in-flight full decode instead of opening it late.
          void scheduleFullAudioUpgrade(cacheIdentity, fetchUrl, signal);
          const decodeStartedAt = performance.now();
          const decoded = await decodeAudio(partial.arrayBuffer);
          decodeMs = Math.round(performance.now() - decodeStartedAt);
          isPartial = true;
          throwIfAborted(signal);

          return {
            audioBuffer: decoded,
            completeness: 'partial' as const,
            resolvedUrl: String(partial.resolvedUrl || fetchUrl || '').trim()
          };
        }
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (error instanceof RangeFetchUnsupportedError) {
          logger.debug('Partial range fetch unavailable; switching to explicit full fetch', {
            cacheIdentity,
            url: fetchUrl,
            error: error.message
          });
        } else {
          // Partial decode failed — disable for this session and fall through to full fetch
          logger.warn('Partial fetch/decode failed, falling back to full fetch', error);
          partialFetchDisabled = true;
        }
      }
    }

    // Full fetch path (existing behavior)
    const fetchStartedAt = performance.now();
    const fetched = await fetchAudioArrayBuffer(fetchUrl, signal);
    fetchMs = Math.round(performance.now() - fetchStartedAt);
    resolvedUrl = String(fetched.resolvedUrl || fetchUrl || '').trim();
    throwIfAborted(signal);

    const decodeStartedAt = performance.now();
    const decoded = await decodeAudio(fetched.arrayBuffer);
    decodeMs = Math.round(performance.now() - decodeStartedAt);
    throwIfAborted(signal);
    return {
      audioBuffer: decoded,
      completeness: 'full' as const,
      resolvedUrl: String(fetched.resolvedUrl || fetchUrl || '').trim()
    };
  }, {
    requireFull,
    inFlightKey: inFlightKey || buildDecodedAudioExecutionKey(
      cacheIdentity,
      fetchUrl,
      requireFull ? 'full' : 'partial'
    )
  });

  const resolveMs = Math.round(performance.now() - resolveStartedAt);

  // When the factory didn't run (cache hit or in-flight join), fetchMs/decodeMs
  // are still 0 — attribute the total resolve time to fetchMs so the timing
  // breakdown reflects the actual wait rather than reporting 0.
  if (!factoryRan && resolveMs > 0) {
    fetchMs = resolveMs;
  }

  return {
    audioBuffer: decoded.audioBuffer,
    timing: { fetchMs, decodeMs },
    isPartial,
    resolveMs,
    completeness: decoded.completeness,
    resolvedUrl: String(decoded.resolvedUrl || resolvedUrl || '').trim()
  };
}
