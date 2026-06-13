/**
 * Analysis worker entry point.
 *
 * Each worker loads its own Essentia WASM instance and processes
 * analysis requests independently, enabling true CPU parallelism
 * for preloaded track analysis.
 */

import { computeHPCPFrameMapWithTiming } from '@/background/key/hpcp';
import { computePrefilterBatch } from '@/background/key/prefilter';
import type { HPCPFrameResult, HPCPFrameStageTiming, PrefilterResult, WindowBounds } from '@/background/key/types';
import { createResourceSampler, type ContextResourceSample } from '@/shared/resource-sampler';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TempoWorkerOptions {
  minBpm?: number;
  maxBpm?: number;
  targetMinBpm?: number;
  targetMaxBpm?: number;
  preferFasterAmbiguous?: boolean;
}

export type WorkerRequest =
  | { id: string; type: 'warm-up' }
  | { id: string; type: 'estimate-tempo'; signal16k: Float32Array; options?: TempoWorkerOptions }
  | { id: string; type: 'extract-rhythm'; signal: Float32Array; minBpm?: number; maxBpm?: number }
  | {
    id: string;
    type: 'compute-prefilter-chunk';
    signal16k: Float32Array;
    windows: WindowBounds[];
    prefilterFrameCount: number;
  }
  | {
    id: string;
    type: 'compute-hpcp-chunk';
    signal16k: Float32Array;
    frameStarts: number[];
    startOffsetSample: number;
    pcpSize: number;
  }
  | { id: string; type: 'set-perf-sampling'; enabled: boolean }
  | { id: string; type: 'get-perf-sample' };

export interface WorkerTempoResult {
  bpm?: number;
  rawBpm?: number;
  confidence?: number;
  beatTypeAuto?: string;
  method?: string;
}

export interface WorkerRhythmResult {
  bpm: number;
  confidence: number;
  ticks: number[];
  estimates: number[];
  bpmIntervals: number[];
}

export interface WorkerHPCPChunkResult {
  frames: HPCPFrameResult[];
  frameTiming: HPCPFrameStageTiming;
}

export interface WorkerPrefilterChunkResult {
  prefilters: PrefilterResult[];
}

export type WorkerResponse =
  | { id: string; type: 'ready' }
  | {
    id: string;
    type: 'result';
    result?: WorkerTempoResult;
    rhythm?: WorkerRhythmResult;
    prefilterChunk?: WorkerPrefilterChunkResult;
    hpcpChunk?: WorkerHPCPChunkResult;
    timingMs?: number;
  }
  | { id: string; type: 'perf-sample'; sample: ContextResourceSample | null; wasmHeapBytes: number | null }
  | { id: string; type: 'error'; error?: string; timingMs?: number };

/* ------------------------------------------------------------------ */
/*  Essentia runtime (worker-local)                                    */
/* ------------------------------------------------------------------ */

interface EssentiaVectorLike {
  delete(): void;
}

interface EssentiaWorkerInstance {
  PercivalBpmEstimator(
    signal: EssentiaVectorLike,
    frameSize: number,
    hopSize: number,
    frameSizeOSS: number,
    hopSizeOSS: number,
    maxBpm: number,
    minBpm: number,
    sampleRate: number
  ): { bpm: number };
  RhythmExtractor2013(
    signal: EssentiaVectorLike,
    maxBpm: number,
    method: 'multifeature' | 'degara',
    minBpm: number
  ): { bpm: number; confidence?: number; ticks?: unknown; estimates?: unknown; bpmIntervals?: unknown };
  delete(): void;
}

interface EssentiaWorkerModule {
  EssentiaJS: new (streamingMode: boolean) => EssentiaWorkerInstance;
  arrayToVector(input: Float32Array): EssentiaVectorLike;
  vectorToArray?(vec: unknown): Float32Array | number[];
}

let essentiaModule: EssentiaWorkerModule | null = null;
let essentiaInstance: EssentiaWorkerInstance | null = null;
let essentiaInitPromise: Promise<void> | null = null;

