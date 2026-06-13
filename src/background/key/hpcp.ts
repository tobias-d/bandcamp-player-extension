import type { HPCPFrameResult, HPCPFrameStageTiming, HPCPResult, WindowBounds } from '@/background/key/types';

const HPCP_FRAME_SIZE = 2048;
const HPCP_MIN_HOP_SIZE = 1024;
// Full-track accuracy comes from covering the whole window; we do not need
// extremely dense sub-frame sampling inside each window when adjacent windows
// already overlap heavily.
const HPCP_MAX_FRAMES_PER_WINDOW = 64;

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

function deleteIfPossible(value: unknown): void {
  if (value && typeof value === 'object' && typeof (value as { delete?: unknown }).delete === 'function') {
    try {
      ((value as { delete: () => void }).delete)();
    } catch (error) {
      console.warn('[KEY] vector delete failed', error);
    }
  }
}

function toArrayLike(data: unknown): number[] {
  if (!data) {
    return [];
  }
  if (Array.isArray(data)) {
    return data.map((v) => Number(v) || 0);
  }
  if (ArrayBuffer.isView(data) && typeof (data as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return Array.from(data as unknown as Iterable<number>).map((v) => Number(v) || 0);
  }
  if (typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.hpcp)) {
      return record.hpcp.map((v) => Number(v) || 0);
    }
    if (
      ArrayBuffer.isView(record.hpcp as unknown)
      && typeof ((record.hpcp as unknown) as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
    ) {
      return Array.from(record.hpcp as unknown as Iterable<number>).map((v) => Number(v) || 0);
    }
  }
  return [];
}

