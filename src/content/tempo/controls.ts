import type { AnalysisResult, PlaylistState, TempoAdjustUiState } from '@/shared/types';
import {
  TEMPO_ADJUST_DEFAULT_MASTER_TEMPO,
  buildTempoAdjustUiState,
  clampTempoAdjustOffsetBpm,
  computeTempoAdjustPlaybackRate,
  resolveDetectedTempoBpm
} from '@/shared/tempo-adjust';

export interface TempoAdjustControls {
  offsetBpm: number;
  masterTempoEnabled: boolean;
  tempoScale: number;
}

export interface TempoAdjustAudioTarget {
  applyTempoAdjust(playbackRate: number, masterTempoEnabled: boolean): void;
}

export function createDefaultTempoAdjustControls(): TempoAdjustControls {
  return {
    offsetBpm: 0,
    masterTempoEnabled: TEMPO_ADJUST_DEFAULT_MASTER_TEMPO,
    tempoScale: 1
  };
}

export function resetTempoAdjustControls(controls: TempoAdjustControls): void {
  controls.offsetBpm = 0;
  controls.tempoScale = 1;
}

export function resetTempoAdjustSession(controls: TempoAdjustControls): void {
  resetTempoAdjustControls(controls);
  controls.masterTempoEnabled = TEMPO_ADJUST_DEFAULT_MASTER_TEMPO;
}

export function setTempoAdjustOffset(controls: TempoAdjustControls, offsetBpm: number): boolean {
  const clamped = clampTempoAdjustOffsetBpm(offsetBpm);
  if (controls.offsetBpm === clamped) {
    return false;
  }
  controls.offsetBpm = clamped;
  return true;
}

export function setTempoAdjustMasterTempo(controls: TempoAdjustControls, enabled: boolean): boolean {
  const normalized = Boolean(enabled);
  if (controls.masterTempoEnabled === normalized) {
    return false;
  }
  controls.masterTempoEnabled = normalized;
  return true;
}

export function resolveTempoAdjustDetectedBpm(
  analysis: AnalysisResult | null | undefined,
  playlist: PlaylistState | null | undefined
): number | null {
  return resolveDetectedTempoBpm(analysis, playlist);
}

export function isTempoAdjustReady(
  analysis: AnalysisResult | null | undefined,
  playlist: PlaylistState | null | undefined
): boolean {
  const detected = resolveTempoAdjustDetectedBpm(analysis, playlist);
  return Boolean(detected && detected > 0);
}

export function computeTempoAdjustRate(
  controls: TempoAdjustControls,
  analysis: AnalysisResult | null | undefined,
  playlist: PlaylistState | null | undefined
): number {
  const detectedBpm = resolveTempoAdjustDetectedBpm(analysis, playlist);
  if (!detectedBpm || detectedBpm <= 0) {
    return 1;
  }
  return computeTempoAdjustPlaybackRate(detectedBpm, controls.offsetBpm);
}

export function applyTempoAdjust(
  controls: TempoAdjustControls,
  analysis: AnalysisResult | null | undefined,
  playlist: PlaylistState | null | undefined,
  target?: TempoAdjustAudioTarget | null
): number {
  const nextRate = computeTempoAdjustRate(controls, analysis, playlist);
  controls.tempoScale = nextRate;
  target?.applyTempoAdjust(nextRate, controls.masterTempoEnabled);
  return nextRate;
}

export function buildTempoAdjustControlsUiState(
  controls: TempoAdjustControls,
  analysis: AnalysisResult | null | undefined,
  playlist: PlaylistState | null | undefined
): TempoAdjustUiState {
  return buildTempoAdjustUiState(
    {
      offsetBpm: controls.offsetBpm,
      masterTempoEnabled: controls.masterTempoEnabled
    },
    analysis,
    playlist
  );
}
