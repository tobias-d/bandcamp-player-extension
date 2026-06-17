import type { AnalysisResult, PlaylistState, TempoAdjustUiState } from '@/shared/types';

export const TEMPO_ADJUST_OFFSET_MIN_BPM = -8;
export const TEMPO_ADJUST_OFFSET_MAX_BPM = 8;
export const TEMPO_ADJUST_DEFAULT_MASTER_TEMPO = true;
export const TEMPO_ADJUST_MIN_PLAYBACK_RATE = 0.5;
export const TEMPO_ADJUST_MAX_PLAYBACK_RATE = 2;

export interface TempoAdjustControlState {
  offsetBpm: number;
  masterTempoEnabled: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function asFiniteNumber(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

export function clampTempoAdjustOffsetBpm(value: unknown): number {
  const parsed = asFiniteNumber(value);
  if (parsed === null) {
    return 0;
  }
  return clamp(Math.round(parsed), TEMPO_ADJUST_OFFSET_MIN_BPM, TEMPO_ADJUST_OFFSET_MAX_BPM);
}

function readCurrentPlaylistTrackBpm(playlist: PlaylistState | null | undefined): number | null {
  if (!playlist || !Array.isArray(playlist.tracks) || playlist.tracks.length === 0) {
    return null;
  }
  const currentTrack =
    playlist.tracks[playlist.currentIndex] ||
    playlist.tracks.find((track) => Boolean(track?.isCurrent)) ||
    null;
  const bpm = asFiniteNumber(currentTrack?.bpm);
  if (bpm === null || bpm <= 0) {
    return null;
  }
  return bpm;
}

export function resolveDetectedTempoBpm(
  analysis: AnalysisResult | null | undefined,
  playlist?: PlaylistState | null
): number | null {
  const analysisBpm = asFiniteNumber(analysis?.bpm);
  if (analysisBpm !== null && analysisBpm > 0) {
    return analysisBpm;
  }
  return readCurrentPlaylistTrackBpm(playlist);
}

export function computeTempoAdjustPlaybackRate(
  detectedBpm: number,
  offsetBpm: unknown
): number {
  const safeDetectedBpm = Number.isFinite(detectedBpm) ? Number(detectedBpm) : 0;
  if (safeDetectedBpm <= 0) {
    return 1;
  }

  const safeOffsetBpm = clampTempoAdjustOffsetBpm(offsetBpm);
  const targetBpm = safeDetectedBpm + safeOffsetBpm;
  if (!Number.isFinite(targetBpm) || targetBpm <= 0) {
    return TEMPO_ADJUST_MIN_PLAYBACK_RATE;
  }

  return clamp(
    targetBpm / safeDetectedBpm,
    TEMPO_ADJUST_MIN_PLAYBACK_RATE,
    TEMPO_ADJUST_MAX_PLAYBACK_RATE
  );
}

export function buildTempoAdjustUiState(
  controls: TempoAdjustControlState,
  analysis: AnalysisResult | null | undefined,
  playlist?: PlaylistState | null,
  options: { controlsEnabled?: boolean } = {}
): TempoAdjustUiState {
  const detectedBpm = resolveDetectedTempoBpm(analysis, playlist);
  const controlsEnabled = typeof options.controlsEnabled === 'boolean'
    ? options.controlsEnabled
    : Boolean(detectedBpm && detectedBpm > 0);
  return {
    detectedBpm: detectedBpm === null ? undefined : Math.round(detectedBpm),
    controlsEnabled,
    offsetBpm: clampTempoAdjustOffsetBpm(controls.offsetBpm),
    masterTempoEnabled: Boolean(controls.masterTempoEnabled)
  };
}
