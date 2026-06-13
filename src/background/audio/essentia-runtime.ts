import { createLogger } from '@/utils/debug';

const logger = createLogger('AUDIO');

export interface EssentiaVectorLike {
  delete(): void;
}

interface PercivalBpmEstimatorResult {
  bpm: number;
}

interface RhythmExtractorResult {
  bpm: number;
  confidence?: number;
  ticks?: EssentiaVectorLike | Float32Array;
  estimates?: EssentiaVectorLike | Float32Array;
  bpmIntervals?: EssentiaVectorLike | Float32Array;
}

interface LoopBpmConfidenceResult {
  confidence?: number;
}

export interface EssentiaInstanceLike {
  PercivalBpmEstimator(
    signal: EssentiaVectorLike,
    frameSize: number,
    hopSize: number,
    frameSizeOSS: number,
    hopSizeOSS: number,
    maxBpm: number,
    minBpm: number,
    sampleRate: number
  ): PercivalBpmEstimatorResult;
  RhythmExtractor2013(
    signal: EssentiaVectorLike,
    maxBpm: number,
    method: 'multifeature' | 'degara',
    minBpm: number
  ): RhythmExtractorResult;
  LoopBpmConfidence(signal: EssentiaVectorLike, bpm: number, sampleRate: number): LoopBpmConfidenceResult;
  vectorToArray?(input: EssentiaVectorLike | Float32Array): Float32Array;
  delete(): void;
}

export interface EssentiaModuleLike {
  EssentiaJS: new (streamingMode: boolean) => EssentiaInstanceLike;
  arrayToVector(input: Float32Array): EssentiaVectorLike;
  vectorToArray(input: EssentiaVectorLike | Float32Array): Float32Array;
}

export interface EssentiaRuntime {
  module: EssentiaModuleLike;
  instance: EssentiaInstanceLike;
}

let runtimePromise: Promise<EssentiaRuntime> | null = null;
let runtimeValue: EssentiaRuntime | null = null;

function isEssentiaModuleLike(value: unknown): value is EssentiaModuleLike {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.EssentiaJS === 'function'
    && typeof record.arrayToVector === 'function';
}

async function resolveEssentiaModule(): Promise<EssentiaModuleLike> {
  const raw = require('essentia.js/dist/essentia-wasm.umd.js') as unknown;
  const candidate = (raw as { default?: unknown } | null)?.default ?? raw;
  const unwrapped = (candidate as { EssentiaWASM?: unknown } | null)?.EssentiaWASM ?? candidate;

  if (typeof unwrapped === 'function') {
    const initialized = await (unwrapped as () => Promise<unknown>)();
    if (isEssentiaModuleLike(initialized)) {
      return initialized;
    }
  }

  if (unwrapped && typeof (unwrapped as { ready?: unknown }).ready === 'object') {
    const readyValue = await ((unwrapped as { ready?: Promise<unknown> }).ready as Promise<unknown>);
    if (isEssentiaModuleLike(readyValue)) {
      return readyValue;
    }
  }

  if (unwrapped && typeof (unwrapped as { then?: unknown }).then === 'function') {
    const thenValue = await (unwrapped as Promise<unknown>);
    if (isEssentiaModuleLike(thenValue)) {
      return thenValue;
    }
  }

  if (isEssentiaModuleLike(unwrapped)) {
    return unwrapped;
  }

  let keys = '[unreadable]';
  try {
    keys = Object.keys((unwrapped || {}) as Record<string, unknown>).slice(0, 24).join(',');
  } catch {
    // Keep fallback string.
  }
  throw new TypeError(`Essentia WASM module unavailable. keys=${keys}`);
}

export async function initEssentiaRuntime(): Promise<EssentiaRuntime> {
  if (runtimeValue) {
    return runtimeValue;
  }

  if (!runtimePromise) {
    runtimePromise = (async (): Promise<EssentiaRuntime> => {
      const module = await resolveEssentiaModule();
      const instance = new module.EssentiaJS(false);
      const runtime = { module, instance };
      runtimeValue = runtime;
      logger.info('Essentia runtime initialized');
      return runtime;
    })().catch((error) => {
      runtimePromise = null;
      throw error;
    });
  }

  return runtimePromise;
}

export function getEssentiaRuntimeSync(): EssentiaRuntime | null {
  return runtimeValue;
}

export function cleanupEssentiaRuntime(): void {
  if (!runtimeValue) {
    return;
  }

  try {
    runtimeValue.instance.delete();
  } finally {
    runtimeValue = null;
    runtimePromise = null;
    logger.info('Essentia runtime cleaned up');
  }
}
