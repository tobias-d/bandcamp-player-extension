import {
  ERROR_BACKOFF_MS,
  MIN_FETCH_INTERVAL_MS,
  RATE_BACKOFF_MS
} from '@/background/handlers/tralbum/constants';

export interface TralbumRateLimiter {
  shouldRateLimit(now: number, releaseKey: string): string | null;
  noteRequestStart(releaseKey: string, at?: number): void;
  noteHttpAttempt(at?: number): void;
  noteHttpStatus(status: number, releaseKey: string, at?: number): void;
}

export function createTralbumRateLimiter(): TralbumRateLimiter {
  const lastFetchAtByRelease = new Map<string, number>();
  const errorBackoffUntilByRelease = new Map<string, number>();
  let globalBackoffUntil = 0;

  const sweepLastFetchByRelease = (now: number): void => {
    if (lastFetchAtByRelease.size <= 500) {
      return;
    }

    for (const [key, ts] of lastFetchAtByRelease.entries()) {
      if (now - ts > 2 * 60_000) {
        lastFetchAtByRelease.delete(key);
      }
    }
  };

  const sweepErrorBackoffByRelease = (now: number): void => {
    if (errorBackoffUntilByRelease.size <= 500) {
      return;
    }

    for (const [key, until] of errorBackoffUntilByRelease.entries()) {
      if (until <= now) {
        errorBackoffUntilByRelease.delete(key);
      }
    }
  };

  const noteBackoff = (status: number, releaseKey: string, at: number): void => {
    if (status === 429 || status === 403) {
      globalBackoffUntil = Math.max(globalBackoffUntil, at + RATE_BACKOFF_MS);
      return;
    }

    if (status >= 500 && releaseKey) {
      const current = errorBackoffUntilByRelease.get(releaseKey) ?? 0;
      errorBackoffUntilByRelease.set(releaseKey, Math.max(current, at + ERROR_BACKOFF_MS));
      sweepErrorBackoffByRelease(at);
    }
  };

  return {
    shouldRateLimit(now, releaseKey): string | null {
      if (now < globalBackoffUntil) {
        return `backoff-active:${globalBackoffUntil - now}ms`;
      }

      const releaseBackoffUntil = errorBackoffUntilByRelease.get(releaseKey) ?? 0;
      if (now < releaseBackoffUntil) {
        return `release-backoff:${releaseBackoffUntil - now}ms`;
      }

      const lastFetchAt = lastFetchAtByRelease.get(releaseKey) ?? 0;
      if (now - lastFetchAt < MIN_FETCH_INTERVAL_MS) {
        return `min-interval:${MIN_FETCH_INTERVAL_MS - (now - lastFetchAt)}ms`;
      }

      return null;
    },

    noteRequestStart(releaseKey, at = Date.now()): void {
      lastFetchAtByRelease.set(releaseKey, at);
      sweepLastFetchByRelease(at);
    },

    noteHttpAttempt(): void {
      // Intentionally no-op.
    },

    noteHttpStatus(status, releaseKey, at = Date.now()): void {
      noteBackoff(status, releaseKey, at);
    }
  };
}
