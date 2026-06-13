import type {
  CancelPlaybackAudioResponse,
  FetchPlaybackAudioResponse
} from '@/shared/types';
import type { RuntimeAudioFetchResult } from '@/content/player/runtime-audio/types';
import { sendMessage } from '@/utils/messaging';

let runtimePlaybackAudioRequestSeq = 0;

function shouldIncludeRuntimePlaybackCredentials(url: string): boolean {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return false;
  }

  try {
    const parsed = new URL(normalizedUrl, 'https://bandcamp.com');
    return parsed.hostname === 'bandcamp.com' && /\/stream_redirect\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function fetchRuntimePlaybackAudio(
  url: string,
  cancellationSignal?: AbortSignal
): Promise<RuntimeAudioFetchResult> {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl) {
    return {
      ok: false,
      url: '',
      error: 'missing-url'
    };
  }

  const includeCredentials = shouldIncludeRuntimePlaybackCredentials(normalizedUrl);
  const requestId = `runtime-audio-${++runtimePlaybackAudioRequestSeq}`;
  const cancelRequest = (): void => {
    void sendMessage<CancelPlaybackAudioResponse>({
      type: 'CANCEL_PLAYBACK_AUDIO',
      requestId
    }).catch(() => undefined);
  };
  cancellationSignal?.addEventListener('abort', cancelRequest, { once: true });

  // Runtime preparation owns one extension-routed request per track. Direct
  // content-script fetches cannot reliably read Bandcamp stream_redirect URLs.
  try {
    if (cancellationSignal?.aborted) {
      cancelRequest();
      return {
        ok: false,
        url: normalizedUrl,
        error: 'fetch-cancelled'
      };
    }

    const response = await sendMessage<FetchPlaybackAudioResponse>({
      type: 'FETCH_PLAYBACK_AUDIO',
      url: normalizedUrl,
      includeCredentials,
      requestId
    });

    if (!response?.ok) {
      return {
        ok: false,
        url: response?.url || normalizedUrl,
        status: response?.status,
        error: response?.error || 'fetch-failed'
      };
    }

    const b64 = response.audioDataBase64;
    if (!b64) {
      return {
        ok: false,
        url: response.url || normalizedUrl,
        status: response.status,
        error: 'empty-audio-buffer'
      };
    }

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return {
      ok: true,
      url: response.url || normalizedUrl,
      status: response.status ?? 200,
      contentType: response.contentType,
      audioData: bytes.buffer
    };
  } catch (error) {
    return {
      ok: false,
      url: normalizedUrl,
      error: cancellationSignal?.aborted
        ? 'fetch-cancelled'
        : (error instanceof Error ? error.message : String(error))
    };
  } finally {
    cancellationSignal?.removeEventListener('abort', cancelRequest);
  }
}
