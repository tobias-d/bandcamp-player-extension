import { getPreprocessedSignal } from '@/background/audio/tempo';
import { getWorkerPool } from '@/background/audio/worker-pool';
import { initEssentiaRuntime } from '@/background/audio/essentia-runtime';
import { DEFAULT_KEY_PARAMS } from '@/background/key/constants';
import { evaluateWindowHPCPMap } from '@/background/key/evaluation';
import { buildWindowHPCPMapWithWorkers } from '@/background/key/hpcp-parallel';
import { buildGlobalGridWindowHPCPMap, buildWindowHPCPMapWithTiming } from '@/background/key/hpcp-window-cache';
import { buildPrefiltersWithWorkers } from '@/background/key/prefilter-parallel';
import { computeHFCPercentileThreshold, computePercentileRank, computePrefilterBatch } from '@/background/key/prefilter';
import type { HPCPFrameStageTiming, HPCPResult, PrefilterResult, WindowBounds } from '@/background/key/types';
import { generateWindows } from '@/background/key/windowing';
import type { KeyCandidate } from '@/shared/types';
import type {
  KeyAnalysisDebugResult,
  KeyAnalysisParams,
  KeyAnalysisResult,
  KeyWindowData
} from '@/shared/types';

function resolveParams(overrides?: Partial<KeyAnalysisParams>): KeyAnalysisParams {
  return { ...DEFAULT_KEY_PARAMS, ...(overrides || {}) };
}

const ENABLE_GLOBAL_GRID_COMPARISON = false;

function baseResult(windowsTotal: number, windowsAnalyzed: number, reliability: number): KeyAnalysisResult {
  return {
    topKeys: [],
    dualCenter: false,
    segments: [],
    method: 'essentia-hpcp-key',
    windowsAnalyzed,
    windowsTotal,
    reliability
  };
}

function buildWindowDiagnostics(
  windows: WindowBounds[],
  prefilters: PrefilterResult[],
  hfcValues: number[],
  hfcCutoff: number
): KeyWindowData[] {
  return windows.map((bounds, index) => {
    const p = prefilters[index] || { pitchSalience: 0, hfc: 0, dissonance: 0 };
    const passed = p.pitchSalience >= 0 && p.hfc <= hfcCutoff;
    return {
      index,
      startSample: bounds.startSample,
      endSample: bounds.endSample,
      startSeconds: bounds.startSample / 16000,
      endSeconds: bounds.endSample / 16000,
      pitchSalience: p.pitchSalience,
      hfc: p.hfc,
      hfcPercentile: computePercentileRank(hfcValues, p.hfc),
      dissonance: p.dissonance,
      passedPrefilter: passed,
      prefilterReason: passed ? null : (p.pitchSalience < 0 ? 'pitch-salience' : 'hfc'),
      meanHPCP: null,
      harmonicEnergy: null,
      passedEnergyGate: null,
      key: null,
      scale: null,
      camelot: null,
      keyStrength: null,
      firstToSecondRelativeStrength: null,
      combinedWeight: null
    };
  });
}

type PipelineTiming = {
  totalMs: number;
  preprocessMs: number;
  computeMs: number;
  diagnosticsMs: number;
  prefilterMs: number;
  hpcpMs: number;
  scoreMs: number;
  aggregateMs: number;
  prefilterDispatchDetail?: string;
  frameStageDetail?: string;
  dispatchDetail?: string;
  comparisonDetail?: string;
};
interface PipelineResult { result: KeyAnalysisResult; windows: KeyWindowData[]; timing: PipelineTiming; }

function formatTopKeys(keys: readonly KeyCandidate[]): string {
  const labels = keys.map((key) => String(key.camelot || '').trim()).filter(Boolean);
  return labels.length ? labels.join(',') : '-';
}

