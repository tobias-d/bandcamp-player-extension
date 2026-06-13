export interface DetachedAudioState {
  src: string;
  currentTimeSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  playing: boolean;
}

export interface RuntimeOriginSnapshot {
  kind: 'attached' | 'detached';
  src: string;
  currentTimeSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  playing: boolean;
}

export function createAttachedOriginSnapshot(audio: HTMLAudioElement): RuntimeOriginSnapshot {
  const src = String(audio.currentSrc || audio.src || '').trim();
  const currentTimeSec = Number.isFinite(audio.currentTime) ? Number(audio.currentTime) : 0;
  const durationSec = Number.isFinite(audio.duration) ? Number(audio.duration) : 0;
  return {
    kind: 'attached',
    src,
    currentTimeSec,
    durationSec,
    volume: audio.volume,
    muted: audio.muted,
    playing: Boolean(src && !audio.paused && !audio.ended)
  };
}

export function createDetachedOriginSnapshot(state: DetachedAudioState): RuntimeOriginSnapshot {
  return {
    kind: 'detached',
    src: String(state.src || '').trim(),
    currentTimeSec: Number.isFinite(state.currentTimeSec) ? Number(state.currentTimeSec) : 0,
    durationSec: Number.isFinite(state.durationSec) ? Number(state.durationSec) : 0,
    volume: state.volume,
    muted: state.muted,
    playing: Boolean(state.playing)
  };
}
