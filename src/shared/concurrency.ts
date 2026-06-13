const MIN_POOL_SIZE = 2;
const MAX_POOL_SIZE = 12;

export interface ConcurrencyConfig {
  workerCount: number;
  maxConcurrentPreloads: number;
  maxConcurrentKeyAnalyses: number;
}

export function resolveWorkerCount(): number {
  const detected = Number(globalThis.navigator?.hardwareConcurrency);
  if (!Number.isFinite(detected) || detected <= 0) {
    return 3;
  }
  return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, detected - 2));
}

export function deriveConcurrencyConfig(workerCount: number): ConcurrencyConfig {
  return {
    workerCount,
    maxConcurrentPreloads: Math.min(Math.max(2, Math.floor(workerCount * 0.7)), 5),
    maxConcurrentKeyAnalyses: workerCount >= 10 ? 3 : workerCount >= 5 ? 2 : 1
  };
}
