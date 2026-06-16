import type { KeyAnalysisResult } from '@/shared/types';
import type { WaveformBands } from '@/shared/types';
import type { PreloadTarget } from '@/content/player/preloader';

interface PlaylistAnalysisCacheOptions {
  maxAttempts: number;
  normalizeKey(value: string | undefined | null): string;
}

export interface PreloadTargetFilterStats {
  kept: number;
  skipMissingKey: number;
  skipCached: number;
  skipAnalyzing: number;
  skipAttempts: number;
  skipLimit: number;
}

export interface PreloadTargetFilterResult {
  targets: PreloadTarget[];
  stats: PreloadTargetFilterStats;
}

export interface PlaylistAnalysisCache {
  bpmByCacheKey: Map<string, number>;
  waveformByCacheKey: Map<string, WaveformBands>;
  keyAnalysisByCacheKey: Map<string, KeyAnalysisResult>;
  failedCacheKeys: Set<string>;
  attemptCountByCacheKey: Map<string, number>;
  analyzingCacheKeys: Set<string>;
  resolvePreloadTargetKey(target: PreloadTarget): string;
  setAnalyzing(cacheKey: string, isAnalyzing: boolean): boolean;
  registerAttempt(cacheKey: string): void;
  canAttempt(cacheKey: string): boolean;
  clearAnalyzing(): void;
}

export interface PlaylistAnalysisCacheFacade {
  resolvePreloadTargetKey(target: PreloadTarget): string;
  setTrackAnalyzing(cacheKey: string, isAnalyzing: boolean): boolean;
  registerAnalysisAttempt(cacheKey: string): void;
  canAttemptAnalysis(cacheKey: string): boolean;
  hasCachedBpm(cacheKey: string | undefined): boolean;
  setCachedBpm(cacheKey: string, bpm: number): boolean;
  clearTrackAnalyzing(): void;
}

export function createPlaylistAnalysisCache(options: PlaylistAnalysisCacheOptions): PlaylistAnalysisCache {
  const { maxAttempts, normalizeKey } = options;
  const bpmByCacheKey = new Map<string, number>();
  const waveformByCacheKey = new Map<string, WaveformBands>();
  const keyAnalysisByCacheKey = new Map<string, KeyAnalysisResult>();
  const failedCacheKeys = new Set<string>();
  const attemptCountByCacheKey = new Map<string, number>();
  const analyzingCacheKeys = new Set<string>();

  const normalize = (value: string | undefined | null): string => normalizeKey(value);

  return {
    bpmByCacheKey,
    waveformByCacheKey,
    keyAnalysisByCacheKey,
    failedCacheKeys,
    attemptCountByCacheKey,
    analyzingCacheKeys,
    resolvePreloadTargetKey(target) {
      const cacheKey = normalize(target.cacheKey);
      if (cacheKey) {
        return cacheKey;
      }
      return normalize(target.url);
    },
    setAnalyzing(cacheKey, isAnalyzing) {
      const key = normalize(cacheKey);
      if (!key) {
        return false;
      }

      const has = analyzingCacheKeys.has(key);
      if (isAnalyzing) {
        if (has) {
          return false;
        }
        analyzingCacheKeys.add(key);
        return true;
      }

      if (!has) {
        return false;
      }
      analyzingCacheKeys.delete(key);
      return true;
    },
    registerAttempt(cacheKey) {
      const key = normalize(cacheKey);
      if (!key) {
        return;
      }
      attemptCountByCacheKey.set(key, (attemptCountByCacheKey.get(key) || 0) + 1);
    },
    canAttempt(cacheKey) {
      const key = normalize(cacheKey);
      if (!key) {
        return false;
      }
      return (attemptCountByCacheKey.get(key) || 0) < maxAttempts;
    },
    clearAnalyzing() {
      analyzingCacheKeys.clear();
    }
  };
}

export function createPlaylistAnalysisCacheFacade(
  cache: PlaylistAnalysisCache,
  normalizeKey: (value: string | undefined | null) => string
): PlaylistAnalysisCacheFacade {
  return {
    resolvePreloadTargetKey(target) {
      return cache.resolvePreloadTargetKey(target);
    },
    setTrackAnalyzing(cacheKey, isAnalyzing) {
      return cache.setAnalyzing(cacheKey, isAnalyzing);
    },
    registerAnalysisAttempt(cacheKey) {
      cache.registerAttempt(cacheKey);
    },
    canAttemptAnalysis(cacheKey) {
      return cache.canAttempt(cacheKey);
    },
    hasCachedBpm(cacheKey) {
      // setCachedBpm stores under normalizeKey(cacheKey); read with the same
      // normalization or a raw (un-normalized) key misses a cached value and
      // forces a redundant re-analysis.
      return Boolean(cacheKey && Number.isFinite(cache.bpmByCacheKey.get(normalizeKey(cacheKey))));
    },
    setCachedBpm(cacheKey, bpm) {
      const normalizedKey = normalizeKey(cacheKey);
      if (!normalizedKey || !Number.isFinite(bpm)) {
        return false;
      }
      const previousBpm = cache.bpmByCacheKey.get(normalizedKey);
      cache.bpmByCacheKey.set(normalizedKey, bpm);
      return previousBpm !== bpm;
    },
    clearTrackAnalyzing() {
      cache.clearAnalyzing();
    }
  };
}

export function filterPreloadTargets(
  unresolvedTargets: PreloadTarget[],
  maxTargets: number,
  cache: PlaylistAnalysisCache
): PreloadTargetFilterResult {
  const targets: PreloadTarget[] = [];
  let skipMissingKey = 0;
  let skipCached = 0;
  let skipAnalyzing = 0;
  let skipAttempts = 0;
  let skipLimit = 0;

  for (const target of unresolvedTargets) {
    if (targets.length >= maxTargets) {
      skipLimit += 1;
      break;
    }

    const key = cache.resolvePreloadTargetKey(target);
    if (!key) {
      skipMissingKey += 1;
      continue;
    }
    if (cache.bpmByCacheKey.has(key)) {
      skipCached += 1;
      continue;
    }
    if (cache.analyzingCacheKeys.has(key)) {
      skipAnalyzing += 1;
      continue;
    }
    if (!cache.canAttempt(key)) {
      skipAttempts += 1;
      continue;
    }

    targets.push(target);
  }

  return {
    targets,
    stats: {
      kept: targets.length,
      skipMissingKey,
      skipCached,
      skipAnalyzing,
      skipAttempts,
      skipLimit
    }
  };
}
