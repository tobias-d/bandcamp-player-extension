import type { AudioBridge } from '@/content/player/audio-bridge';
import { PlayerState } from '@/content/player/state';
import {
  applyTempoAdjust,
  isTempoAdjustReady,
  resolveTempoAdjustDetectedBpm,
  resetTempoAdjustControls,
  resetTempoAdjustSession,
  setTempoAdjustMasterTempo,
  setTempoAdjustOffset,
  type TempoAdjustControls
} from '@/content/tempo/controls';

function toControls(state: PlayerState): TempoAdjustControls {
  return {
    offsetBpm: state.tempoAdjustOffsetBpm,
    masterTempoEnabled: state.tempoAdjustMasterTempoEnabled,
    tempoScale: state.tempoScale
  };
}

function fromControls(state: PlayerState, controls: TempoAdjustControls): void {
  state.tempoAdjustOffsetBpm = controls.offsetBpm;
  state.tempoAdjustMasterTempoEnabled = controls.masterTempoEnabled;
  state.tempoScale = controls.tempoScale;
}

export function resolvePlayerDetectedTempoBpm(state: PlayerState): number | null {
  return resolveTempoAdjustDetectedBpm(state.lastAnalysis, state.playlist);
}

export function isPlayerTempoAdjustControlReady(state: PlayerState): boolean {
  return isTempoAdjustReady(state.lastAnalysis, state.playlist)
    && Boolean(state.runtimeStretchCapability?.supported);
}

export function isPlayerTempoAdjustReady(state: PlayerState): boolean {
  return isPlayerTempoAdjustControlReady(state);
}

export function applyPlayerTempoAdjust(state: PlayerState, bridge: AudioBridge | null): number {
  const controls = toControls(state);
  const playbackRate = applyTempoAdjust(controls, state.lastAnalysis, state.playlist, bridge);
  fromControls(state, controls);
  return playbackRate;
}

export function setPlayerTempoAdjustOffset(state: PlayerState, offsetBpm: number): boolean {
  const controls = toControls(state);
  const changed = setTempoAdjustOffset(controls, offsetBpm);
  fromControls(state, controls);
  return changed;
}

export function setPlayerTempoAdjustMasterTempo(state: PlayerState, enabled: boolean): boolean {
  const controls = toControls(state);
  const changed = setTempoAdjustMasterTempo(controls, enabled);
  fromControls(state, controls);
  return changed;
}

export function resetPlayerTempoAdjustControls(state: PlayerState): void {
  const controls = toControls(state);
  resetTempoAdjustControls(controls);
  fromControls(state, controls);
}

export function resetPlayerTempoAdjustSession(state: PlayerState): void {
  const controls = toControls(state);
  resetTempoAdjustSession(controls);
  fromControls(state, controls);
}
