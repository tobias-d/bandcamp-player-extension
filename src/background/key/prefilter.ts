import type { PrefilterResult, WindowBounds } from '@/background/key/types';

function largestPowerOfTwoAtMost(value: number): number {
  if (value < 2) {
    return 1;
  }
  return 2 ** Math.floor(Math.log2(value));
}

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function extractScalar(result: unknown, ...keys: string[]): number {
  if (typeof result === 'number') {
    return toFiniteNumber(result);
  }
  if (!result || typeof result !== 'object') {
    return 0;
  }
  const record = result as Record<string, unknown>;
  for (const key of keys) {
    if (key in record) {
      return toFiniteNumber(record[key]);
    }
  }
  return 0;
}

function extractPeaks(result: unknown): { frequencies: unknown; magnitudes: unknown } {
  if (!result || typeof result !== 'object') {
    return { frequencies: null, magnitudes: null };
  }
  const record = result as Record<string, unknown>;
  return {
    frequencies: record.frequencies ?? record.frequency ?? null,
    magnitudes: record.magnitudes ?? record.magnitude ?? null
  };
}

function unwrapVector(output: unknown, key: string): unknown {
  if (!output || typeof output !== 'object') {
    return output;
  }
  const record = output as Record<string, unknown>;
  return record[key] ?? output;
}

export function computePrefilter(
  signal: Float32Array,
  bounds: WindowBounds,
  prefilterFrameCount: number,
  essentia: any,
  essentiaModule: any
): PrefilterResult {
  const span = Math.max(0, bounds.endSample - bounds.startSample);
  if (span <= 0) {
    return { pitchSalience: 0, hfc: 0, dissonance: 0 };
  }

  const frameSize = Math.min(65536, largestPowerOfTwoAtMost(span));
  const frameCount = Math.max(1, Math.floor(prefilterFrameCount || 1));
  const maxStart = Math.max(bounds.startSample, bounds.endSample - frameSize);
  const starts: number[] = [];

  if (frameCount === 1) {
    starts.push(bounds.startSample);
  } else {
    for (let i = 0; i < frameCount; i += 1) {
      const t = i / (frameCount - 1);
      starts.push(Math.floor(bounds.startSample + (maxStart - bounds.startSample) * t));
    }
  }

  const pitchVals: number[] = [];
  const hfcVals: number[] = [];
  const dissVals: number[] = [];

  for (const frameStart of starts) {
    const frame = signal.subarray(frameStart, Math.min(signal.length, frameStart + frameSize));
    const vec = essentiaModule.arrayToVector(frame);
    let windowed: unknown = null;
    let windowedFrame: unknown = null;
    let spectrum: unknown = null;
    let spectrumVec: unknown = null;
    let peaks: unknown = null;
    let pitch: unknown = null;
    let hfc: unknown = null;
    let dissonance: unknown = null;
    let peakData: { frequencies: unknown; magnitudes: unknown } = { frequencies: null, magnitudes: null };

    try {
      windowed = essentia.Windowing(vec, false, frame.length, 'blackmanharris62', 0, true);
      windowedFrame = unwrapVector(windowed, 'frame');
      spectrum = essentia.Spectrum(windowedFrame, frame.length);
      spectrumVec = unwrapVector(spectrum, 'spectrum');
      pitch = essentia.PitchSalience(spectrumVec, 3500, 40, 16000);
      hfc = essentia.HFC(spectrumVec, 16000, 'Masri');
      peaks = essentia.SpectralPeaks(spectrumVec, 0.00001, 3500, 100, 40, 'frequency', 16000);
      peakData = extractPeaks(peaks);
      dissonance = peakData.frequencies && peakData.magnitudes
        ? essentia.Dissonance(peakData.frequencies, peakData.magnitudes)
        : 0;

      pitchVals.push(extractScalar(pitch, 'pitchSalience', 'value'));
      hfcVals.push(extractScalar(hfc, 'hfc', 'value'));
      dissVals.push(extractScalar(dissonance, 'dissonance', 'value'));
    } catch (error) {
      console.warn('[KEY] prefilter frame failed', error);
      pitchVals.push(0);
      hfcVals.push(0);
      dissVals.push(0);
    } finally {
      deleteIfPossible(dissonance);
      deleteIfPossible(pitch);
      deleteIfPossible(hfc);
      deleteIfPossible(peakData.frequencies);
      deleteIfPossible(peakData.magnitudes);
      deleteIfPossible(peaks);
      deleteIfPossible(spectrumVec);
      deleteIfPossible(spectrum);
      deleteIfPossible(windowedFrame);
      deleteIfPossible(windowed);
      deleteIfPossible(vec);
    }
  }

  return {
    pitchSalience: median(pitchVals),
    hfc: median(hfcVals),
    dissonance: median(dissVals)
  };
}

export function computePrefilterBatch(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilterFrameCount: number,
  essentia: any,
  essentiaModule: any
): PrefilterResult[] {
  return windows.map((bounds) =>
    computePrefilter(signal, bounds, prefilterFrameCount, essentia, essentiaModule)
  );
}

export function computeHFCPercentileThreshold(hfcValues: number[], percentile: number): number {
  if (!hfcValues.length) {
    return 0;
  }

  const p = Math.max(0, Math.min(1, percentile));
  const sorted = [...hfcValues].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function computePercentileRank(values: number[], target: number): number {
  if (!values.length) {
    return 0;
  }
  let count = 0;
  for (const value of values) {
    if (value <= target) {
      count += 1;
    }
  }
  return count / values.length;
}
