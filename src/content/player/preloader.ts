import type { AnalysisResult } from '@/shared/types';
import type { WaveformBands } from '@/shared/types';
import { sendMessage } from '@/utils/messaging';
import { createLogger } from '@/utils/debug';

export interface PreloadTarget {
  url: string;
  fetchUrl?: string;
  cacheKey?: string;
}

export interface Preloader {
  setEnabled(enabled: boolean): void;
  setQueue(targets: PreloadTarget[]): void;
  cancel(): void;
  startWaveform(target: PreloadTarget): void;
  flushDeferredWaveforms(): void;
  maybeKickoff(options?: { blocked?: boolean }): Promise<void>;
  getDebugState(): { enabled: boolean; inFlight: boolean; queueLength: number; inFlightMs: number };
}

export type PreloadOutcome = 'success' | 'timeout' | 'error' | 'cancelled';

export interface PreloaderCallbacks {
  onTrackStart?(target: PreloadTarget): void;
  onTrackComplete?(
    target: PreloadTarget,
    result: AnalysisResult | null,
    outcome: PreloadOutcome,
    failureDetail: string
  ): void;
  shouldDeferWaveform?(
    target: PreloadTarget,
    result: AnalysisResult | null,
    outcome: PreloadOutcome
  ): boolean;
  onWaveformStart?(target: PreloadTarget): void;
  onWaveformComplete?(target: PreloadTarget, success: boolean, waveform: WaveformBands | null): void;
  onWaveformSkipped?(target: PreloadTarget, reason: string): void;
}

const logger = createLogger('ANALYZER');
const PRELOAD_ANALYZE_TIMEOUT_MS = 15_000;
const DEFAULT_maxConcurrentPreloads = 3;

