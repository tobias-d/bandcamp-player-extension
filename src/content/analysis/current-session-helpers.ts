import type { AnalysisResult, KeyAnalysisResult } from '@/shared/types';
import { isRefiningAnalysisStatus, isSettledBpmAnalysisStatus } from '@/content/analysis/debug-helpers';

type BpmProgressAnalysis = Pick<AnalysisResult, 'sourceUrl' | 'bpm' | 'error' | 'analysisStatus'>;

export interface BpmPartialSummary {
  bpm: number;
  partialIsRefining: boolean;
  settledStatus: boolean;
  bpmTerminal: boolean;
  hasTerminalAnalysisState: boolean;
}

export function isBpmAnalysisInProgressForSource(
  analysis: BpmProgressAnalysis | null | undefined,
  currentSource: string
): boolean {
  if (!analysis) {
    return false;
  }

  const normalizedSource = String(currentSource || '').trim();
  const analysisSource = String(analysis.sourceUrl || '').trim();
  if (!normalizedSource || analysisSource !== normalizedSource) {
    return false;
  }

  if (Number.isFinite(analysis.bpm) || analysis.error) {
    return false;
  }

  const status = String(analysis.analysisStatus || '').trim().toLowerCase();
  return status.includes('fetching') || status.includes('estimating') || status.includes('preparing');
}

export function resolveKeyStatusFromAnalysis(
  keyAnalysisEnabled: boolean,
  keyAnalysis: KeyAnalysisResult | null | undefined
): AnalysisResult['keyStatus'] {
  if (!keyAnalysisEnabled) {
    return 'disabled';
  }
  if (!keyAnalysis) {
    return undefined;
  }
  return keyAnalysis.topKeys.length > 0 ? 'ready' : 'empty';
}

export function summarizeBpmPartial(partial: Partial<AnalysisResult>): BpmPartialSummary {
  const bpm = Number(partial.bpm);
  const partialIsRefining = isRefiningAnalysisStatus(partial.analysisStatus);
  const settledStatus = isSettledBpmAnalysisStatus(partial.analysisStatus);
  const bpmTerminal = (
    (Number.isFinite(bpm) && !partialIsRefining)
    || Boolean(String(partial.error || '').trim())
  );

  return {
    bpm,
    partialIsRefining,
    settledStatus,
    bpmTerminal,
    hasTerminalAnalysisState: bpmTerminal
  };
}

export function resolveNextKeyStatusFromPartial(input: {
  keyAnalysisEnabled: boolean;
  partial: Partial<AnalysisResult>;
  bpm: number;
  previousKeyStatus: AnalysisResult['keyStatus'] | undefined;
}): AnalysisResult['keyStatus'] {
  const { keyAnalysisEnabled, partial, bpm, previousKeyStatus } = input;
  if (!keyAnalysisEnabled) {
    return 'disabled';
  }
  if (partial.keyAnalysis) {
    return resolveKeyStatusFromAnalysis(true, partial.keyAnalysis);
  }
  if (typeof partial.error === 'string' && partial.error.trim() && !Number.isFinite(bpm)) {
    return 'error';
  }
  return partial.keyStatus ?? previousKeyStatus ?? 'pending-bpm';
}

export function shouldRequestKeyAfterBpmPartial(input: {
  keyAnalysisEnabled: boolean;
  partial: Partial<AnalysisResult>;
  bpm: number;
  settledStatus: boolean;
  contextReady: boolean;
}): boolean {
  const { keyAnalysisEnabled, partial, bpm, settledStatus, contextReady } = input;
  return (
    keyAnalysisEnabled
    && !partial.keyAnalysis
    && Number.isFinite(bpm)
    && settledStatus
    && contextReady
  );
}
