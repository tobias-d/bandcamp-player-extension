import type { WaveformBands } from '@/shared/types';
import { computeWaveformBands } from '@/background/audio/waveform-core';
import { getDecodedAudioWithTiming } from '@/background/handlers/analysis-audio-fetch';

const WAVEFORM_VERSION = 'waveform-v6.5';
const WAVEFORM_BUCKETS = 300;
const WAVEFORM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedWaveform extends WaveformBands {
  ts: number;
}

const waveformCache = new Map<string, CachedWaveform>();
const waveformInFlight = new Map<string, Promise<WaveformBands>>();

function normalizeUrlIdentity(url: string): string {
  const src = String(url || '').trim();
  if (!src) {
    return '';
  }

  try {
    const parsed = new URL(src, 'https://bandcamp.com');
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return src;
  }
}

function waveformCacheKey(url: string, cacheIdentity?: string): string {
  const identity = String(cacheIdentity || '').trim() || normalizeUrlIdentity(url);
  return `${identity}|${WAVEFORM_VERSION}|${WAVEFORM_BUCKETS}`;
}

function isFresh(entry: CachedWaveform | undefined): entry is CachedWaveform {
  return Boolean(entry && Date.now() - entry.ts <= WAVEFORM_CACHE_TTL_MS);
}

function waveformExecutionKey(url: string, cacheIdentity?: string): string {
  return `${identityKey(url, cacheIdentity)}|fetch:${normalizeUrlIdentity(url)}|${WAVEFORM_VERSION}|${WAVEFORM_BUCKETS}`;
}

export async function computeAndCacheWaveformForUrl(
  url: string,
  cacheIdentity?: string
): Promise<WaveformBands> {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    throw new Error('Waveform url missing');
  }

  const key = waveformCacheKey(normalizedUrl, cacheIdentity);
  const executionKey = waveformExecutionKey(normalizedUrl, cacheIdentity);
  const cached = waveformCache.get(key);
  if (isFresh(cached)) {
    return cached;
  }

  const inFlight = waveformInFlight.get(executionKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async (): Promise<WaveformBands> => {
    const { audioBuffer } = await getDecodedAudioWithTiming(
      identityKey(normalizedUrl, cacheIdentity),
      normalizedUrl,
      undefined,
      {
        requireFull: true
      }
    );
    const waveform = computeWaveformBands(audioBuffer, WAVEFORM_BUCKETS);

    waveformCache.set(key, {
      ...waveform,
      ts: Date.now()
    });

    return waveform;
  })().finally(() => {
    waveformInFlight.delete(executionKey);
  });

  waveformInFlight.set(executionKey, promise);
  return promise;
}

function identityKey(url: string, cacheIdentity?: string): string {
  return String(cacheIdentity || '').trim() || normalizeUrlIdentity(url);
}
