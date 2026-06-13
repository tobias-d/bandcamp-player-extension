import SignalsmithStretch, { type SignalsmithStretchNode } from 'signalsmith-stretch';
import {
  TEMPO_ADJUST_MAX_PLAYBACK_RATE,
  TEMPO_ADJUST_MIN_PLAYBACK_RATE
} from '@/shared/tempo-adjust';
import { extensionAssetUrl } from '@/utils/asset-url';
import { createLogger } from '@/utils/debug';

const logger = createLogger('AUDIO');
const DEFAULT_OUTPUT_CHANNELS = 2;
const SCHEDULE_LEAD_SECONDS = 0.04;
const SIGNALSMITH_WORKLET_URL = extensionAssetUrl('public/signalsmith/SignalsmithStretch.mjs');

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export interface TempoDspEngine {
  bindAudio(audio: HTMLAudioElement | null): void;
  setTempo(playbackRate: number, keyLockEnabled: boolean): void;
  destroy(): void;
}

function clampPlaybackRate(playbackRate: number): number {
  if (!Number.isFinite(playbackRate)) {
    return 1;
  }
  return Math.min(TEMPO_ADJUST_MAX_PLAYBACK_RATE, Math.max(TEMPO_ADJUST_MIN_PLAYBACK_RATE, playbackRate));
}

function resolvePitchShiftSemitones(playbackRate: number, keyLockEnabled: boolean): number {
  if (!keyLockEnabled || playbackRate <= 0) {
    return 0;
  }
  // Cancel the playback-rate pitch shift when key lock is enabled.
  return 12 * Math.log2(playbackRate);
}

function createContext(): AudioContext {
  const ContextCtor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!ContextCtor) {
    throw new Error('AudioContext unavailable');
  }
  return new ContextCtor();
}

export function createTempoDspEngine(): TempoDspEngine {
  let destroyed = false;
  let activeAudio: HTMLAudioElement | null = null;
  let activeSource: MediaElementAudioSourceNode | null = null;

  let desiredPlaybackRate = 1;
  let desiredKeyLockEnabled = true;

  let context: AudioContext | null = null;
  let stretchNode: SignalsmithStretchNode | null = null;
  const sourceByAudio = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  let startIssued = false;
  let syncChain: Promise<void> = Promise.resolve();

  const ensureContext = (): AudioContext => {
    if (!context) {
      context = createContext();
    }
    return context;
  };

  const ensureStretchNode = async (): Promise<SignalsmithStretchNode> => {
    if (stretchNode) {
      return stretchNode;
    }
    const ctx = ensureContext();
    const stretchFactory = SignalsmithStretch as typeof SignalsmithStretch & {
      moduleUrl?: string;
    };
    stretchFactory.moduleUrl = SIGNALSMITH_WORKLET_URL;
    const node = await stretchFactory(ctx, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [DEFAULT_OUTPUT_CHANNELS]
    });
    await node.configure({ preset: 'default' });
    node.connect(ctx.destination);
    stretchNode = node;
    return node;
  };

  const ensureSource = (audio: HTMLAudioElement): MediaElementAudioSourceNode => {
    const existing = sourceByAudio.get(audio);
    if (existing) {
      return existing;
    }
    const sourceNode = ensureContext().createMediaElementSource(audio);
    sourceByAudio.set(audio, sourceNode);
    return sourceNode;
  };

  const enqueueSync = (): void => {
    syncChain = syncChain
      .then(async () => {
        if (destroyed) {
          return;
        }
        const audio = activeAudio;
        if (!audio) {
          activeSource?.disconnect();
          activeSource = null;
          return;
        }

        const ctx = ensureContext();
        if (ctx.state === 'suspended') {
          await ctx.resume().catch(() => undefined);
        }

        const stretch = await ensureStretchNode();
        if (destroyed || audio !== activeAudio) {
          return;
        }

        const source = ensureSource(audio);
        if (source !== activeSource) {
          activeSource?.disconnect();
          source.connect(stretch);
          activeSource = source;
        }

        if (!startIssued) {
          await stretch.start();
          startIssued = true;
        }

        const playbackRate = clampPlaybackRate(desiredPlaybackRate);
        const semitones = resolvePitchShiftSemitones(playbackRate, desiredKeyLockEnabled);
        await stretch.schedule(
          {
            active: true,
            output: ctx.currentTime + SCHEDULE_LEAD_SECONDS,
            rate: playbackRate,
            semitones
          },
          true
        );
      })
      .catch((error: unknown) => {
        logger.warn('Tempo DSP sync failed', error);
      });
  };

  return {
    bindAudio(audio) {
      activeAudio = audio;
      enqueueSync();
    },
    setTempo(playbackRate, keyLockEnabled) {
      desiredPlaybackRate = clampPlaybackRate(playbackRate);
      desiredKeyLockEnabled = Boolean(keyLockEnabled);
      enqueueSync();
    },
    destroy() {
      destroyed = true;
      activeSource?.disconnect();
      activeSource = null;
      activeAudio = null;
      if (stretchNode) {
        try {
          stretchNode.disconnect();
        } catch {
          // Ignore node disconnect errors from closed contexts.
        }
      }
      if (context) {
        void context.close().catch(() => undefined);
      }
      stretchNode = null;
      context = null;
    }
  };
}