// Worker-local resource sampler. Started only while a debug panel is open (driven by the
// pool's set-perf-sampling message) so analysis throughput is never taxed otherwise. When a
// worker is busy in WASM its event loop is blocked, so get-perf-sample replies arrive late or
// not at all — that latency is itself the saturation signal the pool reports.
const resourceSampler = createResourceSampler();

// Emscripten exposes the WASM linear memory as HEAPU8 on the module object. Feature-detected
// because the type surface we depend on does not declare it.
function readWasmHeapBytes(): number | null {
  const heap = (essentiaModule as { HEAPU8?: Uint8Array } | null)?.HEAPU8;
  return heap ? heap.buffer.byteLength : null;
}

function isEssentiaWorkerModule(value: unknown): value is EssentiaWorkerModule {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.EssentiaJS === 'function'
    && typeof record.arrayToVector === 'function';
}

async function resolveEssentiaWorkerModule(): Promise<EssentiaWorkerModule> {
  const raw = require('essentia.js/dist/essentia-wasm.umd.js') as unknown;
  const candidate = (raw as { default?: unknown } | null)?.default ?? raw;
  const unwrapped = (candidate as { EssentiaWASM?: unknown } | null)?.EssentiaWASM ?? candidate;

  if (typeof unwrapped === 'function') {
    const initialized = await (unwrapped as () => Promise<unknown>)();
    if (isEssentiaWorkerModule(initialized)) {
      return initialized;
    }
  }

  if (unwrapped && typeof (unwrapped as { ready?: unknown }).ready === 'object') {
    const readyValue = await ((unwrapped as { ready?: Promise<unknown> }).ready as Promise<unknown>);
    if (isEssentiaWorkerModule(readyValue)) {
      return readyValue;
    }
  }

  if (unwrapped && typeof (unwrapped as { then?: unknown }).then === 'function') {
    const thenValue = await (unwrapped as Promise<unknown>);
    if (isEssentiaWorkerModule(thenValue)) {
      return thenValue;
    }
  }

  if (isEssentiaWorkerModule(unwrapped)) {
    return unwrapped;
  }

  throw new Error('Essentia worker module unavailable');
}

async function initEssentia(): Promise<void> {
  if (essentiaInstance) return;
  if (essentiaInitPromise) return essentiaInitPromise;

  essentiaInitPromise = (async () => {
    const mod = await resolveEssentiaWorkerModule();
    essentiaModule = mod;
    essentiaInstance = new mod.EssentiaJS(false);
  })();

  try {
    await essentiaInitPromise;
  } finally {
    essentiaInitPromise = null;
  }
}

/* ------------------------------------------------------------------ */
/*  BPM normalization (mirrors tempo.ts logic)                         */
/* ------------------------------------------------------------------ */

function normalizeBpm(
  rawBpm: number,
  targetMin: number,
  targetMax: number,
  preferFaster: boolean
): number {
  if (!Number.isFinite(rawBpm) || rawBpm <= 0) return 0;
  let bpm = rawBpm;
  while (bpm > targetMax) bpm /= 2;
  while (bpm < targetMin) bpm *= 2;
  if (bpm >= targetMin && bpm <= targetMax) return bpm;

  // Ambiguous — try both directions
  let doubled = rawBpm;
  while (doubled < targetMin) doubled *= 2;
  let halved = rawBpm;
  while (halved > targetMax) halved /= 2;

  const dFits = doubled >= targetMin && doubled <= targetMax;
  const hFits = halved >= targetMin && halved <= targetMax;
  if (dFits && hFits) return preferFaster ? doubled : halved;
  if (dFits) return doubled;
  if (hFits) return halved;
  return rawBpm;
}

