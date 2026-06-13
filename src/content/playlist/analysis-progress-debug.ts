import type { KeyAnalysisResult, PlaylistTrack } from '@/shared/types';

interface BuildPlaylistAnalysisProgressLinesInput {
  tracks: PlaylistTrack[];
  preloadEnabled: boolean;
  keyAnalysisEnabled: boolean;
  bpmByCacheKey: Map<string, number>;
  keyAnalysisByCacheKey: Map<string, KeyAnalysisResult>;
  bpmAnalyzingCacheKeys: Set<string>;
  bpmFailedCacheKeys: Set<string>;
  keyFailedCacheKeys: Set<string>;
  bpmInFlight: boolean;
  bpmQueueLength: number;
  keyInFlightCount: number;
  keyQueueLength: number;
  bpmBlockedReason: string;
  keyBlockedReason: string;
  resolveTrackCacheKey(track: PlaylistTrack): string;
}

function resolveAnalysisState(input: {
  enabled: boolean;
  total: number;
  prepared: number;
  active: number;
  queue: number;
  failed: number;
}): string {
  if (!input.enabled) {
    return 'disabled';
  }
  if (input.total <= 0) {
    return 'idle';
  }
  if (input.failed > 0) {
    return 'error';
  }
  if (input.prepared >= input.total) {
    return 'complete';
  }
  if (input.active > 0 || input.queue > 0) {
    return 'preparing';
  }
  return 'idle';
}

export function buildPlaylistAnalysisProgressLines(input: BuildPlaylistAnalysisProgressLinesInput): string[] {
  const trackKeys = input.tracks
    .map((track) => String(input.resolveTrackCacheKey(track) || '').trim())
    .filter(Boolean);
  const total = input.tracks.length;
  const bpmPrepared = trackKeys.filter((key) => input.bpmByCacheKey.has(key)).length;
  const keyPrepared = trackKeys.filter((key) => input.keyAnalysisByCacheKey.has(key)).length;
  const bpmActive = Math.max(
    trackKeys.filter((key) => input.bpmAnalyzingCacheKeys.has(key)).length,
    input.bpmInFlight ? 1 : 0
  );
  const keyActive = Math.max(0, input.keyInFlightCount);
  const bpmFailed = trackKeys.filter((key) => input.bpmFailedCacheKeys.has(key)).length;
  const keyFailed = trackKeys.filter((key) => input.keyFailedCacheKeys.has(key)).length;
  const bpmMissing = Math.max(0, total - bpmPrepared);
  const keyMissing = Math.max(0, total - keyPrepared);
  const bpmState = resolveAnalysisState({
    enabled: input.preloadEnabled,
    total,
    prepared: bpmPrepared,
    active: bpmActive,
    queue: input.bpmQueueLength,
    failed: bpmFailed
  });
  const keyState = resolveAnalysisState({
    enabled: input.preloadEnabled && input.keyAnalysisEnabled,
    total,
    prepared: keyPrepared,
    active: keyActive,
    queue: input.keyQueueLength,
    failed: keyFailed
  });

  return [
    `Preload BPM analysis: prepared=${bpmPrepared}/${total} active=${bpmActive} queue=${input.bpmQueueLength} failed=${bpmFailed} missing=${bpmMissing} state=${bpmState} blocked=${input.bpmBlockedReason || '-'}`,
    `Preload key analysis: prepared=${keyPrepared}/${total} active=${keyActive} queue=${input.keyQueueLength} failed=${keyFailed} missing=${keyMissing} state=${keyState} enabled=${input.keyAnalysisEnabled ? '1' : '0'} blocked=${input.keyBlockedReason || '-'}`
  ];
}
