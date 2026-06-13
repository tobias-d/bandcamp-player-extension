import { createRuntimeAudioDspContext } from '@/content/player/runtime-audio/dsp';
import { fetchRuntimePlaybackAudio } from '@/content/player/runtime-audio/loader';
import type {
  RuntimeAudioEngine,
  RuntimeAudioEngineDebugEvent,
  RuntimeAudioEngineDebugSnapshot,
  RuntimeAudioPrepareInput,
  RuntimeAudioPrepareResult,
  RuntimeAudioPreparedSnapshot
} from '@/content/player/runtime-audio/types';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { resolveRuntimePredecodePolicy, type RuntimePredecodePolicy } from '@/shared/runtime-predecode-policy';
import { createLogger } from '@/utils/debug';

const logger = createLogger('AUDIO');

function shouldWarnRuntimeFetchFailure(url: string, reason: string, status?: number): boolean {
  const normalizedUrl = String(url || '').trim();
  const normalizedReason = String(reason || '').trim().toLowerCase();
  const normalizedStatus = Number.isFinite(status) ? Number(status) : 0;

  const isExpectedExpiredBandcampUrl = (
    normalizedStatus === 404 ||
    normalizedStatus === 410 ||
    normalizedReason === 'http-404' ||
    normalizedReason === 'http-410'
  ) && (
    normalizedUrl.includes('bandcamp.com/stream_redirect') ||
    normalizedUrl.includes('.bcbits.com/stream/')
  );

  return !isExpectedExpiredBandcampUrl;
}

function shouldCountRuntimePrepareFailure(url: string, reason: string, status?: number): boolean {
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (
    normalizedReason === 'stale-fetch' ||
    normalizedReason === 'stale-decode' ||
    normalizedReason === 'stale-prepare' ||
    normalizedReason.includes('abort')
  ) {
    return false;
  }
  return shouldWarnRuntimeFetchFailure(url, reason, status);
}

interface RuntimeAudioEngineOptions {
  storeDecodedBuffer?: boolean;
  // Resolved predecode policy injected by the caller so the engine shares one source of truth
  // with index.ts (which resolves it with the Chrome-only Performance-mode flag). When absent
  // the engine resolves the default policy itself so it stays usable standalone (e.g. Discover).
  predecodePolicy?: RuntimePredecodePolicy;
}

interface PreparedEntry {
  snapshot: RuntimeAudioPreparedSnapshot;
  buffer: AudioBuffer | null;
}

interface EncodedEntry {
  url: string;
  cacheKey?: string;
  audioData: ArrayBuffer;
  contentType?: string;
  bytes: number;
  lastUsedAt: number;
}

interface InFlightPrepareEntry {
  url: string;
  cacheKey?: string;
  controller: AbortController;
  promise: Promise<RuntimeAudioPrepareResult>;
}

const DEBUG_EVENT_LIMIT = 60;

