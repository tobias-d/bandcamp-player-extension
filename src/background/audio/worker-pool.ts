/**
 * Worker pool for parallel Essentia WASM analysis.
 *
 * Manages a fixed set of Web Workers, each with its own Essentia WASM
 * instance. Dispatches analysis requests to the first available worker
 * and queues overflow.
 */

import { createLogger } from '@/utils/debug';
import { browserApi } from '@/utils/browser-api';
import type { HPCPFrameResult, HPCPFrameStageTiming, PrefilterResult, WindowBounds } from '@/background/key/types';
import type { WorkerRequest, WorkerResponse } from './analysis-worker';
import { resolveWorkerCount, deriveConcurrencyConfig } from '@/shared/concurrency';
import type { ConcurrencyConfig } from '@/shared/concurrency';
import type { WorkerResourceReport } from '@/shared/types';

const logger = createLogger('WORKER-POOL');

const WARM_UP_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// A worker blocked in WASM cannot answer a perf request; the short timeout turns that into a
// null sample (rendered "blocked") rather than stalling the 1s diagnostics pull.
const PERF_REQUEST_TIMEOUT_MS = 1_500;

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TempoEstimateInput {
  signal16k: Float32Array;
  minBpm?: number;
  maxBpm?: number;
  targetMinBpm?: number;
  targetMaxBpm?: number;
  preferFasterAmbiguous?: boolean;
}

export interface TempoEstimateOutput {
  bpm: number;
  rawBpm: number;
  confidence: number;
  beatTypeAuto: string;
  method: string;
  timingMs: number;
}

export interface RhythmExtractInput {
  signal: Float32Array;
  minBpm?: number;
  maxBpm?: number;
}

export interface RhythmExtractOutput {
  bpm: number;
  confidence: number;
  ticks: number[];
  estimates: number[];
  bpmIntervals: number[];
  timingMs: number;
}

export interface HPCPChunkInput {
  signal16k: Float32Array;
  frameStarts: number[];
  startOffsetSample: number;
  pcpSize: number;
}

export interface HPCPChunkOutput {
  frames: HPCPFrameResult[];
  frameTiming: HPCPFrameStageTiming;
  timingMs: number;
}

export interface PrefilterChunkInput {
  signal16k: Float32Array;
  windows: WindowBounds[];
  prefilterFrameCount: number;
}

export interface PrefilterChunkOutput {
  prefilters: PrefilterResult[];
  timingMs: number;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  ready: boolean;
  pending: Map<string, PendingRequest>;
  // Busy-time accounting for the diagnostics busy-fraction metric. `busySince` is the
  // performance.now() of the current busy span (0 when idle); `busyAccumMs` is completed
  // busy time since the last setPerfSampling(true) reset.
  busySince: number;
  busyAccumMs: number;
}

interface QueuedJob {
  request: WorkerRequest;
  transferList: Transferable[];
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

let idCounter = 0;
function nextId(): string {
  return `w${++idCounter}`;
}

export type { ConcurrencyConfig } from '@/shared/concurrency';

/* ------------------------------------------------------------------ */
/*  Pool implementation                                                */
/* ------------------------------------------------------------------ */

class AnalysisWorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: QueuedJob[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private readonly poolSize = resolveWorkerCount();
  // Resource-diagnostics state. `perfSampling` and the per-slot accounting only matter while a
  // debug panel session is open; setPerfSampling toggles it. `perfPending` resolves the
  // dedicated get-perf-sample replies — kept separate from `slot.pending` so perf probes never
  // flip `busy` and skew the queue or busy fraction.
  private perfSampling = false;
  private perfSamplingStartedAt = 0;
  private perfPending = new Map<string, (perf: { sample: WorkerResourceReport['sample']; wasmHeapBytes: number | null }) => void>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    const workerUrl = this.resolveWorkerUrl();
    logger.info(`Initializing ${this.poolSize} workers from ${workerUrl}`);

    const warmUpPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(workerUrl);
      const slot: WorkerSlot = {
        worker,
        busy: false,
        ready: false,
        pending: new Map(),
        busySince: 0,
        busyAccumMs: 0
      };

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(slot, event.data);
      };