function vectorToJsArray(value: unknown, essentia: any, essentiaModule: any): number[] {
  if (!value) {
    return [];
  }

  try {
    if (typeof essentia?.vectorToArray === 'function') {
      const converted = essentia.vectorToArray(value);
      if (Array.isArray(converted)) {
        return converted.map((v) => Number(v) || 0);
      }
      if (ArrayBuffer.isView(converted) && typeof (converted as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
        return Array.from(converted as unknown as Iterable<number>).map((v) => Number(v) || 0);
      }
    }
  } catch {
    // Fall back to structural conversion below.
  }

  try {
    if (typeof essentiaModule?.vectorToArray === 'function') {
      const converted = essentiaModule.vectorToArray(value);
      if (Array.isArray(converted)) {
        return converted.map((v: unknown) => Number(v) || 0);
      }
      if (ArrayBuffer.isView(converted) && typeof (converted as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
        return Array.from(converted as unknown as Iterable<number>).map((v) => Number(v) || 0);
      }
    }
  } catch {
    // Fall through to structural conversion.
  }

  return toArrayLike(value);
}

function unwrapVector(output: unknown, key: string): unknown {
  if (!output || typeof output !== 'object') {
    return output;
  }
  const record = output as Record<string, unknown>;
  return record[key] ?? output;
}

function frameStarts(start: number, end: number, frameSize: number, hopSize: number): number[] {
  const starts: number[] = [];
  for (let pos = start; pos + frameSize <= end; pos += hopSize) {
    starts.push(pos);
  }
  return starts;
}

function resolveHopSize(bounds: WindowBounds, frameSize: number): number {
  const span = Math.max(0, bounds.endSample - bounds.startSample);
  if (span <= frameSize) {
    return frameSize;
  }

  const maxSteps = Math.max(1, HPCP_MAX_FRAMES_PER_WINDOW - 1);
  const boundedHop = Math.ceil((span - frameSize) / maxSteps);
  return Math.max(HPCP_MIN_HOP_SIZE, boundedHop);
}

export function resolveWindowHPCPFrameStarts(bounds: WindowBounds): number[] {
  return frameStarts(bounds.startSample, bounds.endSample, HPCP_FRAME_SIZE, resolveHopSize(bounds, HPCP_FRAME_SIZE));
}

export function getHPCPFrameSize(): number {
  return HPCP_FRAME_SIZE;
}

export function resolveWindowHPCPHopSize(bounds: WindowBounds): number {
  return resolveHopSize(bounds, HPCP_FRAME_SIZE);
}

function computeFrameHPCP(
  signal: Float32Array,
  startSample: number,
  pcpSize: number,
  essentia: any,
  essentiaModule: any,
  timing?: HPCPFrameStageTiming
): HPCPFrameResult | null {
  const frame = signal.subarray(startSample, startSample + HPCP_FRAME_SIZE);
  const vectorStartedAt = performance.now();
  const vec = essentiaModule.arrayToVector(frame);
  if (timing) {
    timing.vectorMs += performance.now() - vectorStartedAt;
  }
  let windowed: unknown = null;
  let windowedFrame: unknown = null;
  let spectrum: unknown = null;
  let spectrumVec: unknown = null;
  let peaks: unknown = null;
  let whitening: unknown = null;
  let whiteningMags: unknown = null;
  let hpcp: unknown = null;

  try {
    const windowingStartedAt = performance.now();
    windowed = essentia.Windowing(vec, false, HPCP_FRAME_SIZE, 'blackmanharris62', 0, true);
    windowedFrame = unwrapVector(windowed, 'frame');
    if (timing) {
      timing.windowingMs += performance.now() - windowingStartedAt;
    }

    const spectrumStartedAt = performance.now();
    spectrum = essentia.Spectrum(windowedFrame, HPCP_FRAME_SIZE);
    spectrumVec = unwrapVector(spectrum, 'spectrum');
    if (timing) {
      timing.spectrumMs += performance.now() - spectrumStartedAt;
    }

    const peaksStartedAt = performance.now();
    peaks = essentia.SpectralPeaks(spectrumVec, 0.00001, 3500, 100, 40, 'frequency', 16000);
    if (timing) {
      timing.peaksMs += performance.now() - peaksStartedAt;
    }

    const peakRecord = peaks as Record<string, unknown>;
    const frequencies = peakRecord?.frequencies;
    const magnitudes = peakRecord?.magnitudes;
    if (!frequencies || !magnitudes) {
      return null;
    }

    const whiteningStartedAt = performance.now();
    whitening = essentia.SpectralWhitening(spectrumVec, frequencies, magnitudes, 3500, 16000);
    whiteningMags = unwrapVector(whitening, 'magnitudes');
    if (timing) {
      timing.whiteningMs += performance.now() - whiteningStartedAt;
    }

    const wmags = whiteningMags || magnitudes;
    const hpcpStartedAt = performance.now();
    hpcp = essentia.HPCP(
      frequencies,
      wmags,
      true,
      500,
      0,
      3500,
      false,
      40,
      false,
      'unitMax',
      440,
      16000,
      pcpSize,
      'squaredCosine',
      1
    );
    if (timing) {
      timing.hpcpMs += performance.now() - hpcpStartedAt;
    }

    const extractStartedAt = performance.now();
    const hpcpVals = vectorToJsArray((hpcp as Record<string, unknown>)?.hpcp ?? hpcp, essentia, essentiaModule);
    if (hpcpVals.length !== pcpSize) {
      return null;
    }

    const frameHpcp = new Float32Array(pcpSize);
    let harmonicEnergy = 0;
    for (let i = 0; i < pcpSize; i += 1) {
      const value = hpcpVals[i];
      frameHpcp[i] = value;
      harmonicEnergy += value;
    }
    if (timing) {
      timing.extractMs += performance.now() - extractStartedAt;
      timing.frameCount += 1;
    }

    return {
      startSample,
      endSample: startSample + HPCP_FRAME_SIZE,
      hpcp: frameHpcp,
      harmonicEnergy
    };
  } catch (error) {
    console.warn('[KEY] HPCP frame failed', error);
    return null;
  } finally {
    deleteIfPossible(hpcp);
    deleteIfPossible(whiteningMags);
    deleteIfPossible(whitening);
    deleteIfPossible(peaks);
    deleteIfPossible(spectrumVec);
    deleteIfPossible(spectrum);
    deleteIfPossible(windowedFrame);
    deleteIfPossible(windowed);
    deleteIfPossible(vec);
  }
}

export function computeWindowHPCPFrames(
  signal: Float32Array,
  bounds: WindowBounds,
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): HPCPFrameResult[] {
  const starts = resolveWindowHPCPFrameStarts(bounds);
  if (!starts.length) {
    return [];
  }

  const frames: HPCPFrameResult[] = [];
  for (const start of starts) {
    const frame = computeFrameHPCP(signal, start, pcpSize, essentia, essentiaModule);
    if (frame) {
      frames.push(frame);
    }
  }
  return frames;
}

export function computeHPCPFrameMap(
  signal: Float32Array,
  starts: readonly number[],
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): Map<number, HPCPFrameResult> {
  return computeHPCPFrameMapWithTiming(signal, starts, pcpSize, essentia, essentiaModule).frameMap;
}

export function computeHPCPFrameMapWithTiming(
  signal: Float32Array,
  starts: readonly number[],
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): { frameMap: Map<number, HPCPFrameResult>; timing: HPCPFrameStageTiming } {
  const sortedUniqueStarts = Array.from(new Set(starts))
    .filter((start) => Number.isFinite(start))
    .sort((a, b) => a - b);

  const timing = createEmptyFrameStageTiming();
  const frameMap = new Map<number, HPCPFrameResult>();
  for (const start of sortedUniqueStarts) {
    const frame = computeFrameHPCP(signal, start, pcpSize, essentia, essentiaModule, timing);
    if (frame) {
      frameMap.set(start, frame);
    }
  }
  return { frameMap, timing };
}

export function combineHPCPFrames(frames: readonly HPCPFrameResult[], pcpSize: number): HPCPResult | null {
  if (!frames.length) {
    return null;
  }

  const sum = new Float64Array(pcpSize);
  for (const frame of frames) {
    for (let i = 0; i < pcpSize; i += 1) {
      sum[i] += frame.hpcp[i] ?? 0;
    }
  }

  const meanHPCP = new Float32Array(pcpSize);
  let harmonicEnergy = 0;
  for (let i = 0; i < pcpSize; i += 1) {
    const value = sum[i] / frames.length;
    meanHPCP[i] = value;
    harmonicEnergy += value;
  }

  return {
    meanHPCP,
    harmonicEnergy
  };
}

export function computeWindowHPCP(
  signal: Float32Array,
  bounds: WindowBounds,
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): HPCPResult | null {
  const frames = computeWindowHPCPFrames(signal, bounds, pcpSize, essentia, essentiaModule);
  return combineHPCPFrames(frames, pcpSize);
}
