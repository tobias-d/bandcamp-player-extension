import type {
  CancelPlaybackAudioResponse,
  ContentMessage,
  FetchPlaybackAudioResponse
} from '@/shared/types';
import { fetchSharedEncodedAudio } from '@/background/audio/encoded-audio-cache';

const PLAYBACK_AUDIO_FETCH_TIMEOUT_MS = 25_000;
const ALLOWED_PLAYBACK_AUDIO_FETCH_HOSTS = ['bandcamp.com', 'bcbits.com'];
const activePlaybackAudioFetches = new Map<string, AbortController>();

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + chunkSize) as unknown as number[]));
  }
  return btoa(binary);
}

function isAllowedPlaybackAudioFetchHostname(hostname: string): boolean {
  const normalizedHost = String(hostname || '').trim().toLowerCase();
  return ALLOWED_PLAYBACK_AUDIO_FETCH_HOSTS.some(
    (allowedHost) =>
      normalizedHost === allowedHost || normalizedHost.endsWith(`.${allowedHost}`)
  );
}

function shouldIncludePlaybackAudioCredentials(parsed: URL, requestedIncludeCredentials: boolean): boolean {
  return (
    requestedIncludeCredentials
    && parsed.hostname.toLowerCase() === 'bandcamp.com'
    && /\/stream_redirect\b/i.test(parsed.pathname)
  );
}

function validatePlaybackAudioFetchUrl(
  url: string,
  requestedIncludeCredentials: boolean
): { ok: true; url: string; includeCredentials: boolean } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid url' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported protocol: ${parsed.protocol || 'unknown'}` };
  }

  if (!isAllowedPlaybackAudioFetchHostname(parsed.hostname)) {
    return { ok: false, error: `unsupported host: ${parsed.hostname || 'unknown'}` };
  }

  return {
    ok: true,
    url: parsed.toString(),
    includeCredentials: shouldIncludePlaybackAudioCredentials(parsed, requestedIncludeCredentials)
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  requestId?: string
): Promise<Response> {
  const controller = new AbortController();
  if (requestId) {
    activePlaybackAudioFetches.set(requestId, controller);
  }
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(timedOut ? 'fetch-timeout' : 'fetch-cancelled');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
    if (requestId && activePlaybackAudioFetches.get(requestId) === controller) {
      activePlaybackAudioFetches.delete(requestId);
    }
  }
}

export function handleCancelPlaybackAudio(
  msg: Extract<ContentMessage, { type: 'CANCEL_PLAYBACK_AUDIO' }>
): Promise<CancelPlaybackAudioResponse> {
  const requestId = String(msg.requestId || '').trim();
  const controller = requestId ? activePlaybackAudioFetches.get(requestId) : undefined;
  if (controller) {
    controller.abort();
    activePlaybackAudioFetches.delete(requestId);
  }
  return Promise.resolve({
    ok: true,
    requestId,
    cancelled: Boolean(controller),
    ts: Date.now()
  });
}

export async function handleFetchPlaybackAudio(
  msg: Extract<ContentMessage, { type: 'FETCH_PLAYBACK_AUDIO' }>
): Promise<FetchPlaybackAudioResponse> {
  const url = String(msg.url || '').trim();
  if (!url) {
    return {
      ok: false,
      url: '',
      error: 'FETCH_PLAYBACK_AUDIO requires a url',
      ts: Date.now()
    };
  }

  const validation = validatePlaybackAudioFetchUrl(url, Boolean(msg.includeCredentials));
  if (!validation.ok) {
    return {
      ok: false,
      url,
      error: validation.error,
      ts: Date.now()
    };
  }

  try {
    // Route through the shared trackId-keyed cache so a track is fetched once
    // across predecode and the analysis/waveform path. On a cache hit no network
    // fetch runs, so the freshly-fetched HTTP status is not available — report
    // 200 for the served bytes.
    const shared = await fetchSharedEncodedAudio(validation.url, async () => {
      const response = await fetchWithTimeout(
        validation.url,
        {
          method: 'GET',
          credentials: validation.includeCredentials ? 'include' : 'omit'
        },
        PLAYBACK_AUDIO_FETCH_TIMEOUT_MS,
        String(msg.requestId || '').trim() || undefined
      );
      if (!response.ok) {
        throw new Error(`http-${response.status}`);
      }
      const audioData = await response.arrayBuffer();
      if (!audioData.byteLength) {
        throw new Error('empty-audio-buffer');
      }
      return {
        arrayBuffer: audioData,
        contentType: String(response.headers.get('content-type') || '').trim() || undefined,
        resolvedUrl: validation.url
      };
    });

    return {
      ok: true,
      url: shared.resolvedUrl || validation.url,
      status: 200,
      contentType: shared.contentType,
      audioDataBase64: arrayBufferToBase64(shared.arrayBuffer),
      ts: Date.now()
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Preserve the numeric HTTP status when the fetcher threw `http-NNN`, so
    // prepare-failure handling/telemetry can still distinguish expected expiry
    // (404/410) from real failures rather than seeing an undefined status.
    const statusMatch = message.match(/^http-(\d{3})$/);
    return {
      ok: false,
      url: validation.url,
      status: statusMatch ? Number(statusMatch[1]) : undefined,
      error: message,
      ts: Date.now()
    };
  }
}
