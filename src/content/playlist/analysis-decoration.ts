import type { PlaylistTrack } from '@/shared/types';
import type { KeyAnalysisResult } from '@/shared/types';
import { buildKeyDisplay } from '@/shared/key-confidence';

export interface DecorationCaches {
  bpmByKey: ReadonlyMap<string, number>;
  keyAnalysisByKey: ReadonlyMap<string, KeyAnalysisResult>;
  analyzingKeys: ReadonlySet<string>;
  failedKeys: ReadonlySet<string>;
  preloadKeyAnalyzingKeys: ReadonlySet<string>;
  deferredRetryUntilByKey: ReadonlyMap<string, number>;
  attemptCountByKey?: ReadonlyMap<string, number>;
  maxAttempts?: number;
}

export interface DecorationContext {
  keyAnalysisEnabled: boolean;
  currentTrackCacheKey: string | undefined;
  currentTrackKeyLoading: boolean;
  resolveCacheKey(track: PlaylistTrack): string | undefined;
}

export interface DecorationResult {
  tracks: PlaylistTrack[];
  changed: boolean;
}

export function decoratePlaylistTracks(
  tracks: PlaylistTrack[],
  caches: DecorationCaches,
  context: DecorationContext
): DecorationResult {
  let changed = false;

  const decorated = tracks.map((track) => {
    const cacheKey = context.resolveCacheKey(track);
    const bpm = cacheKey ? caches.bpmByKey.get(cacheKey) : undefined;
    const keyAnalysis = context.keyAnalysisEnabled && cacheKey
      ? caches.keyAnalysisByKey.get(cacheKey)
      : undefined;
    const deferredUntil = cacheKey ? (caches.deferredRetryUntilByKey.get(cacheKey) || 0) : 0;
    const isDeferred = deferredUntil > Date.now();
    // A track that timed out but is waiting for its deferred retry keeps showing
    // the loading spinner rather than an empty "--". On large playlists, BPM
    // fetch/decode contends with the runtime predecode and several tracks can be
    // deferred ~20s before they recover; without this they flash "--" then a BPM.
    const isAnalyzing = (cacheKey ? caches.analyzingKeys.has(cacheKey) : false) || isDeferred;
    const attempts = caches.attemptCountByKey && cacheKey
      ? (caches.attemptCountByKey.get(cacheKey) || 0)
      : 0;
    const isFailed = cacheKey
      ? (caches.failedKeys.has(cacheKey) && !isDeferred)
        || (
          caches.maxAttempts !== undefined
          && !Number.isFinite(bpm)
          && !isAnalyzing
          && !isDeferred
          && attempts >= caches.maxAttempts
        )
      : false;
    const nextBpm = Number.isFinite(bpm) ? Number(bpm) : undefined;
    const currentBpm = Number.isFinite(track.bpm) ? Number(track.bpm) : undefined;
    const isPreloadKeyLoading = Boolean(
      context.keyAnalysisEnabled
      && !keyAnalysis
      && cacheKey
      && caches.preloadKeyAnalyzingKeys.has(cacheKey)
    );
    const isKeyLoading = Boolean(
      isPreloadKeyLoading
      || (
        !keyAnalysis
        && context.currentTrackKeyLoading
        && cacheKey
        && context.currentTrackCacheKey
        && cacheKey === context.currentTrackCacheKey
      )
    );
    const keyDisplay = context.keyAnalysisEnabled
      ? buildKeyDisplay(keyAnalysis, { isAnalyzing: isKeyLoading })
      : buildKeyDisplay(undefined, { isAnalyzing: false });
    const nextKey1 = keyDisplay.key1.value;
    const nextKey2 = keyDisplay.key2.value;
    const nextKey1Level = keyDisplay.key1.level;
    const nextKey2Level = keyDisplay.key2.level;
    const nextKey1Loading = keyDisplay.key1.loading;
    const nextKey2Loading = keyDisplay.key2.loading;
    const nextKey1Score = keyDisplay.key1.score;
    const nextKey2Score = keyDisplay.key2.score;

    if (
      currentBpm === nextBpm
      && Boolean(track.isAnalyzing) === isAnalyzing
      && Boolean(track.analysisFailed) === isFailed
      && track.key1 === nextKey1
      && track.key2 === nextKey2
      && track.key1Level === nextKey1Level
      && track.key2Level === nextKey2Level
      && Boolean(track.key1Loading) === nextKey1Loading
      && Boolean(track.key2Loading) === nextKey2Loading
      && Number(track.key1Score || 0) === nextKey1Score
      && Number(track.key2Score || 0) === nextKey2Score
    ) {
      return track;
    }

    changed = true;
    return {
      ...track,
      bpm: nextBpm,
      isAnalyzing,
      analysisFailed: isFailed,
      key1: nextKey1,
      key2: nextKey2,
      key1Level: nextKey1Level,
      key2Level: nextKey2Level,
      key1Loading: nextKey1Loading,
      key2Loading: nextKey2Loading,
      key1Score: nextKey1Score,
      key2Score: nextKey2Score
    };
  });

  return { tracks: decorated, changed };
}
