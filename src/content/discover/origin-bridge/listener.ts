import { MESSAGE_SOURCE } from '@/content/discover/origin-bridge/constants';
import type { BridgeMessage } from '@/content/discover/origin-bridge/types';
import {
  setLatestDiscoverAudioEnded,
  setLatestDiscoverAudioState,
  setLatestOwnedPlaybackHostState,
  setLatestObservedPayload,
  setLatestObservedSelection,
  setLatestPageGlobals,
  takePendingLikesMutation,
  upsertApiIdentityHint
} from '@/content/discover/origin-bridge/state';

let listenerBound = false;
let discoverSelectionCallback: ((url: string) => void) | null = null;
let originTrackChangeCallback: ((src: string) => void) | null = null;

export function setDiscoverSelectionCallback(cb: (url: string) => void): void {
  discoverSelectionCallback = cb;
}

export function setDiscoverOriginTrackChangeCallback(cb: (src: string) => void): void {
  originTrackChangeCallback = cb;
}

export function bindOriginBridgeMessageListener(): void {
  if (listenerBound) {
    return;
  }
  listenerBound = true;

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as BridgeMessage | undefined;
    if (!data || data.source !== MESSAGE_SOURCE) {
      return;
    }

    if (data.type === 'DISCOVER_OBSERVED') {
      setLatestObservedPayload(data.payload, data.ts);
      return;
    }

    if (data.type === 'DISCOVER_SELECTION') {
      const payload = data.payload as { url?: string };
      if (typeof payload?.url === 'string') {
        setLatestObservedSelection(payload.url, data.ts);
        discoverSelectionCallback?.(payload.url);
      }
      return;
    }

    if (data.type === 'PAGE_GLOBALS') {
      const payload = data.payload as {
        tralbum?: unknown;
        band?: unknown;
        page?: unknown;
        fan?: unknown;
        collection?: unknown;
        wishlist?: unknown;
        bc?: unknown;
      };
      setLatestPageGlobals(payload, data.ts);
      return;
    }

    if (data.type === 'API_HINT') {
      const payload = data.payload as {
        bandId?: unknown;
        tralbumId?: unknown;
        tralbumType?: unknown;
        trackId?: unknown;
        url?: unknown;
      };
      upsertApiIdentityHint(payload);
      return;
    }

    if (data.type === 'DISCOVER_AUDIO_STATE') {
      const payload = data.payload as {
        src?: unknown;
        paused?: unknown;
        ended?: unknown;
        currentTimeSec?: unknown;
        durationSec?: unknown;
        volume?: unknown;
        muted?: unknown;
      };
      setLatestDiscoverAudioState(payload);
      return;
    }

    if (data.type === 'DISCOVER_AUDIO_ENDED') {
      const payload = data.payload as {
        src?: unknown;
        currentTimeSec?: unknown;
        durationSec?: unknown;
      };
      setLatestDiscoverAudioEnded(payload);
      return;
    }

    if (data.type === 'OWNED_PLAYBACK_HOST_STATE') {
      const payload = data.payload as {
        status?: unknown;
        phase?: unknown;
        engine?: unknown;
        detail?: unknown;
        currentSrc?: unknown;
        playing?: unknown;
        detachedReady?: unknown;
        lastCommand?: unknown;
        lastCommandDetail?: unknown;
        lastCommandAt?: unknown;
        lastAudioEvent?: unknown;
        lastAudioEventDetail?: unknown;
        lastAudioEventAt?: unknown;
        trackedAudioCount?: unknown;
        knownAudioCount?: unknown;
        playingAudioCount?: unknown;
        activeSrc?: unknown;
        playingSrcs?: unknown;
      };
      setLatestOwnedPlaybackHostState(payload);
      return;
    }

    if (data.type === 'DISCOVER_ORIGIN_TRACK_CHANGE') {
      const payload = data.payload as { src?: unknown };
      const src = String(payload?.src ?? '').trim();
      if (src) {
        originTrackChangeCallback?.(src);
      }
      return;
    }

    if (data.type === 'LIKES_MUTATION_RESULT') {
      const payload = data.payload as { requestId?: unknown } & Record<string, unknown>;
      const requestId = String(payload?.requestId ?? '').trim();
      if (!requestId) {
        return;
      }
      const pending = takePendingLikesMutation(requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timerId);
      pending.resolve(payload);
    }
  });
}
