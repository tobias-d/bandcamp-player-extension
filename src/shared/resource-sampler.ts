// Shared resource sampler used by every extension context (content script, background
// page / service worker, analysis workers, runtime audio host iframe, offscreen document)
// to approximate the CPU-pressure and memory numbers a browser task manager would show.
//
// Browsers do not expose true per-extension CPU or memory to extension code, so we use two
// in-context proxies:
//   - Event-loop lag: how late a fixed-interval timer fires versus when it was scheduled.
//     A blocked or saturated context fires its timer late, so lag is a CPU-pressure signal
//     that works identically in window, worker, and service-worker realms.
//   - JS heap via performance.memory: present in Chromium contexts only; feature-detected
//     and reported as null elsewhere (e.g. Firefox).
//
// The sampler only runs between start() and stop(). Callers gate that on the debug panel
// being open so there is zero idle overhead during normal playback — important because
// Firefox shares one audio thread across AudioContexts and is sensitive to background load.

const DEFAULT_INTERVAL_MS = 500;

export interface ContextResourceSample {
  startedAt: number;
  uptimeMs: number;
  tickCount: number;
  lagAvgMs: number;
  lagMaxMs: number;
  lagLastMs: number;
  heapUsedBytes: number | null;
  heapTotalBytes: number | null;
  heapLimitBytes: number | null;
  ts: number;
}

export interface ResourceSampler {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  snapshot(): ContextResourceSample | null;
}

interface PerformanceMemoryLike {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

// Feature-detect the non-standard performance.memory. Returns null when the realm does not
// expose it (Firefox, workers without the flag) so callers report heap as unavailable.
function readHeap(): PerformanceMemoryLike | null {
  const mem = (performance as Performance & { memory?: PerformanceMemoryLike }).memory;
  if (mem && typeof mem.usedJSHeapSize === 'number') {
    return mem;
  }
  return null;
}

export function createResourceSampler(intervalMs: number = DEFAULT_INTERVAL_MS): ResourceSampler {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;
  let nextExpectedAt = 0;
  let tickCount = 0;
  let lagSumMs = 0;
  let lagMaxMs = 0;
  let lagLastMs = 0;

  // Allocation-free hot path: a timer chain re-anchored to the actual fire time so drift
  // never compounds. `lag` is how much later than the scheduled interval this tick fired.
  const tick = (): void => {
    if (!running) {
      return;
    }
    const now = performance.now();
    const lag = Math.max(0, now - nextExpectedAt);
    tickCount += 1;
    lagSumMs += lag;
    if (lag > lagMaxMs) {
      lagMaxMs = lag;
    }
    lagLastMs = lag;
    nextExpectedAt = now + intervalMs;
    timer = globalThis.setTimeout(tick, intervalMs);
  };

  return {
    start() {
      if (running) {
        return;
      }
      running = true;
      startedAt = Date.now();
      tickCount = 0;
      lagSumMs = 0;
      lagMaxMs = 0;
      lagLastMs = 0;
      nextExpectedAt = performance.now() + intervalMs;
      timer = globalThis.setTimeout(tick, intervalMs);
    },
    stop() {
      running = false;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
        timer = null;
      }
    },
    isRunning() {
      return running;
    },
    snapshot() {
      if (!running) {
        return null;
      }
      const heap = readHeap();
      return {
        startedAt,
        uptimeMs: Date.now() - startedAt,
        tickCount,
        lagAvgMs: tickCount > 0 ? lagSumMs / tickCount : 0,
        lagMaxMs,
        lagLastMs,
        heapUsedBytes: heap ? heap.usedJSHeapSize : null,
        heapTotalBytes: heap ? heap.totalJSHeapSize : null,
        heapLimitBytes: heap ? heap.jsHeapSizeLimit : null,
        ts: Date.now()
      };
    }
  };
}
