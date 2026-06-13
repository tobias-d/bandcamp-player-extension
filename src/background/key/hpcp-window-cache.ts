import {
  combineHPCPFrames,
  computeHPCPFrameMap,
  computeHPCPFrameMapWithTiming,
  getHPCPFrameSize,
  resolveWindowHPCPFrameStarts,
  resolveWindowHPCPHopSize
} from '@/background/key/hpcp';
import type { HPCPFrameResult, HPCPFrameStageTiming, HPCPResult, PrefilterResult, WindowBounds } from '@/background/key/types';

export function collectWindowFrameStarts(
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  pitchSalienceThreshold: number,
  hfcCutoff: number,
  debugMode: boolean
): { windowFrameStarts: Map<number, number[]>; allFrameStarts: number[] } {
  const windowFrameStarts = new Map<number, number[]>();
  const allFrameStarts: number[] = [];

  for (let i = 0; i < windows.length; i += 1) {
    const pre = prefilters[i];
    const passPrefilter = pre.pitchSalience >= pitchSalienceThreshold && pre.hfc <= hfcCutoff;
    if (!debugMode && !passPrefilter) {
      continue;
    }

    const starts = resolveWindowHPCPFrameStarts(windows[i]);
    if (!starts.length) {
      continue;
    }
    windowFrameStarts.set(i, starts);
    allFrameStarts.push(...starts);
  }

  return { windowFrameStarts, allFrameStarts };
}

export function buildWindowHPCPMapFromFrameMap(
  windows: readonly WindowBounds[],
  windowFrameStarts: ReadonlyMap<number, readonly number[]>,
  frameMap: ReadonlyMap<number, HPCPFrameResult>,
  pcpSize: number
): Map<number, HPCPResult> {
  const hpcpByWindow = new Map<number, HPCPResult>();

  for (let i = 0; i < windows.length; i += 1) {
    const starts = windowFrameStarts.get(i);
    if (!starts?.length) {
      continue;
    }

    const frames = starts
      .map((start) => frameMap.get(start))
      .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    const hpcp = combineHPCPFrames(frames, pcpSize);
    if (hpcp) {
      hpcpByWindow.set(i, hpcp);
    }
  }

  return hpcpByWindow;
}

export function buildWindowHPCPMap(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  pitchSalienceThreshold: number,
  hfcCutoff: number,
  pcpSize: number,
  debugMode: boolean,
  essentia: any,
  essentiaModule: any
): Map<number, HPCPResult> {
  return buildWindowHPCPMapWithTiming(
    signal,
    windows,
    prefilters,
    pitchSalienceThreshold,
    hfcCutoff,
    pcpSize,
    debugMode,
    essentia,
    essentiaModule
  ).hpcpByWindow;
}

export function buildWindowHPCPMapWithTiming(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  pitchSalienceThreshold: number,
  hfcCutoff: number,
  pcpSize: number,
  debugMode: boolean,
  essentia: any,
  essentiaModule: any
): { hpcpByWindow: Map<number, HPCPResult>; timing: HPCPFrameStageTiming } {
  const { windowFrameStarts, allFrameStarts } = collectWindowFrameStarts(
    windows,
    prefilters,
    pitchSalienceThreshold,
    hfcCutoff,
    debugMode
  );

  const { frameMap, timing } = computeHPCPFrameMapWithTiming(signal, allFrameStarts, pcpSize, essentia, essentiaModule);
  const hpcpByWindow = buildWindowHPCPMapFromFrameMap(windows, windowFrameStarts, frameMap, pcpSize);

  return { hpcpByWindow, timing };
}

export function buildGlobalGridWindowHPCPMap(
  signal: Float32Array,
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  pitchSalienceThreshold: number,
  hfcCutoff: number,
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): Map<number, HPCPResult> {
  const includedIndexes: number[] = [];
  for (let i = 0; i < windows.length; i += 1) {
    const pre = prefilters[i];
    const passPrefilter = pre.pitchSalience >= pitchSalienceThreshold && pre.hfc <= hfcCutoff;
    if (passPrefilter) {
      includedIndexes.push(i);
    }
  }
  if (!includedIndexes.length) {
    return new Map<number, HPCPResult>();
  }

  const firstWindow = windows[includedIndexes[0]];
  const lastWindow = windows[includedIndexes[includedIndexes.length - 1]];
  const frameSize = getHPCPFrameSize();
  const hopSize = resolveWindowHPCPHopSize(firstWindow);
  const globalStarts: number[] = [];
  for (let start = firstWindow.startSample; start + frameSize <= lastWindow.endSample; start += hopSize) {
    globalStarts.push(start);
  }

  const frameMap = computeHPCPFrameMap(signal, globalStarts, pcpSize, essentia, essentiaModule);
  const hpcpByWindow = new Map<number, HPCPResult>();

  for (const index of includedIndexes) {
    const window = windows[index];
    const frames = globalStarts
      .filter((start) => start >= window.startSample && start + frameSize <= window.endSample)
      .map((start) => frameMap.get(start))
      .filter((frame): frame is NonNullable<typeof frame> => Boolean(frame));
    const hpcp = combineHPCPFrames(frames, pcpSize);
    if (hpcp) {
      hpcpByWindow.set(index, hpcp);
    }
  }

  return hpcpByWindow;
}