function classifyBeatType(bpm: number): string {
  if (!Number.isFinite(bpm) || bpm <= 0) return 'unknown';
  if (bpm < 90) return 'halftime-or-slow';
  if (bpm >= 90 && bpm < 136) return 'standard';
  if (bpm >= 136 && bpm < 160) return 'fast';
  return 'doubletime-or-fast';
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function confidenceToPercent(confidence: unknown, max: number): number {
  const raw = Number(confidence);
  if (!Number.isFinite(raw) || max <= 0) return 0;
  return Math.round(clamp01(raw / max) * 100);
}

/* ------------------------------------------------------------------ */
/*  Analysis handlers                                                  */
/* ------------------------------------------------------------------ */

function deleteIfPossible(value: unknown): void {
  if (value && typeof (value as { delete?: unknown }).delete === 'function') {
    try {
      (value as { delete: () => void }).delete();
    } catch {
      // ignore vector cleanup failures
    }
  }
}

function vectorToNumbers(vec: unknown): number[] {
  if (!vec) return [];
  if (vec instanceof Float32Array) return Array.from(vec);
  if (Array.isArray(vec)) return vec.map(Number);
  const converted = essentiaModule?.vectorToArray?.(vec);
  if (converted instanceof Float32Array) return Array.from(converted);
  if (Array.isArray(converted)) return converted.map(Number);
  const indexed = vec as { size?: () => number; get?: (i: number) => number };
  if (typeof indexed.size === 'function' && typeof indexed.get === 'function') {
    const count = indexed.size();
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(Number(indexed.get(i)));
    return out;
  }
  return [];
}

// Full RhythmExtractor2013 evidence (44.1 kHz signal). Runs on a worker so the
// corrected-tempo path (octave correction + beat-grid precision) no longer
// serialises on the host main thread. Mirrors extractRhythmEvidence in tempo.ts.
function extractRhythm(signal: Float32Array, minBpm: number, maxBpm: number): WorkerRhythmResult {
  if (!essentiaModule || !essentiaInstance) {
    throw new Error('Essentia not initialized');
  }
  const vec = essentiaModule.arrayToVector(signal);
  let ticks: unknown = null;
  let estimates: unknown = null;
  let bpmIntervals: unknown = null;
  try {
    const result = essentiaInstance.RhythmExtractor2013(vec, maxBpm, 'multifeature', minBpm);
    ticks = result?.ticks;
    estimates = result?.estimates;
    bpmIntervals = result?.bpmIntervals;
    return {
      bpm: Number(result?.bpm) || 0,
      confidence: confidenceToPercent(result?.confidence, 5.32),
      ticks: vectorToNumbers(ticks),
      estimates: vectorToNumbers(estimates),
      bpmIntervals: vectorToNumbers(bpmIntervals)
    };
  } finally {
    deleteIfPossible(ticks);
    deleteIfPossible(estimates);
    deleteIfPossible(bpmIntervals);
    (vec as EssentiaVectorLike).delete();
  }
}

function estimateTempo(
  signal16k: Float32Array,
  options: TempoWorkerOptions
): WorkerTempoResult {
  if (!essentiaModule || !essentiaInstance) {
    throw new Error('Essentia not initialized');
  }

  const minBpm = options.minBpm ?? 50;
  const maxBpm = options.maxBpm ?? 210;
  const targetMin = options.targetMinBpm ?? 70;
  const targetMax = options.targetMaxBpm ?? 170;
  const preferFaster = options.preferFasterAmbiguous ?? false;

  const vec = essentiaModule.arrayToVector(signal16k);
  try {
    const result = essentiaInstance.PercivalBpmEstimator(
      vec, 1024, 2048, 128, 128, maxBpm, minBpm, 16000
    );
    const rawBpm = Number(result.bpm) || 0;

    // Confidence via RhythmExtractor2013
    let confidence = 0;
    try {
      const rhythm = essentiaInstance.RhythmExtractor2013(vec, maxBpm, 'multifeature', minBpm);
      confidence = confidenceToPercent(rhythm?.confidence, 5.32);
    } catch {
      confidence = 0;
    }

    const normalizedBpm = normalizeBpm(rawBpm, targetMin, targetMax, preferFaster);

    return {
      bpm: Math.round(normalizedBpm),
      rawBpm: normalizedBpm,
      confidence,
      beatTypeAuto: classifyBeatType(normalizedBpm),
      method: 'essentia-percival'
    };
  } finally {
    vec.delete();
  }
}

function computeHPCPChunk(
  signal16k: Float32Array,
  frameStarts: number[],
  startOffsetSample: number,
  pcpSize: number
): WorkerHPCPChunkResult {
  if (!essentiaModule || !essentiaInstance) {
    throw new Error('Essentia not initialized');
  }

  const localStarts = frameStarts.map((start) => start - startOffsetSample);
  const { frameMap, timing } = computeHPCPFrameMapWithTiming(
    signal16k,
    localStarts,
    pcpSize,
    essentiaInstance,
    essentiaModule
  );

  const frames = Array.from(frameMap.values()).map((frame) => ({
    startSample: frame.startSample + startOffsetSample,
    endSample: frame.endSample + startOffsetSample,
    hpcp: frame.hpcp,
    harmonicEnergy: frame.harmonicEnergy
  }));

  return { frames, frameTiming: timing };
}

function computePrefilterChunk(
  signal16k: Float32Array,
  windows: WindowBounds[],
  prefilterFrameCount: number
): WorkerPrefilterChunkResult {
  if (!essentiaModule || !essentiaInstance) {
    throw new Error('Essentia not initialized');
  }

  return {
    prefilters: computePrefilterBatch(
      signal16k,
      windows,
      prefilterFrameCount,
      essentiaInstance,
      essentiaModule
    )
  };
}

/* ------------------------------------------------------------------ */
/*  Message handler                                                    */
/* ------------------------------------------------------------------ */

function respond(msg: WorkerResponse, transferList?: Transferable[]): void {
  (self as unknown as { postMessage: (msg: WorkerResponse, transfer?: Transferable[]) => void }).postMessage(msg, transferList || []);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const req = event.data;
  const startMs = performance.now();

  if (req.type === 'warm-up') {
    try {
      await initEssentia();
      respond({ id: req.id, type: 'ready' });
    } catch (err) {
      respond({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return;
  }

  if (req.type === 'set-perf-sampling') {
    if (req.enabled) {
      resourceSampler.start();
    } else {
      resourceSampler.stop();
    }
    return;
  }

  if (req.type === 'get-perf-sample') {
    respond({
      id: req.id,
      type: 'perf-sample',
      sample: resourceSampler.snapshot(),
      wasmHeapBytes: readWasmHeapBytes()
    });
    return;
  }

  if (req.type === 'estimate-tempo') {
    try {
      if (!essentiaInstance) await initEssentia();
      const result = estimateTempo(req.signal16k!, req.options ?? {});
      respond({
        id: req.id,
        type: 'result',
        result,
        timingMs: Math.round(performance.now() - startMs)
      });
    } catch (err) {
      respond({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        timingMs: Math.round(performance.now() - startMs)
      });
    }
    return;
  }

  if (req.type === 'extract-rhythm') {
    try {
      if (!essentiaInstance) await initEssentia();
      const rhythm = extractRhythm(req.signal, req.minBpm ?? 50, req.maxBpm ?? 210);
      respond({
        id: req.id,
        type: 'result',
        rhythm,
        timingMs: Math.round(performance.now() - startMs)
      });
    } catch (err) {
      respond({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        timingMs: Math.round(performance.now() - startMs)
      });
    }
    return;
  }

  if (req.type === 'compute-hpcp-chunk') {
    try {
      if (!essentiaInstance) await initEssentia();
      const hpcpChunk = computeHPCPChunk(
        req.signal16k,
        req.frameStarts,
        req.startOffsetSample,
        req.pcpSize
      );
      const transferList = hpcpChunk.frames.map((frame) => frame.hpcp.buffer as Transferable);
      respond({
        id: req.id,
        type: 'result',
        hpcpChunk,
        timingMs: Math.round(performance.now() - startMs)
      }, transferList);
    } catch (err) {
      respond({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        timingMs: Math.round(performance.now() - startMs)
      });
    }
    return;
  }

  if (req.type === 'compute-prefilter-chunk') {
    try {
      if (!essentiaInstance) await initEssentia();
      const prefilterChunk = computePrefilterChunk(
        req.signal16k,
        req.windows,
        req.prefilterFrameCount
      );
      respond({
        id: req.id,
        type: 'result',
        prefilterChunk,
        timingMs: Math.round(performance.now() - startMs)
      });
    } catch (err) {
      respond({
        id: req.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
        timingMs: Math.round(performance.now() - startMs)
      });
    }
    return;
  }

  const exhaustive: never = req;
  throw new Error(`Unhandled worker request: ${JSON.stringify(exhaustive)}`);
};
