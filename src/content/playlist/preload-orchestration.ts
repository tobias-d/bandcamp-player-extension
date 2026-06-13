import type { KeyAnalysisResult } from '@/shared/types';
import type { PreloadTarget } from '@/content/player/preloader';
import type { PreloadTargetFilterStats } from '@/content/playlist/analysis-cache';

export interface PreloadKeyTask {
  target: PreloadTarget;
  bpm: number;
}

interface BuildPreloadEpochTargetsInput {
  targets: PreloadTarget[];
  resolvePreloadTargetKey(target: PreloadTarget): string;
  isTerminal(cacheKey: string): boolean;
}

interface FilterDeferredPreloadTargetsInput {
  targets: PreloadTarget[];
  resolvePreloadTargetKey(target: PreloadTarget): string;
  isTerminal(cacheKey: string): boolean;
  deferredRetryUntilByCacheKey: Map<string, number>;
  now?: number;
}

interface BuildPreloadKeyTasksInput {
  targets: PreloadTarget[];
  maxTargets: number;
  resolvePreloadTargetKey(target: PreloadTarget): string;
  bpmByCacheKey: Map<string, number>;
  keyAnalysisByCacheKey: Map<string, KeyAnalysisResult>;
  failedCacheKeys: Set<string>;
}

interface BuildPreloadAttemptSignatureInput {
  prefix: string;
  targets: PreloadTarget[];
  resolvePreloadTargetKey(target: PreloadTarget): string;
  attemptCountByCacheKey: Map<string, number>;
}

interface BuildDormantPreloadSyncSignatureInput {
  blocked: boolean;
  targetsLength: number;
  unresolvedTargetCount: number;
  runnableSignature: string;
  previousRunnableSignature: string;
  contextParts: Array<string | number>;
  stats: PreloadTargetFilterStats;
}

export function buildPreloadTargetSignature(prefix: string, targets: PreloadTarget[]): string {
  return `${prefix}|${targets
    .map((target) => `${target.cacheKey || '-'}@${target.url}`)
    .join(',')}`;
}

export function buildPreloadAttemptSignature(input: BuildPreloadAttemptSignatureInput): string {
  const { prefix, targets, resolvePreloadTargetKey, attemptCountByCacheKey } = input;
  return `${prefix}|${targets
    .map((target) => {
      const key = resolvePreloadTargetKey(target);
      const attempts = key ? (attemptCountByCacheKey.get(key) || 0) : 0;
      return `${target.cacheKey || '-'}@${target.url}#a${attempts}`;
    })
    .join(',')}`;
}

export function buildDormantPreloadSyncSignature(input: BuildDormantPreloadSyncSignatureInput): string {
  if (
    input.blocked ||
    input.targetsLength > 0 ||
    input.unresolvedTargetCount === 0 ||
    input.runnableSignature !== input.previousRunnableSignature
  ) {
    return '';
  }

  return [
    ...input.contextParts.map((part) => String(part || '-')),
    input.unresolvedTargetCount,
    input.stats.skipAnalyzing,
    input.stats.skipCached,
    input.stats.skipAttempts
  ].join('|');
}

export function buildPreloadKeyTaskSignature(prefix: string, tasks: PreloadKeyTask[]): string {
  return `${prefix}|${tasks
    .map(({ target, bpm }) => `${target.cacheKey || '-'}@${target.url}#b${bpm}`)
    .join(',')}`;
}

export function buildPreloadEpochTargets(input: BuildPreloadEpochTargetsInput): PreloadTarget[] {
  const { targets, resolvePreloadTargetKey, isTerminal } = input;
  return targets.filter((target) => {
    const key = resolvePreloadTargetKey(target);
    return Boolean(key) && !isTerminal(key);
  });
}

export function filterDeferredPreloadTargets(input: FilterDeferredPreloadTargetsInput): PreloadTarget[] {
  const {
    targets,
    resolvePreloadTargetKey,
    isTerminal,
    deferredRetryUntilByCacheKey,
    now = Date.now()
  } = input;

  return targets.filter((target) => {
    const key = resolvePreloadTargetKey(target);
    if (!key || isTerminal(key)) {
      return false;
    }
    const deferredUntil = deferredRetryUntilByCacheKey.get(key) || 0;
    if (deferredUntil > now) {
      return false;
    }
    if (deferredUntil > 0) {
      deferredRetryUntilByCacheKey.delete(key);
    }
    return true;
  });
}

export function buildPreloadKeyTasks(input: BuildPreloadKeyTasksInput): PreloadKeyTask[] {
  const {
    targets,
    maxTargets,
    resolvePreloadTargetKey,
    bpmByCacheKey,
    keyAnalysisByCacheKey,
    failedCacheKeys
  } = input;

  return targets
    .flatMap((target) => {
      const key = resolvePreloadTargetKey(target);
      if (!key || keyAnalysisByCacheKey.has(key) || failedCacheKeys.has(key)) {
        return [];
      }
      const bpm = bpmByCacheKey.get(key);
      if (!Number.isFinite(bpm)) {
        return [];
      }
      return [{
        target,
        bpm: Math.round(Number(bpm))
      }];
    })
    .slice(0, maxTargets);
}
