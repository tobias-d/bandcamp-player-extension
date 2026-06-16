/**
 * Discover runtime audio controller — creates a RuntimeAudioController for
 * bandcamp.com/discover pages using a stub bridge that forces the detached path.
 */
import type { AudioBridge } from '@/content/player/audio-bridge';
import {
  createRuntimeAudioController,
  type RuntimeAudioController
} from '@/content/player/runtime-audio/controller';
import type { DetachedAudioState } from '@/content/player/runtime-audio/origin-snapshot';
import type {
  RuntimeAudioEngine,
  RuntimeAudioOwnershipDebugState,
  RuntimeAudioPlaybackState,
  RuntimeStretchCapability
} from '@/content/player/runtime-audio/types';
import {
  getLatestObservedDiscoverAudioState,
  sendDiscoverAudioCommand
} from '@/content/discover/origin-bridge';

interface CreateDiscoverRuntimeAudioControllerInput {
  engine: RuntimeAudioEngine;
  onPlaybackState(state: RuntimeAudioPlaybackState): void;
  onPlaybackEnded(): void;
  onSkipTrack(direction: 1 | -1): void;
  onOwnershipChange?(owned: boolean, state: RuntimeAudioOwnershipDebugState): void;
  onRuntimeCapability?(capability: RuntimeStretchCapability): void;
  onRuntimeSourceChanged?(src: string): void;
  onTakeoverDebug?(reason: string, stage: string): void;
  onPendingRuntimeSelectionChange?(pending: boolean): void;
  requestCurrentRuntimePrepare?(reason: string): void;
}

/**
 * Creates a stub AudioBridge for Discover that forces the detached path.
 * This bridge does not have direct access to HTMLAudioElement (origin-controlled),
 * so all operations route through sendDiscoverAudioCommand.
 */
function createDiscoverStubAudioBridge(callbacks: {
  onSkipTrack: (dir: 1 | -1) => void;
}): AudioBridge {
  return {
    ensureActiveAudio: () => null,
    getActiveAudio: () => null,
    togglePlayPause: () => sendDiscoverAudioCommand('toggle-play-pause'),
    setVolume: (volume, options) => sendDiscoverAudioCommand('set-volume', {
      volume,
      transient: Boolean(options?.transient)
    }),
    setMuted: (muted, options) => sendDiscoverAudioCommand('set-muted', {
      muted,
      transient: Boolean(options?.transient)
    }),
    // Discover tempo adjustment must be handled by the runtime host only.
    applyTempoAdjust: () => {},
    // Discover origin audio is page-context owned; native transition smoothing
    // is handled by that bridge rather than this stub.
    prepareNativeTransition: () => {},
    prepareRuntimeTakeover: () => sendDiscoverAudioCommand('prepare-runtime-takeover'),
    pause: () => sendDiscoverAudioCommand('pause'),
    loadTrack: (streamUrl, options) => {
      sendDiscoverAudioCommand('load-track', { streamUrl, detached: options?.detached ?? false });
      return true;
    },
    seekToFraction: (fraction) => sendDiscoverAudioCommand('seek-fraction', { fraction }),
    skipTrack: (direction) => callbacks.onSkipTrack(direction),
    destroy: () => {}
  };
}

/**
 * Reads the current Discover audio state and converts it to DetachedAudioState
 * for the runtime controller's detached path.
 */
function getDiscoverDetachedAudioState(): DetachedAudioState | null {
  const observed = getLatestObservedDiscoverAudioState(2500);
  if (!observed?.src) {
    return null;
  }
  return {
    src: observed.src,
    currentTimeSec: observed.currentTimeSec,
    durationSec: observed.durationSec,
    volume: observed.volume,
    muted: observed.muted,
    playing: !observed.paused
  };
}

/**
 * Creates a RuntimeAudioController for Discover pages.
 * This controller uses a stub bridge that forces the detached audio path.
 */
export function createDiscoverRuntimeAudioController(
  input: CreateDiscoverRuntimeAudioControllerInput
): RuntimeAudioController {
  const bridge = createDiscoverStubAudioBridge({
    onSkipTrack: input.onSkipTrack
  });

  const controller = createRuntimeAudioController({
    bridge,
    engine: input.engine,
    getDetachedAudioState: () => getDiscoverDetachedAudioState(),
    onPlaybackState: input.onPlaybackState,
    onPlaybackEnded: input.onPlaybackEnded,
    onOwnershipChange: input.onOwnershipChange,
    onRuntimeCapability: input.onRuntimeCapability,
    onRuntimeSourceChanged: input.onRuntimeSourceChanged,
    claimRuntimePlayback: (src) => sendDiscoverAudioCommand('runtime-owns-playback', { streamUrl: src }),
    onTakeoverDebug: input.onTakeoverDebug,
    onPendingRuntimeSelectionChange: input.onPendingRuntimeSelectionChange,
    requestCurrentRuntimePrepare: input.requestCurrentRuntimePrepare
  });

  return controller;
}
