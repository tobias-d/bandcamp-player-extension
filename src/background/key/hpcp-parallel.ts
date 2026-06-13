import { getWorkerPool } from '@/background/audio/worker-pool';
import { getHPCPFrameSize } from '@/background/key/hpcp';
import { buildWindowHPCPMapFromFrameMap, collectWindowFrameStarts } from '@/background/key/hpcp-window-cache';
import type { HPCPFrameResult, HPCPFrameStageTiming, HPCPResult, PrefilterResult, WindowBounds } from '@/background/key/types';

const MIN_PARALLEL_FRAME_COUNT = 96;
const PARALLEL_CHUNKS_PER_WORKER = 1;

interface ParallelWindowHPCPMapResult {
  hpcpByWindow: Map<number, HPCPResult>;
  timing: HPCPFrameStageTiming;
  dispatchDetail: string;
}

function createEmptyFrameStageTiming(): HPCPFrameStageTiming {
  return {
    frameCount: 0,
    vectorMs: 0,
    windowingMs: 0,
    spectrumMs: 0,
    peaksMs: 0,
    whiteningMs: 0,
    hpcpMs: 0,
    extractMs: 0
  };
}

function addFrameStageTiming(target: HPCPFrameStageTiming, source: HPCPFrameStageTiming): void {
  target.frameCount += source.frameCount;
  target.vectorMs += source.vectorMs;
  target.windowingMs += source.windowingMs;
  target.spectrumMs += source.spectrumMs;
  target.peaksMs += source.peaksMs;
  target.whiteningMs += source.whiteningMs;
  target.hpcpMs += source.hpcpMs;
  target.extractMs += source.extractMs;
}

function getUniqueSortedStarts(starts: readonly number[]): number[] {
  return Array.from(new Set(starts))
    .filter((start) => Number.isFinite(start))
    .sort((a, b) => a - b);
}

function chunkFrameStarts(starts: readonly number[], chunkCount: number): number[][] {
  if (!starts.length || chunkCount <= 0) {
    return [];
  }

  const chunkSize = Math.ceil(starts.length / chunkCount);
  const chunks: number[][] = [];
  for (let offset = 0; offset < starts.length; offset += chunkSize) {
    chunks.push(starts.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function buildChunkSignal(
  signal: Float32Array,
  frameStarts: readonly number[]
): { signal16k: Float32Array; startOffsetSample: number } {
  const frameSize = getHPCPFrameSize();
  const startOffsetSample = frameStarts[0];
  const endSample = frameStarts[frameStarts.length - 1] + frameSize;
  return {
    signal16k: new Float32Array(signal.subarray(startOffsetSample, endSample)),
    startOffsetSample
  };
}

export async function buildWindowHPCPMapWithWorkers(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  pitchSalienceThreshold: number,
  hfcCutoff: number,
  pcpSize: number,
  debugMode: boolean
): Promise<ParallelWindowHPCPMapResult | null> {
  if (debugMode) {
    return null;
  }

  const pool = getWorkerPool();
  if (!pool.isReady()) {
    return null;
  }

  const { windowFrameStarts, allFrameStarts } = collectWindowFrameStarts(
    windows,
    prefilters,
    pitchSalienceThreshold,
    hfcCutoff,
    debugMode
  );
  const uniqueStarts = getUniqueSortedStarts(allFrameStarts);
  if (!uniqueStarts.length) {
    return {
      hpcpByWindow: new Map<number, HPCPResult>(),
      timing: createEmptyFrameStageTiming(),
      dispatchDetail: `hpcpDispatch=pool workers=0 chunks=0 uniqueFrames=0 strategy=${PARALLEL_CHUNKS_PER_WORKER}x`
    };
  }

  if (uniqueStarts.length < MIN_PARALLEL_FRAME_COUNT) {
    return null;
  }

  const status = pool.getStatus();
  const workerCount = Math.max(1, status.ready);
  if (workerCount < 2) {
    return null;
  }

  const chunkCount = Math.min(uniqueStarts.length, workerCount * PARALLEL_CHUNKS_PER_WORKER);
  const chunks = chunkFrameStarts(uniqueStarts, chunkCount);
  const dispatchStartedAt = performance.now();
  let copyMs = 0;
  const chunkInputs = chunks.map((frameStarts) => {
    const copyStartedAt = performance.now();
    const { signal16k, startOffsetSample } = buildChunkSignal(signal, frameStarts);
    copyMs += performance.now() - copyStartedAt;
    return { frameStarts: [...frameStarts], signal16k, startOffsetSample };
  });
  const outputs = await Promise.all(
    chunkInputs.map(async (input) => pool.computeHPCPChunk({
      signal16k: input.signal16k,
      frameStarts: input.frameStarts,
      startOffsetSample: input.startOffsetSample,
      pcpSize
    }))
  );

  const frameMap = new Map<number, HPCPFrameResult>();
  const timing = createEmptyFrameStageTiming();
  const mergeStartedAt = performance.now();
  for (const output of outputs) {
    addFrameStageTiming(timing, output.frameTiming);
    for (const frame of output.frames) {
      frameMap.set(frame.startSample, frame);
    }
  }
  const mergeMs = performance.now() - mergeStartedAt;
  const assembleStartedAt = performance.now();
  const hpcpByWindow = buildWindowHPCPMapFromFrameMap(windows, windowFrameStarts, frameMap, pcpSize);
  const assembleMs = performance.now() - assembleStartedAt;
  const workerSumMs = outputs.reduce((total, output) => total + output.timingMs, 0);
  const workerMaxMs = outputs.reduce((max, output) => Math.max(max, output.timingMs), 0);

  return {
    hpcpByWindow,
    timing,
    dispatchDetail: [
      'hpcpDispatch=pool',
      `workers=${workerCount}`,
      `chunks=${chunks.length}`,
      `uniqueFrames=${uniqueStarts.length}`,
      `strategy=${PARALLEL_CHUNKS_PER_WORKER}x`,
      `copy=${Math.round(copyMs)}`,
      `workerMax=${Math.round(workerMaxMs)}`,
      `workerSum=${Math.round(workerSumMs)}`,
      `merge=${Math.round(mergeMs)}`,
      `assemble=${Math.round(assembleMs)}`,
      `wall=${Math.round(performance.now() - dispatchStartedAt)}`
    ].join(' ')
  };
}