      worker.onerror = (event) => {
        logger.warn(`Worker ${i} error:`, event.message);
        this.handleWorkerError(slot, new Error(event.message || 'Worker error'));
      };

      this.slots.push(slot);

      warmUpPromises.push(
        this.sendToSlot(slot, { id: nextId(), type: 'warm-up' }, [], WARM_UP_TIMEOUT_MS)
          .then(() => {
            slot.ready = true;
            logger.info(`Worker ${i} ready`);
          })
      );
    }

    const results = await Promise.allSettled(warmUpPromises);
    const readyCount = results.filter((r) => r.status === 'fulfilled').length;

    if (readyCount === 0) {
      this.terminate();
      throw new Error('All workers failed to initialize');
    }

    this.initialized = true;
    logger.info(`Pool ready: ${readyCount}/${this.poolSize} workers`);
  }

  private resolveWorkerUrl(): string {
    if (browserApi.runtime?.getURL) {
      return browserApi.runtime.getURL('background/analysis-worker.js');
    }
    return 'background/analysis-worker.js';
  }

  // Update busy state while accumulating busy time across the transition. Perf probes bypass
  // this (they never set busy), so the accounting reflects real analysis work only.
  private setSlotBusy(slot: WorkerSlot, busy: boolean): void {
    if (busy === slot.busy) {
      return;
    }
    const now = performance.now();
    if (busy) {
      slot.busySince = now;
    } else {
      if (slot.busySince > 0) {
        slot.busyAccumMs += now - slot.busySince;
      }
      slot.busySince = 0;
    }
    slot.busy = busy;
  }

  private handleWorkerMessage(slot: WorkerSlot, response: WorkerResponse): void {
    if (response.type === 'perf-sample') {
      const resolvePerf = this.perfPending.get(response.id);
      if (resolvePerf) {
        resolvePerf({ sample: response.sample, wasmHeapBytes: response.wasmHeapBytes });
      }
      return;
    }

    const pending = slot.pending.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    slot.pending.delete(response.id);
    this.setSlotBusy(slot, slot.pending.size > 0);

    pending.resolve(response);
    this.drainQueue();
  }

  private handleWorkerError(slot: WorkerSlot, error: Error): void {
    for (const [id, pending] of slot.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      slot.pending.delete(id);
    }
    this.setSlotBusy(slot, false);
    slot.ready = false;
  }

  private sendToSlot(
    slot: WorkerSlot,
    request: WorkerRequest,
    transferList: Transferable[],
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(request.id);
        this.setSlotBusy(slot, slot.pending.size > 0);
        reject(new Error(`Worker request ${request.id} timed out after ${timeoutMs}ms`));
        this.drainQueue();
      }, timeoutMs);

      slot.pending.set(request.id, { resolve, reject, timer });
      this.setSlotBusy(slot, true);
      slot.worker.postMessage(request, transferList);
    });
  }

  private findIdleSlot(): WorkerSlot | null {
    return this.slots.find((s) => s.ready && !s.busy) ?? null;
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const slot = this.findIdleSlot();
      if (!slot) break;

      const job = this.queue.shift()!;
      this.sendToSlot(slot, job.request, job.transferList)
        .then(job.resolve, job.reject);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  isReady(): boolean {
    return this.initialized && this.slots.some((s) => s.ready);
  }

  async estimateTempo(input: TempoEstimateInput): Promise<TempoEstimateOutput> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized');
    }

    const id = nextId();
    const request: WorkerRequest = {
      id,
      type: 'estimate-tempo',
      signal16k: input.signal16k,
      options: {
        minBpm: input.minBpm,
        maxBpm: input.maxBpm,
        targetMinBpm: input.targetMinBpm,
        targetMaxBpm: input.targetMaxBpm,
        preferFasterAmbiguous: input.preferFasterAmbiguous
      }
    };
    const transferList: Transferable[] = [input.signal16k.buffer];

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const slot = this.findIdleSlot();
      if (slot) {
        this.sendToSlot(slot, request, transferList).then(resolve, reject);
      } else {
        this.queue.push({ request, transferList, resolve, reject });
      }
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Worker analysis failed');
    }
    if (response.type !== 'result') {
      throw new Error(`Unexpected worker response: ${response.type}`);
    }

    return {
      bpm: response.result?.bpm ?? 0,
      rawBpm: response.result?.rawBpm ?? response.result?.bpm ?? 0,
      confidence: response.result?.confidence ?? 0,
      beatTypeAuto: response.result?.beatTypeAuto ?? 'unknown',
      method: response.result?.method ?? 'unknown',
      timingMs: response.timingMs ?? 0
    };
  }

  async extractRhythm(input: RhythmExtractInput): Promise<RhythmExtractOutput> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized');
    }

    const id = nextId();
    const request: WorkerRequest = {
      id,
      type: 'extract-rhythm',
      signal: input.signal,
      minBpm: input.minBpm,
      maxBpm: input.maxBpm
    };
    const transferList: Transferable[] = [input.signal.buffer];

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const slot = this.findIdleSlot();
      if (slot) {
        this.sendToSlot(slot, request, transferList).then(resolve, reject);
      } else {
        this.queue.push({ request, transferList, resolve, reject });
      }
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Worker rhythm extraction failed');
    }
    if (response.type !== 'result') {
      throw new Error(`Unexpected worker response: ${response.type}`);
    }

    return {
      bpm: response.rhythm?.bpm ?? 0,
      confidence: response.rhythm?.confidence ?? 0,
      ticks: response.rhythm?.ticks ?? [],
      estimates: response.rhythm?.estimates ?? [],
      bpmIntervals: response.rhythm?.bpmIntervals ?? [],
      timingMs: response.timingMs ?? 0
    };
  }

  async computeHPCPChunk(input: HPCPChunkInput): Promise<HPCPChunkOutput> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized');
    }

    const id = nextId();
    const request: WorkerRequest = {
      id,
      type: 'compute-hpcp-chunk',
      signal16k: input.signal16k,
      frameStarts: input.frameStarts,
      startOffsetSample: input.startOffsetSample,
      pcpSize: input.pcpSize
    };
    const transferList: Transferable[] = [input.signal16k.buffer];

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const slot = this.findIdleSlot();
      if (slot) {
        this.sendToSlot(slot, request, transferList).then(resolve, reject);
      } else {
        this.queue.push({ request, transferList, resolve, reject });
      }
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Worker HPCP chunk failed');
    }
    if (response.type !== 'result') {
      throw new Error(`Unexpected worker response: ${response.type}`);
    }

    return {
      frames: response.hpcpChunk?.frames ?? [],
      frameTiming: response.hpcpChunk?.frameTiming ?? {
        frameCount: 0,
        vectorMs: 0,
        windowingMs: 0,
        spectrumMs: 0,
        peaksMs: 0,
        whiteningMs: 0,
        hpcpMs: 0,
        extractMs: 0
      },
      timingMs: response.timingMs ?? 0
    };
  }

  async computePrefilterChunk(input: PrefilterChunkInput): Promise<PrefilterChunkOutput> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized');
    }

    const id = nextId();
    const request: WorkerRequest = {
      id,
      type: 'compute-prefilter-chunk',
      signal16k: input.signal16k,
      windows: input.windows,
      prefilterFrameCount: input.prefilterFrameCount
    };
    const transferList: Transferable[] = [input.signal16k.buffer];

    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const slot = this.findIdleSlot();
      if (slot) {
        this.sendToSlot(slot, request, transferList).then(resolve, reject);
      } else {
        this.queue.push({ request, transferList, resolve, reject });
      }
    });

    if (response.type === 'error') {
      throw new Error(response.error || 'Worker prefilter chunk failed');
    }
    if (response.type !== 'result') {
      throw new Error(`Unexpected worker response: ${response.type}`);
    }

    return {
      prefilters: response.prefilterChunk?.prefilters ?? [],
      timingMs: response.timingMs ?? 0
    };
  }

  getConcurrencyConfig(): ConcurrencyConfig {
    return deriveConcurrencyConfig(this.poolSize);
  }

  getStatus(): { total: number; ready: number; busy: number; queued: number } {
    return {
      total: this.slots.length,
      ready: this.slots.filter((s) => s.ready).length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length
    };
  }

  // Fraction of the sampling window each worker spent busy, averaged across the pool. Includes
  // any in-progress busy span so a worker stuck in WASM still reads as fully busy.
  busyFraction(): number {
    if (!this.perfSampling || this.slots.length === 0) {
      return 0;
    }
    const now = performance.now();
    const elapsed = now - this.perfSamplingStartedAt;
    if (elapsed <= 0) {
      return 0;
    }
    let total = 0;
    for (const slot of this.slots) {
      total += this.slotBusyFraction(slot, now, elapsed);
    }
    return total / this.slots.length;
  }

  private slotBusyFraction(slot: WorkerSlot, now: number, elapsed: number): number {
    let accum = slot.busyAccumMs;
    if (slot.busy && slot.busySince > 0) {
      accum += now - slot.busySince;
    }
    return Math.min(1, Math.max(0, accum / elapsed));
  }

  // Start/stop per-worker sampling and reset busy accounting to the new window. Called when a
  // diagnostics session set transitions empty <-> non-empty. No-op cost when slots are empty
  // (e.g. the Chrome MV3 service worker, which owns no workers).
  setPerfSampling(enabled: boolean): void {
    this.perfSampling = enabled;
    if (enabled) {
      const now = performance.now();
      this.perfSamplingStartedAt = now;
      for (const slot of this.slots) {
        slot.busyAccumMs = 0;
        slot.busySince = slot.busy ? now : 0;
      }
    }
    for (const slot of this.slots) {
      slot.worker.postMessage({ id: nextId(), type: 'set-perf-sampling', enabled } as WorkerRequest);
    }
  }

  // Pull one perf sample per worker. busyFraction is computed pool-side (always exact); the
  // worker's own lag/heap sample is best-effort and resolves null on timeout (busy in WASM).
  async collectPerfReports(): Promise<WorkerResourceReport[]> {
    const now = performance.now();
    const elapsed = now - this.perfSamplingStartedAt;
    return Promise.all(
      this.slots.map((slot, index) => this.requestSlotPerf(slot, index, now, elapsed))
    );
  }

  private requestSlotPerf(
    slot: WorkerSlot,
    index: number,
    now: number,
    elapsed: number
  ): Promise<WorkerResourceReport> {
    const busyFraction = elapsed > 0 ? this.slotBusyFraction(slot, now, elapsed) : 0;
    return new Promise((resolve) => {
      const id = nextId();
      const finish = (sample: WorkerResourceReport['sample'], wasmHeapBytes: number | null): void => {
        this.perfPending.delete(id);
        resolve({ index, ready: slot.ready, busyFraction, sample, wasmHeapBytes });
      };
      const timer = setTimeout(() => finish(null, null), PERF_REQUEST_TIMEOUT_MS);
      this.perfPending.set(id, (perf) => {
        clearTimeout(timer);
        finish(perf.sample, perf.wasmHeapBytes);
      });
      slot.worker.postMessage({ id, type: 'get-perf-sample' } as WorkerRequest);
    });
  }

  terminate(): void {
    for (const slot of this.slots) {
      this.handleWorkerError(slot, new Error('Pool terminated'));
      slot.worker.terminate();
    }
    this.slots = [];
    this.queue = [];
    this.initialized = false;
    this.initPromise = null;
    this.perfPending.clear();
    this.perfSampling = false;
    logger.info('Pool terminated');
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

let pool: AnalysisWorkerPool | null = null;

export function getWorkerPool(): AnalysisWorkerPool {
  if (!pool) {
    pool = new AnalysisWorkerPool();
  }
  return pool;
}