function isWaveformBands(value: unknown): value is WaveformBands {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.peaksLow)
    && Array.isArray(record.peaksMid)
    && Array.isArray(record.peaksHigh)
    && Number.isFinite(record.duration)
    && Number.isFinite(record.buckets);
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? 'unknown-error');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`preload-timeout:${timeoutMs}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

export interface PreloaderOptions {
  maxConcurrentPreloads?: number;
}

export function createPreloader(callbacks: PreloaderCallbacks = {}, options: PreloaderOptions = {}): Preloader {
  const maxConcurrentPreloads = options.maxConcurrentPreloads ?? DEFAULT_maxConcurrentPreloads;
  let enabled = true;
  let queue: PreloadTarget[] = [];
  let activeCount = 0;
  let activeStartedAt = 0;
  let preloadRunId = 0;
  const activeTargetBySlotKey = new Map<string, PreloadTarget>();
  const deferredWaveformTargets = new Map<string, PreloadTarget>();
  const startedWaveformKeys = new Set<string>();

  const normalizeTargetKey = (target: PreloadTarget): string => {
    const cache = String(target.cacheKey || '').trim();
    if (cache) {
      return `cache:${cache}`;
    }
    return `url:${String(target.url || '').trim()}`;
  };

  const dedupeTargets = (targets: PreloadTarget[]): PreloadTarget[] => {
    const seen = new Set<string>();
    const result: PreloadTarget[] = [];

    for (const target of targets) {
      const url = String(target.url || '').trim();
      if (!url) {
        continue;
      }

      const normalized: PreloadTarget = {
        url,
        fetchUrl: String(target.fetchUrl || '').trim() || undefined,
        cacheKey: String(target.cacheKey || '').trim() || undefined
      };

      const key = normalizeTargetKey(normalized);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(normalized);
    }

    return result;
  };

  const resetWaveformState = (): void => {
    deferredWaveformTargets.clear();
    startedWaveformKeys.clear();
  };

  const cancelActivePreloadRequests = (): void => {
    for (const target of activeTargetBySlotKey.values()) {
      void sendMessage<{ cancelled: boolean }>({
        type: 'CANCEL_ANALYSIS',
        url: target.url,
        cacheKey: target.cacheKey
      }).catch(() => undefined);
    }
    activeTargetBySlotKey.clear();
  };

  const startWaveformInternal = (target: PreloadTarget, runId: number): void => {
    const key = normalizeTargetKey(target);
    if (startedWaveformKeys.has(key)) {
      return;
    }

    deferredWaveformTargets.delete(key);
    startedWaveformKeys.add(key);
    callbacks.onWaveformStart?.(target);
    void sendMessage<WaveformBands | { error?: string }>({
      type: 'GET_WAVEFORM',
      url: target.url,
      cacheKey: target.cacheKey
    })
      .then((response) => {
        if (runId !== preloadRunId) {
          return;
        }
        const waveform = isWaveformBands(response) ? response : null;
        const hasError = Boolean(
          response
            && typeof response === 'object'
            && typeof (response as { error?: unknown }).error === 'string'
            && String((response as { error?: unknown }).error || '').trim()
        );
        callbacks.onWaveformComplete?.(target, Boolean(waveform) && !hasError, waveform);
      })
      .catch((error) => {
        if (runId !== preloadRunId) {
          return;
        }
        logger.warn('silent preload waveform failed', {
          error: formatErrorDetail(error),
          url: target.url,
          cacheKey: target.cacheKey
        });
        callbacks.onWaveformComplete?.(target, false, null);
      });
  };

  const processOne = async (target: PreloadTarget, runId: number): Promise<void> => {
    const slotKey = `${runId}|${normalizeTargetKey(target)}`;
    activeTargetBySlotKey.set(slotKey, target);
    callbacks.onTrackStart?.(target);
    let result: AnalysisResult | null = null;
    let outcome: PreloadOutcome = 'error';
    let failureDetail = '';
    try {
      const response = await withTimeout(
        sendMessage<AnalysisResult | { error?: string }>({
          type: 'ANALYZE_TRACK_SILENT',
          url: target.url,
          fetchUrl: target.fetchUrl,
          cacheKey: target.cacheKey,
          // Silent preload owns BPM only. Preload key runs through the explicit
          // key queue so the pipeline stays BPM-first and then key.
          enableKeyAnalysis: false
        }),
        PRELOAD_ANALYZE_TIMEOUT_MS
      );
      if (response && typeof response === 'object' && !('error' in response) && !('cancelled' in response)) {
        result = response as AnalysisResult;
        outcome = 'success';
        if (!Number.isFinite(Number(result.bpm))) {
          failureDetail = 'analysis-result-missing-bpm';
        }
      } else if (
        response
        && typeof response === 'object'
        && 'bpm' in response
        && Number.isFinite((response as { bpm?: number }).bpm)
      ) {
        result = response as AnalysisResult;
        outcome = 'success';
      } else if (response && typeof response === 'object' && typeof (response as { error?: unknown }).error === 'string') {
        failureDetail = `response-error:${String((response as { error?: string }).error || '').trim() || 'unknown'}`;
      } else if (response && typeof response === 'object' && 'cancelled' in response) {
        outcome = 'cancelled';
        failureDetail = 'analysis-cancelled';
      } else {
        failureDetail = 'empty-analysis-response';
      }
    } catch (error) {
      const message = formatErrorDetail(error);
      if (message.startsWith('preload-timeout:')) {
        outcome = 'timeout';
      }
      failureDetail = message;
      logger.warn('silent preload analyze failed', {
        error: message,
        url: target.url,
        cacheKey: target.cacheKey
      });
    } finally {
      activeTargetBySlotKey.delete(slotKey);
      callbacks.onTrackComplete?.(target, result, outcome, failureDetail);
      if (runId !== preloadRunId) {
        callbacks.onWaveformSkipped?.(target, 'run-changed');
        return;
      }
      if (outcome === 'cancelled') {
        callbacks.onWaveformSkipped?.(target, 'analysis-cancelled');
        return;
      }

      if (callbacks.shouldDeferWaveform?.(target, result, outcome)) {
        deferredWaveformTargets.set(normalizeTargetKey(target), target);
        return;
      }

      startWaveformInternal(target, runId);
    }
  };

  const fillSlots = (runId: number): void => {
    while (
      runId === preloadRunId
      && enabled
      && activeCount < maxConcurrentPreloads
      && queue.length > 0
    ) {
      const target = queue.shift();
      if (!target?.url) {
        continue;
      }

      activeCount += 1;
      if (activeStartedAt === 0) {
        activeStartedAt = Date.now();
      }

      void processOne(target, runId).finally(() => {
        if (runId !== preloadRunId) {
          return;
        }
        activeCount = Math.max(0, activeCount - 1);
        if (activeCount === 0) {
          activeStartedAt = 0;
        }
        if (runId === preloadRunId) {
          fillSlots(runId);
        }
      });
    }
  };

  return {
    setEnabled(value) {
      enabled = value;
      if (!enabled) {
        preloadRunId += 1;
        cancelActivePreloadRequests();
        queue = [];
        activeCount = 0;
        activeStartedAt = 0;
        resetWaveformState();
      }
    },
    setQueue(targets) {
      queue = dedupeTargets(targets);
    },
    cancel() {
      preloadRunId += 1;
      cancelActivePreloadRequests();
      queue = [];
      activeCount = 0;
      activeStartedAt = 0;
      resetWaveformState();
    },
    startWaveform(target) {
      if (!enabled) {
        return;
      }
      startWaveformInternal(target, preloadRunId);
    },
    flushDeferredWaveforms() {
      if (!enabled) {
        return;
      }
      const targets = Array.from(deferredWaveformTargets.values());
      deferredWaveformTargets.clear();
      for (const target of targets) {
        startWaveformInternal(target, preloadRunId);
      }
    },
    async maybeKickoff(options) {
      if (
        activeCount > 0
        && activeStartedAt > 0
        && Date.now() - activeStartedAt > PRELOAD_ANALYZE_TIMEOUT_MS + 2_000
      ) {
        logger.warn('silent preload in-flight stale, forcing recovery', {
          inFlightMs: Date.now() - activeStartedAt,
          queueLength: queue.length,
          activeCount
        });
        activeCount = 0;
        activeStartedAt = 0;
      }

      if (!enabled || activeCount >= maxConcurrentPreloads || queue.length === 0 || options?.blocked) {
        return;
      }

      const runId = preloadRunId;
      fillSlots(runId);
    },
    getDebugState() {
      return {
        enabled,
        inFlight: activeCount > 0,
        queueLength: queue.length,
        inFlightMs: activeCount > 0 && activeStartedAt > 0
          ? Math.max(0, Date.now() - activeStartedAt)
          : 0
      };
    }
  };
}
