type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
};

export interface RuntimeAudioDecodedTrack {
  buffer: AudioBuffer;
  durationSec: number;
  sampleRate: number;
  channels: number;
}

export interface RuntimeAudioDspContext {
  decodeAudio(audioData: ArrayBuffer): Promise<RuntimeAudioDecodedTrack>;
  close(): Promise<void>;
}

function createAudioContext(): AudioContext {
  const ContextCtor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!ContextCtor) {
    throw new Error('AudioContext unavailable');
  }
  return new ContextCtor();
}

function createOfflineAudioContext(): OfflineAudioContext | null {
  const OfflineCtor =
    window.OfflineAudioContext || (window as WebkitWindow).webkitOfflineAudioContext;
  if (!OfflineCtor) {
    return null;
  }
  // Minimal valid context; used only for decodeAudioData so it never touches
  // the hardware output path during silent runtime preparation.
  return new OfflineCtor(1, 1, 44_100);
}

export function createRuntimeAudioDspContext(): RuntimeAudioDspContext {
  let context: AudioContext | null = null;

  const ensureContext = (): AudioContext => {
    if (!context || context.state === 'closed') {
      context = createAudioContext();
    }
    return context;
  };

  return {
    async decodeAudio(audioData) {
      const copied = audioData.slice(0);
      const offlineCtx = createOfflineAudioContext();
      const buffer = offlineCtx
        ? await offlineCtx.decodeAudioData(copied)
        : await ensureContext().decodeAudioData(copied);
      return {
        buffer,
        durationSec: Number.isFinite(buffer.duration) ? Number(buffer.duration) : 0,
        sampleRate: Number.isFinite(buffer.sampleRate) ? Number(buffer.sampleRate) : 0,
        channels: Number.isFinite(buffer.numberOfChannels) ? Number(buffer.numberOfChannels) : 0
      };
    },
    async close() {
      if (!context || context.state === 'closed') {
        return;
      }
      const current = context;
      context = null;
      await current.close().catch(() => undefined);
    }
  };
}
