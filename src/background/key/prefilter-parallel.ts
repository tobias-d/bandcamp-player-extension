import { getWorkerPool } from '@/background/audio/worker-pool';
import type { PrefilterResult, WindowBounds } from '@/background/key/types';

const MIN_PARALLEL_WINDOW_COUNT = 12;
const PARALLEL_CHUNKS_PER_WORKER = 1;

interface ParallelPrefilterResult {
  prefilters: PrefilterResult[];
  dispatchDetail: string;
}

function chunkWindows(windows: readonly WindowBounds[], chunkCount: number): WindowBounds[][] {
  if (!windows.length || chunkCount <= 0) {
    return [];
  }

  const chunkSize = Math.ceil(windows.length / chunkCount);
  const chunks: WindowBounds[][] = [];
  for (let offset = 0; offset < windows.length; offset += chunkSize) {
    chunks.push(windows.slice(offset, offset + chunkSize));
  }
  return chunks;
}

function buildChunkSignal(
  signal: Float32Array,
  windows: readonly WindowBounds[]
): { signal16k: Float32Array; windows: WindowBounds[] } {
  const startOffsetSample = windows[0]?.startSample ?? 0;
  const endSample = windows[windows.length - 1]?.endSample ?? startOffsetSample;
  return {
    signal16k: new Float32Array(signal.subarray(startOffsetSample, endSample)),
    windows: windows.map((bounds) => ({
      index: bounds.index,
      startSample: bounds.startSample - startOffsetSample,
      endSample: bounds.endSample - startOffsetSample
    }))
  };
}

function emptyPrefilter(): PrefilterResult {
  return { pitchSalience: 0, hfc: 0, dissonance: 0 };
}

export async function buildPrefiltersWithWorkers(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilterFrameCount: number,
  debugMode: boolean
): Promise<ParallelPrefilterResult | null> {
  if (debugMode) {
    return null;
  }

  const pool = getWorkerPool();
  if (!pool.isReady()) {
    return null;
  }

  if (windows.length < MIN_PARALLEL_WINDOW_COUNT) {
    return null;
  }

  const status = pool.getStatus();
  const workerCount = Math.max(1, status.ready);
  if (workerCount < 2) {
    return null;
  }

  const chunkCount = Math.min(windows.length, workerCount * PARALLEL_CHUNKS_PER_WORKER);
  const chunks = chunkWindows(windows, chunkCount);
  const dispatchStartedAt = performance.now();
  let copyMs = 0;
  const chunkInputs = chunks.map((chunk) => {
    const copyStartedAt = performance.now();
    const built = buildChunkSignal(signal, chunk);
    copyMs += performance.now() - copyStartedAt;
    return { chunk, ...built };
  });
  const outputs = await Promise.all(
    chunkInputs.map(async (input) => pool.computePrefilterChunk({
      signal16k: input.signal16k,
      windows: input.windows,
      prefilterFrameCount
    }))
  );

  const mergeStartedAt = performance.now();
  const prefilters = Array.from({ length: windows.length }, emptyPrefilter);
  for (let i = 0; i < chunkInputs.length; i += 1) {
    const input = chunkInputs[i];
    const output = outputs[i];
    for (let j = 0; j < input.chunk.length; j += 1) {
      const index = input.chunk[j]?.index ?? -1;
      if (index >= 0 && index < prefilters.length) {
        prefilters[index] = output.prefilters[j] ?? emptyPrefilter();
      }
    }
  }
  const mergeMs = performance.now() - mergeStartedAt;
  const workerSumMs = outputs.reduce((total, output) => total + output.timingMs, 0);
  const workerMaxMs = outputs.reduce((max, output) => Math.max(max, output.timingMs), 0);

  return {
    prefilters,
    dispatchDetail: [
      'prefilterDispatch=pool',
      `workers=${workerCount}`,
      `chunks=${chunks.length}`,
      `windows=${windows.length}`,
      `strategy=${PARALLEL_CHUNKS_PER_WORKER}x`,
      `copy=${Math.round(copyMs)}`,
      `workerMax=${Math.round(workerMaxMs)}`,
      `workerSum=${Math.round(workerSumMs)}`,
      `merge=${Math.round(mergeMs)}`,
      `wall=${Math.round(performance.now() - dispatchStartedAt)}`
    ].join(' ')
  };
}
