import { COMMAND_SOURCE } from '@/content/discover/origin-bridge/constants';
import { resolveObservedDiscoverStreamUrl } from '@/content/discover/origin-bridge/discover-resolver';
import { injectBridgeScript } from '@/content/discover/origin-bridge/inject';
import {
  bindOriginBridgeMessageListener,
  setDiscoverSelectionCallback,
  setDiscoverOriginTrackChangeCallback
} from '@/content/discover/origin-bridge/listener';

export { setDiscoverSelectionCallback, setDiscoverOriginTrackChangeCallback };
import {
  getLatestObservedDiscoverAudioEnded,
  getLatestObservedDiscoverAudioState,
  getLatestObservedDiscoverPayload,
  getLatestObservedDiscoverPayloadTrackMatch,
  getLatestObservedDiscoverSelection,
  getLatestOwnedPlaybackHostState,
  getLatestPageGlobals,
  getRecentApiIdentityHints,
  clearPendingLikesMutation,
  setPendingLikesMutation
} from '@/content/discover/origin-bridge/state';
import type {
  DiscoverAudioState,
  LikesMutationBridgeRequest,
  LikesMutationBridgeResult,
  OwnedPlaybackHostState
} from '@/content/discover/origin-bridge/types';
import { createLogger } from '@/utils/debug';

const logger = createLogger('BRIDGE');

export type { DiscoverAudioState, OwnedPlaybackHostState };

export {
  getLatestObservedDiscoverAudioEnded,
  getLatestObservedDiscoverAudioState,
  getLatestObservedDiscoverPayload,
  getLatestObservedDiscoverPayloadTrackMatch,
  getLatestObservedDiscoverSelection,
  getLatestOwnedPlaybackHostState,
  getLatestPageGlobals,
  getRecentApiIdentityHints,
  resolveObservedDiscoverStreamUrl
};

export function ensureOriginBridge(): void {
  try {
    injectBridgeScript();
    bindOriginBridgeMessageListener();
  } catch (error) {
    logger.warn('Failed to initialize origin bridge', error);
  }
}

export function sendDiscoverAudioCommand(
  command:
    | 'toggle-play-pause'
    | 'seek-fraction'
    | 'request-state'
    | 'pause'
    | 'prepare-runtime-takeover'
    | 'runtime-owns-playback'
    | 'load-track'
    | 'set-volume'
    | 'set-muted'
    | 'set-tempo-adjust',
  payload: {
    fraction?: number;
    streamUrl?: string;
    volume?: number;
    muted?: boolean;
    transient?: boolean;
    detached?: boolean;
    playbackRate?: number;
    preservesPitch?: boolean;
  } = {}
): void {
  const envelope: Record<string, unknown> = {
    source: COMMAND_SOURCE,
    type: 'DISCOVER_AUDIO_COMMAND',
    command
  };
  if (command === 'seek-fraction') {
    envelope.fraction = payload.fraction ?? 0;
  }
  if (command === 'load-track') {
    envelope.streamUrl = String(payload.streamUrl || '').trim();
    envelope.detached = Boolean(payload.detached);
  }
  if (command === 'runtime-owns-playback') {
    envelope.streamUrl = String(payload.streamUrl || '').trim();
  }
  if (command === 'set-volume') {
    envelope.volume = Number.isFinite(payload.volume) ? payload.volume : 1;
    envelope.transient = Boolean(payload.transient);
  }
  if (command === 'set-muted') {
    envelope.muted = Boolean(payload.muted);
    envelope.transient = Boolean(payload.transient);
  }
  if (command === 'set-tempo-adjust') {
    envelope.playbackRate = Number.isFinite(payload.playbackRate) ? payload.playbackRate : 1;
    envelope.preservesPitch = Boolean(payload.preservesPitch);
  }
  window.postMessage(envelope, '*');
}

export function sendOwnedPlaybackHostCommand(
  command: 'request-state' | 'ping',
  payload: Record<string, unknown> = {}
): void {
  window.postMessage(
    {
      source: COMMAND_SOURCE,
      type: 'OWNED_PLAYBACK_HOST_COMMAND',
      command,
      ...payload
    },
    '*'
  );
}

export function requestOwnedPlaybackHostState(): void {
  ensureOriginBridge();
  sendOwnedPlaybackHostCommand('request-state');
}

export function requestLikesMutationViaBridge(
  request: LikesMutationBridgeRequest,
  timeoutMs = 8_000
): Promise<LikesMutationBridgeResult> {
  ensureOriginBridge();
  const requestId = `likes-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const timeout = Math.max(1_000, Math.floor(timeoutMs));

  return new Promise<LikesMutationBridgeResult>((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      clearPendingLikesMutation(requestId);
      reject(new Error('bridge-timeout'));
    }, timeout);

    setPendingLikesMutation(requestId, {
      resolve: (payload) => {
        resolve({
          ok: Boolean(payload.ok),
          status: Number.isFinite(Number(payload.status)) ? Number(payload.status) : undefined,
          error: payload.error ? String(payload.error) : undefined,
          reason: payload.reason ? String(payload.reason) : undefined,
          attempt: payload.attempt ? String(payload.attempt) : undefined,
          data: payload.data
        });
      },
      reject,
      timerId
    });

    window.postMessage(
      {
        source: COMMAND_SOURCE,
        type: 'LIKES_MUTATION_COMMAND',
        command: 'toggle-wishlist',
        requestId,
        payload: request
      },
      '*'
    );
  });
}
