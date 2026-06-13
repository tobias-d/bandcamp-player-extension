// Single-download authority for full encoded audio in the background service
// worker. Both background consumers — runtime predecode playback fetch
// (handleFetchPlaybackAudio) and BPM/waveform analysis fetch
// (fetchAudioArrayBuffer) — route through here so a track is downloaded once,
// regardless of which one asks first or which encoding (mp3-v0 / mp3-128) it
// would have requested.
//
// Keyed by Bandcamp trackId, NOT trackId+enc: the first full fetch wins and
// everyone reuses its bytes. For the current track the analysis/waveform fetch
// (the high-quality mp3-v0 origin stream, offered for owned tracks) runs before
// predecode, so v0 naturally wins and is reused for the waveform, the analysis,
// and playback. Non-playing tracks only expose mp3-128, so they dedupe on 128.
//
// decodeAudioData detaches its input ArrayBuffer, so every caller receives a
// private copy; the cached master is never handed out directly.

import { readTrackIdFromStreamUrl } from '@/shared/track-id';

export interface SharedEncodedAudio {
  arrayBuffer: ArrayBuffer;
  contentType?: string;
  resolvedUrl: string;
}

interface CacheEntry extends SharedEncodedAudio {
  ts: number;
}

// Short-lived: it only has to bridge the few-second window where the current
// track's analysis/waveform fetch and its predecode overlap. The content runtime
// owns the long-lived encoded retention.
const TTL_MS = 60_000;
const MAX_ENTRIES = 12;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

// Dedup key = the Bandcamp trackId, so analysis and predecode share regardless
// of which stream-URL shape (stream_redirect vs signed CDN) each one uses.
const trackKeyFromUrl = readTrackIdFromStreamUrl;

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.ts <= TTL_MS;
}

function pruneAndCap(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > TTL_MS) {
      cache.delete(key);
    }
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function copyOut(entry: CacheEntry): SharedEncodedAudio {
  // Private copy — the consumer's decodeAudioData will detach this buffer, the
  // cached master must stay intact for the next consumer.
  return {
    arrayBuffer: entry.arrayBuffer.slice(0),
    contentType: entry.contentType,
    resolvedUrl: entry.resolvedUrl
  };
}

/**
 * Returns the track's full encoded audio, fetching it at most once across all
 * background consumers. `fetcher` performs the actual network fetch (each caller
 * keeps its own host validation / credentials) and is invoked only on a cache
 * miss with no fetch already in flight for the same trackId.
 *
 * The shared fetch intentionally runs to completion independent of any single
 * caller's cancellation: callers still honour their own abort after this resolves
 * (the decode pipeline checks the signal), and a completed fetch populates the
 * cache for the other consumer. A URL without a parseable trackId is fetched
 * directly with no caching.
 */
export async function fetchSharedEncodedAudio(
  url: string,
  fetcher: () => Promise<SharedEncodedAudio>
): Promise<SharedEncodedAudio> {
  const key = trackKeyFromUrl(url);
  if (!key) {
    return fetcher();
  }

  const cached = cache.get(key);
  if (cached && isFresh(cached)) {
    return copyOut(cached);
  }

  const existing = inFlight.get(key);
  if (existing) {
    return copyOut(await existing);
  }

  const promise = (async (): Promise<CacheEntry> => {
    const fetched = await fetcher();
    const entry: CacheEntry = { ...fetched, ts: Date.now() };
    cache.set(key, entry);
    pruneAndCap();
    return entry;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return copyOut(await promise);
}