export function createRuntimeAudioEngine(options: RuntimeAudioEngineOptions = {}): RuntimeAudioEngine {
  const storeDecodedBuffer = Boolean(options.storeDecodedBuffer);
  const dsp = storeDecodedBuffer ? createRuntimeAudioDspContext() : null;
  const runtimePredecodePolicy = options.predecodePolicy ?? resolveRuntimePredecodePolicy();
  const maxPrepared = runtimePredecodePolicy.maxPreparedTracks;
  const maxDecodedBytes = runtimePredecodePolicy.maxDecodedBytes;
  const maxEncodedBytes = runtimePredecodePolicy.maxEncodedBytes;

  let destroyed = false;
  let globalPrepareCounter = 0;
  const activePrepareTokens = new Map<string, number>();
  const preparedEntries = new Map<string, PreparedEntry>();
  // Retained encoded (compressed) blobs, kept across decoded-PCM eviction so a re-selected
  // track re-decodes locally instead of re-fetching. Bounded by maxEncodedBytes (LRU by last
  // use). decodeAudio() copies its input internally, so a retained blob can be decoded
  // repeatedly without being detached.
  const encodedEntries = new Map<string, EncodedEntry>();
  let encodedCacheHits = 0;
  let lastPreparedUrl = '';
  let prepareAttemptCount = 0;
  let evictionCount = 0;
  let staleFetchCount = 0;
  let staleDecodeCount = 0;
  let stalePrepareCount = 0;
  let prepareFailureCount = 0;
  let lastPrepareFailure = '';
  const recentEvents: RuntimeAudioEngineDebugEvent[] = [];
  const inFlightPrepareRequests = new Map<string, InFlightPrepareEntry>();

  const appendDebugEvent = (stage: string, detail: string): void => {
    recentEvents.push({
      ts: Date.now(),
      stage: String(stage || '-').trim() || '-',
      detail: String(detail || '-').trim() || '-'
    });
    if (recentEvents.length > DEBUG_EVENT_LIMIT) {
      recentEvents.splice(0, recentEvents.length - DEBUG_EVENT_LIMIT);
    }
  };

  const recordPrepareFailure = (url: string, stage: string, reason: string, status?: number): void => {
    if (!shouldCountRuntimePrepareFailure(url, reason, status)) {
      return;
    }
    prepareFailureCount += 1;
    lastPrepareFailure = `${stage}:${reason || 'unknown'}`;
  };

  const currentDecodedBytes = (): number => {
    let total = 0;
    for (const entry of preparedEntries.values()) {
      total += Math.max(0, Number(entry.snapshot.decodedByteLength) || 0);
    }
    return total;
  };

  // Evict oldest entries to stay under both the track-count cap and the decoded-byte
  // budget. `incomingDecodedBytes` is the entry about to be inserted, so we make room
  // for it before the set(). Byte eviction always keeps at least one entry: a single
  // track larger than the whole budget (e.g. a 38-min mix) must still be retainable on
  // its own rather than evicting itself in a loop.
  const evictIfNeeded = (incomingDecodedBytes = 0): void => {
    const overCount = (): boolean => preparedEntries.size >= maxPrepared;
    const overBytes = (): boolean =>
      maxDecodedBytes > 0 &&
      preparedEntries.size > 0 &&
      currentDecodedBytes() + incomingDecodedBytes > maxDecodedBytes;
    while (overCount() || overBytes()) {
      let oldestUrl = '';
      let oldestTime = Infinity;
      for (const [url, entry] of preparedEntries) {
        if (entry.snapshot.preparedAt < oldestTime) {
          oldestTime = entry.snapshot.preparedAt;
          oldestUrl = url;
        }
      }
      if (oldestUrl) {
        const evicted = preparedEntries.get(oldestUrl) || null;
        preparedEntries.delete(oldestUrl);
        activePrepareTokens.delete(oldestUrl);
        evictionCount += 1;
        appendDebugEvent(
          'evict',
          `url=${oldestUrl} cache=${evicted?.snapshot.cacheKey || '-'} bytes=${evicted?.snapshot.byteLength || 0} decodedBytes=${evicted?.snapshot.decodedByteLength || 0} reason=${overBytes() ? 'bytes' : 'count'}`
        );
      } else {
        break;
      }
    }
  };

  const currentEncodedBytes = (): number => {
    let total = 0;
    for (const entry of encodedEntries.values()) {
      total += Math.max(0, Number(entry.bytes) || 0);
    }
    return total;
  };

  const findEncodedEntry = (track: { url: string; cacheKey?: string }): EncodedEntry | null => {
    for (const entry of encodedEntries.values()) {
      if (hasSameTrackIdentity(track, { url: entry.url, cacheKey: entry.cacheKey })) {
        return entry;
      }
    }
    return null;
  };

  // Retain a compressed blob so a later re-selection skips the network. Evicts least-recently
  // used encoded blobs to stay under maxEncodedBytes (always keeps the new one).
  const retainEncoded = (
    url: string,
    cacheKey: string | undefined,
    audioData: ArrayBuffer,
    contentType: string | undefined
  ): void => {
    if (maxEncodedBytes <= 0 || !audioData || audioData.byteLength <= 0) {
      return;
    }
    const existing = findEncodedEntry({ url, cacheKey });
    if (existing) {
      existing.lastUsedAt = Date.now();
      return;
    }
    const bytes = audioData.byteLength;
    encodedEntries.set(url, { url, cacheKey, audioData, contentType, bytes, lastUsedAt: Date.now() });
    while (encodedEntries.size > 1 && currentEncodedBytes() > maxEncodedBytes) {
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [key, entry] of encodedEntries) {
        if (key === url) {
          continue; // never evict the just-retained blob
        }
        if (entry.lastUsedAt < oldestTime) {
          oldestTime = entry.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) {
        break;
      }
      const evicted = encodedEntries.get(oldestKey);
      encodedEntries.delete(oldestKey);
      appendDebugEvent('encoded-evict', `url=${oldestKey} bytes=${evicted?.bytes || 0}`);
    }
  };

  const buildPrepareRequestKey = (url: string, sourceVersion: number, cacheKey?: string): string =>
    `${url}|${sourceVersion}|${cacheKey || '-'}`;
  const hasSameTrackIdentity = (
    left: { url: string; cacheKey?: string },
    right: { url: string; cacheKey?: string }
  ): boolean =>
    Boolean(left.cacheKey && right.cacheKey && left.cacheKey === right.cacheKey) ||
    sourcesShareTrackIdentity(left.url, right.url);
  const abortInFlightPreparation = (): void => {
    for (const request of inFlightPrepareRequests.values()) {
      request.controller.abort();
    }
    inFlightPrepareRequests.clear();
  };

  return {
    async prepareTrack(input: RuntimeAudioPrepareInput): Promise<RuntimeAudioPrepareResult> {
      const url = String(input.url || '').trim();
      if (!url) {
        return { ok: false, reason: 'missing-url' };
      }

      const sourceVersion = Number.isFinite(input.sourceVersion) ? Number(input.sourceVersion) : -1;
      const cacheKey = String(input.cacheKey || '').trim() || undefined;
      const requestedTrack = { url, cacheKey };
      for (const entry of preparedEntries.values()) {
        if (hasSameTrackIdentity(requestedTrack, {
          url: entry.snapshot.url,
          cacheKey: entry.snapshot.cacheKey
        })) {
          appendDebugEvent(
            'prepare-reuse-prepared',
            `url=${url} cache=${cacheKey || '-'} prepared=${entry.snapshot.url}`
          );
          return { ok: true, track: entry.snapshot };
        }
      }
      const requestKey = buildPrepareRequestKey(url, sourceVersion, cacheKey);
      for (const request of inFlightPrepareRequests.values()) {
        if (hasSameTrackIdentity(requestedTrack, request)) {
          appendDebugEvent(
            'prepare-reuse-in-flight',
            `url=${url} cache=${cacheKey || '-'} active=${request.url}`
          );
          return request.promise;
        }
      }

      prepareAttemptCount += 1;
      const controller = new AbortController();
      let requestPromise: Promise<RuntimeAudioPrepareResult>;
      requestPromise = (async (): Promise<RuntimeAudioPrepareResult> => {
        const token = ++globalPrepareCounter;
        activePrepareTokens.set(url, token);
        appendDebugEvent(
          'prepare-start',
          `url=${url} cache=${cacheKey || '-'} sourceVersion=${sourceVersion}`
        );
        const isStale = (): boolean => destroyed || activePrepareTokens.get(url) !== token;

        let byteLength = 0;
        let decodedByteLength = 0;
        let durationSec = 0;
        let sampleRate = 0;
        let channels = 0;
        let contentType: string | undefined;
        let buffer: AudioBuffer | null = null;
        const prepareStartedAt = performance.now();
        let fetchStartedAt = 0;
        let fetchSettledAt = 0;
        let decodeStartedAt = 0;
        let decodeSettledAt = 0;

        if (storeDecodedBuffer && dsp) {
          // Prefer a retained encoded blob (decode-only, no network) over a fresh fetch.
          // decodeAudio copies its input internally, so the retained blob is never detached.
          let encodedData: ArrayBuffer | null = null;
          const cachedEncoded = findEncodedEntry(requestedTrack);
          if (cachedEncoded) {
            encodedCacheHits += 1;
            cachedEncoded.lastUsedAt = Date.now();
            encodedData = cachedEncoded.audioData;
            byteLength = cachedEncoded.bytes;
            contentType = cachedEncoded.contentType;
            appendDebugEvent('encoded-cache-hit', `url=${url} bytes=${byteLength}`);
          } else {
            logger.debug(`Runtime prepare fetch start src=${url}`);
            appendDebugEvent('fetch-start', `url=${url}`);
            fetchStartedAt = performance.now();
            const fetched = await fetchRuntimePlaybackAudio(url, controller.signal);
            fetchSettledAt = performance.now();
            if (isStale()) {
              staleFetchCount += 1;
              appendDebugEvent('stale-fetch', `url=${url}`);
              return { ok: false, reason: 'stale-fetch' };
            }
            if (!fetched.ok) {
              const logPayload = { url, reason: fetched.error, status: fetched.status };
              if (shouldWarnRuntimeFetchFailure(url, fetched.error, fetched.status)) {
                logger.warn('Runtime audio fetch failed', logPayload);
              } else {
                logger.debug(`Runtime audio fetch fallback src=${url} reason=${fetched.error} status=${fetched.status ?? '-'}`);
              }
              appendDebugEvent(
                'fetch-failure',
                `url=${url} reason=${fetched.error || 'unknown'} status=${fetched.status ?? '-'}`
              );
              recordPrepareFailure(url, 'fetch-failure', fetched.error || 'unknown', fetched.status);
              activePrepareTokens.delete(url);
              return { ok: false, reason: fetched.error };
            }

            byteLength = fetched.audioData.byteLength;
            contentType = fetched.contentType;
            encodedData = fetched.audioData;
            logger.debug(`Runtime prepare fetch settle src=${url} bytes=${byteLength}`);
            appendDebugEvent(
              'fetch-settle',
              `url=${url} bytes=${byteLength} contentType=${contentType || '-'} fetchMs=${Math.round(fetchSettledAt - fetchStartedAt)}`
            );
            retainEncoded(url, cacheKey, encodedData, contentType);
          }

          try {
            logger.debug(`Runtime prepare decode start src=${url}`);
            appendDebugEvent('decode-start', `url=${url}`);
            decodeStartedAt = performance.now();
            const decoded = await dsp.decodeAudio(encodedData);
            decodeSettledAt = performance.now();
            buffer = decoded.buffer;
            durationSec = decoded.durationSec;
            sampleRate = decoded.sampleRate;
            channels = decoded.channels;
            decodedByteLength =
              Math.max(0, Number(buffer.length) || 0) *
              Math.max(0, Number(buffer.numberOfChannels) || 0) *
              Float32Array.BYTES_PER_ELEMENT;
            logger.debug(
              `Runtime prepare decode settle src=${url} duration=${durationSec.toFixed(2)}s rate=${sampleRate} ch=${channels} pcmBytes=${decodedByteLength}`
            );
            appendDebugEvent(
              'decode-settle',
              `url=${url} duration=${durationSec.toFixed(2)} rate=${sampleRate} ch=${channels} decodeMs=${Math.round(decodeSettledAt - decodeStartedAt)} totalMs=${Math.round(decodeSettledAt - prepareStartedAt)}`
            );
          } catch (decodeError) {
            const reason = decodeError instanceof Error ? decodeError.message : String(decodeError);
            logger.warn('Runtime audio decode failed', { url, reason });
            appendDebugEvent('decode-failure', `url=${url} reason=${reason || 'unknown'}`);
            recordPrepareFailure(url, 'decode-failure', reason || 'unknown');
            activePrepareTokens.delete(url);
            return { ok: false, reason: `decode-failed: ${reason}` };
          }

          if (isStale()) {
            staleDecodeCount += 1;
            appendDebugEvent('stale-decode', `url=${url}`);
            return { ok: false, reason: 'stale-decode' };
          }
        }

        if (isStale()) {
          stalePrepareCount += 1;
          appendDebugEvent('stale-prepare', `url=${url}`);
          return { ok: false, reason: 'stale-prepare' };
        }

        const snapshot: RuntimeAudioPreparedSnapshot = {
          url,
          cacheKey,
          sourceVersion,
          byteLength,
          decodedByteLength,
          durationSec,
          sampleRate,
          channels,
          contentType,
          fetchMs: fetchStartedAt > 0 && fetchSettledAt >= fetchStartedAt
            ? Math.round(fetchSettledAt - fetchStartedAt)
            : 0,
          decodeMs: decodeStartedAt > 0 && decodeSettledAt >= decodeStartedAt
            ? Math.round(decodeSettledAt - decodeStartedAt)
            : 0,
          totalMs: Math.round(performance.now() - prepareStartedAt),
          preparedAt: Date.now()
        };

        evictIfNeeded(decodedByteLength);
        preparedEntries.set(url, { snapshot, buffer });
        lastPreparedUrl = url;
        activePrepareTokens.delete(url);
        logger.debug(`Runtime prepare setPreparedTrack src=${url}`);
        if (storeDecodedBuffer) {
          logger.debug(
            `Runtime track prepared src=${url} duration=${durationSec.toFixed(2)}s rate=${sampleRate} ch=${channels}`
          );
        } else {
          logger.debug(`Runtime track prepared src=${url} mode=host-owned`);
        }
        appendDebugEvent(
          'prepared',
          `url=${url} cache=${cacheKey || '-'} bytes=${byteLength} duration=${durationSec.toFixed(2)} hasBuffer=${buffer ? '1' : '0'} totalMs=${snapshot.totalMs}`
        );

        return { ok: true, track: snapshot };
      })().finally(() => {
        if (inFlightPrepareRequests.get(requestKey)?.promise === requestPromise) {
          inFlightPrepareRequests.delete(requestKey);
        }
      });

      inFlightPrepareRequests.set(requestKey, {
        url,
        cacheKey,
        controller,
        promise: requestPromise
      });
      return requestPromise;
    },

    clearPreparedTrack() {
      globalPrepareCounter += 1;
      activePrepareTokens.clear();
      abortInFlightPreparation();
      preparedEntries.clear();
      // A true source/playlist switch makes the retained encoded blobs useless; free them.
      encodedEntries.clear();
      lastPreparedUrl = '';
      appendDebugEvent('clear', 'prepared=0 inFlight=aborted encoded=0');
    },

    getPreparedTrack() {
      if (lastPreparedUrl) {
        return preparedEntries.get(lastPreparedUrl)?.snapshot ?? null;
      }
      return null;
    },

    getDebugSnapshot(): RuntimeAudioEngineDebugSnapshot {
      const entries = Array.from(preparedEntries.values())
        .sort((left, right) => right.snapshot.preparedAt - left.snapshot.preparedAt)
        .map((entry) => ({
          url: entry.snapshot.url,
          cacheKey: entry.snapshot.cacheKey,
          sourceVersion: entry.snapshot.sourceVersion,
          byteLength: entry.snapshot.byteLength,
          decodedByteLength: entry.snapshot.decodedByteLength,
          durationSec: entry.snapshot.durationSec,
          sampleRate: entry.snapshot.sampleRate,
          channels: entry.snapshot.channels,
          preparedAt: entry.snapshot.preparedAt,
          hasBuffer: Boolean(entry.buffer),
          fetchMs: entry.snapshot.fetchMs,
          decodeMs: entry.snapshot.decodeMs,
          totalMs: entry.snapshot.totalMs
        }));
      const preparedBytes = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.byteLength) || 0), 0);
      const preparedDecodedBytes = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.decodedByteLength) || 0), 0);
      const preparedDurationSec = entries.reduce((sum, entry) => sum + Math.max(0, Number(entry.durationSec) || 0), 0);

      return {
        maxPrepared,
        maxDecodedBytes,
        maxEncodedBytes,
        predecodeWindowTracks: runtimePredecodePolicy.windowTracks,
        maxConcurrentPredecode: runtimePredecodePolicy.maxConcurrentPredecode,
        deviceMemoryGb: runtimePredecodePolicy.deviceMemoryGb,
        capacityReason: runtimePredecodePolicy.reason,
        preparedCount: entries.length,
        preparedBytes,
        preparedDecodedBytes,
        preparedDurationSec,
        activePrepareCount: activePrepareTokens.size,
        activePrepareUrls: Array.from(activePrepareTokens.keys()).slice(0, 12),
        prepareAttemptCount,
        evictionCount,
        staleFetchCount,
        staleDecodeCount,
        stalePrepareCount,
        prepareFailureCount,
        lastPrepareFailure,
        lastPreparedUrl,
        encodedCacheCount: encodedEntries.size,
        encodedCacheBytes: currentEncodedBytes(),
        encodedCacheHits,
        entries,
        recentEvents: recentEvents.slice()
      };
    },

    findPrepared(url: string) {
      const needle = String(url || '').trim();
      if (!needle) {
        return null;
      }
      for (const entry of preparedEntries.values()) {
        if (sourcesShareTrackIdentity(entry.snapshot.url, needle)) {
          return { snapshot: entry.snapshot, buffer: entry.buffer };
        }
      }
      return null;
    },

    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      globalPrepareCounter += 1;
      activePrepareTokens.clear();
      abortInFlightPreparation();
      preparedEntries.clear();
      encodedEntries.clear();
      lastPreparedUrl = '';
      appendDebugEvent('destroy', 'engine-destroyed');
      void dsp?.close();
    }
  };
}