function sameTopKeys(a: readonly KeyCandidate[], b: readonly KeyCandidate[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((key, index) => key.camelot === b[index]?.camelot);
}

function buildComparisonDetail(
  currentResult: KeyAnalysisResult,
  currentHpcpMs: number,
  globalResult: KeyAnalysisResult,
  globalHpcpMs: number
): string {
  const reliabilityDelta = (globalResult.reliability - currentResult.reliability).toFixed(3);
  const topMatch = sameTopKeys(currentResult.topKeys, globalResult.topKeys) ? '1' : '0';
  return [
    'gridCompare',
    `match=${topMatch}`,
    `top=${formatTopKeys(currentResult.topKeys)}->${formatTopKeys(globalResult.topKeys)}`,
    `rel=${currentResult.reliability.toFixed(3)}->${globalResult.reliability.toFixed(3)}`,
    `relDelta=${reliabilityDelta}`,
    `win=${currentResult.windowsAnalyzed}/${currentResult.windowsTotal}->${globalResult.windowsAnalyzed}/${globalResult.windowsTotal}`,
    `hpcp=${currentHpcpMs}->${globalHpcpMs}`
  ].join(' ');
}

function buildFrameStageDetail(timing: HPCPFrameStageTiming): string {
  return [
    'frameStages',
    `frames=${timing.frameCount}`,
    `vec=${Math.round(timing.vectorMs)}`,
    `win=${Math.round(timing.windowingMs)}`,
    `fft=${Math.round(timing.spectrumMs)}`,
    `peaks=${Math.round(timing.peaksMs)}`,
    `white=${Math.round(timing.whiteningMs)}`,
    `hpcp=${Math.round(timing.hpcpMs)}`,
    `extract=${Math.round(timing.extractMs)}`
  ].join(' ');
}

async function runPipeline(
  audioBuffer: AudioBuffer,
  bpm: number,
  overrides?: Partial<KeyAnalysisParams>,
  adaptiveStartSample = 0,
  debugMode = false
): Promise<PipelineResult> {
  const totalStartedAt = performance.now();
  const params = resolveParams(overrides);
  const runtime = await initEssentiaRuntime();
  const essentia = runtime.instance as any;
  const essentiaModule = runtime.module as any;

  const preprocessStartedAt = performance.now();
  const signal = await getPreprocessedSignal(audioBuffer, 'precise', 'full-track');
  const preprocessMs = Math.round(performance.now() - preprocessStartedAt);
  const computeStartedAt = performance.now();
  const windows = generateWindows(signal.length, 16000, bpm, adaptiveStartSample, params);
  if (!windows.length) {
    const computeMs = Math.round(performance.now() - computeStartedAt);
    return {
      result: baseResult(0, 0, 0),
      windows: [],
      timing: {
        totalMs: Math.round(performance.now() - totalStartedAt),
        preprocessMs,
        computeMs,
        diagnosticsMs: 0,
        prefilterMs: 0,
        hpcpMs: 0,
        scoreMs: 0,
        aggregateMs: 0
      }
    };
  }

  const prefilterStartedAt = performance.now();
  let prefilters: PrefilterResult[];
  let prefilterDispatchDetail = 'prefilterDispatch=serial';
  try {
    const parallelResult = await buildPrefiltersWithWorkers(
      signal,
      windows,
      params.prefilterFrameCount,
      debugMode
    );
    if (parallelResult) {
      prefilters = parallelResult.prefilters;
      prefilterDispatchDetail = parallelResult.dispatchDetail;
    } else {
      prefilters = computePrefilterBatch(signal, windows, params.prefilterFrameCount, essentia, essentiaModule);
      if (getWorkerPool().isReady() && !debugMode) {
        prefilterDispatchDetail = 'prefilterDispatch=serial reason=threshold-or-workers';
      }
    }
  } catch (error) {
    prefilters = computePrefilterBatch(signal, windows, params.prefilterFrameCount, essentia, essentiaModule);
    const message = error instanceof Error ? error.message : 'unknown';
    prefilterDispatchDetail = `prefilterDispatch=serial reason=pool-failed error=${message}`;
  }
  const prefilterMs = Math.round(performance.now() - prefilterStartedAt);

  const hfcValues = prefilters.map((p) => p.hfc);
  const hfcCutoff = computeHFCPercentileThreshold(hfcValues, params.hfcPercentileThreshold);
  const diagnosticsStartedAt = performance.now();
  const windowData = debugMode ? buildWindowDiagnostics(windows, prefilters, hfcValues, hfcCutoff) : null;
  const diagnosticsMs = Math.round(performance.now() - diagnosticsStartedAt);

  const hpcpStartedAt = performance.now();
  let hpcpByWindow: Map<number, HPCPResult>;
  let frameStageTiming: HPCPFrameStageTiming;
  let dispatchDetail = 'hpcpDispatch=serial';
  try {
    const parallelResult = await buildWindowHPCPMapWithWorkers(
      signal,
      windows,
      prefilters,
      params.pitchSalienceThreshold,
      hfcCutoff,
      params.pcpSize,
      debugMode
    );
    if (parallelResult) {
      hpcpByWindow = parallelResult.hpcpByWindow;
      frameStageTiming = parallelResult.timing;
      dispatchDetail = parallelResult.dispatchDetail;
    } else {
      const serialResult = buildWindowHPCPMapWithTiming(
        signal,
        windows,
        prefilters,
        params.pitchSalienceThreshold,
        hfcCutoff,
        params.pcpSize,
        debugMode,
        essentia,
        essentiaModule
      );
      hpcpByWindow = serialResult.hpcpByWindow;
      frameStageTiming = serialResult.timing;
      if (getWorkerPool().isReady() && !debugMode) {
        dispatchDetail = 'hpcpDispatch=serial reason=threshold-or-workers';
      }
    }
  } catch (error) {
    const serialResult = buildWindowHPCPMapWithTiming(
      signal,
      windows,
      prefilters,
      params.pitchSalienceThreshold,
      hfcCutoff,
      params.pcpSize,
      debugMode,
      essentia,
      essentiaModule
    );
    hpcpByWindow = serialResult.hpcpByWindow;
    frameStageTiming = serialResult.timing;
    const message = error instanceof Error ? error.message : 'unknown';
    dispatchDetail = `hpcpDispatch=serial reason=pool-failed error=${message}`;
  }
  if (windowData) {
    for (const [index, hpcp] of hpcpByWindow.entries()) {
      windowData[index].meanHPCP = Array.from(hpcp.meanHPCP);
      windowData[index].harmonicEnergy = hpcp.harmonicEnergy;
    }
  }
  const hpcpMs = Math.round(performance.now() - hpcpStartedAt);

  const evaluated = evaluateWindowHPCPMap(
    windows,
    prefilters,
    hfcCutoff,
    hpcpByWindow,
    params,
    essentia,
    essentiaModule,
    windowData
  );

  let comparisonDetail: string | undefined;
  if (ENABLE_GLOBAL_GRID_COMPARISON && !debugMode) {
    const globalStartedAt = performance.now();
    const globalHpcpByWindow = buildGlobalGridWindowHPCPMap(
      signal,
      windows,
      prefilters,
      params.pitchSalienceThreshold,
      hfcCutoff,
      params.pcpSize,
      essentia,
      essentiaModule
    );
    const globalHpcpMs = Math.round(performance.now() - globalStartedAt);
    const globalEvaluated = evaluateWindowHPCPMap(
      windows,
      prefilters,
      hfcCutoff,
      globalHpcpByWindow,
      params,
      essentia,
      essentiaModule
    );
    comparisonDetail = buildComparisonDetail(evaluated.result, hpcpMs, globalEvaluated.result, globalHpcpMs);
  }

  return {
    result: evaluated.result,
    windows: windowData || [],
    timing: {
      totalMs: Math.round(performance.now() - totalStartedAt),
      preprocessMs,
      computeMs: Math.round(performance.now() - computeStartedAt),
      diagnosticsMs,
      prefilterMs,
      hpcpMs,
      scoreMs: evaluated.scoreMs,
      aggregateMs: evaluated.aggregateMs,
      prefilterDispatchDetail,
      frameStageDetail: buildFrameStageDetail(frameStageTiming),
      dispatchDetail,
      comparisonDetail
    }
  };
}

export { DEFAULT_KEY_PARAMS };
export type { KeyAnalysisParams };

export async function analyzeKey(
  audioBuffer: AudioBuffer,
  bpm: number,
  overrides?: Partial<KeyAnalysisParams>,
  adaptiveStartSample = 0
): Promise<KeyAnalysisResult> {
  const { result } = await runPipeline(audioBuffer, bpm, overrides, adaptiveStartSample, false);
  return result;
}

export async function analyzeKeyDetailed(
  audioBuffer: AudioBuffer,
  bpm: number,
  overrides?: Partial<KeyAnalysisParams>,
  adaptiveStartSample = 0
): Promise<{ result: KeyAnalysisResult; timing: PipelineTiming }> {
  const { result, timing } = await runPipeline(audioBuffer, bpm, overrides, adaptiveStartSample, false);
  return { result, timing };
}

export async function analyzeKeyDebug(
  audioBuffer: AudioBuffer,
  bpm: number,
  overrides?: Partial<KeyAnalysisParams>,
  adaptiveStartSample = 0
): Promise<KeyAnalysisDebugResult> {
  const params = resolveParams(overrides);
  const { result, windows } = await runPipeline(audioBuffer, bpm, params, adaptiveStartSample, true);
  return {
    result,
    windows,
    params
  };
}
