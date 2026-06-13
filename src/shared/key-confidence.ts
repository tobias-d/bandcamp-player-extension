import type { KeyAnalysisResult } from '@/shared/types';

export type ConfidenceLevelClass = 'level-low' | 'level-medium' | 'level-high' | 'level-unknown';

export interface KeyDisplayEntry {
  value: string;
  score: number;
  level: ConfidenceLevelClass;
  loading: boolean;
  present: boolean;
}

export interface KeyDisplayResult {
  key1: KeyDisplayEntry;
  key2: KeyDisplayEntry;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseCamelot(raw: string): { n: number; mode: 'A' | 'B' } | null {
  const match = String(raw || '').trim().toUpperCase().match(/^(1[0-2]|[1-9])([AB])$/);
  if (!match) return null;
  return { n: Number(match[1]), mode: match[2] as 'A' | 'B' };
}

function areHarmonicNeighbors(a: string, b: string): boolean {
  const aa = parseCamelot(a);
  const bb = parseCamelot(b);
  if (!aa || !bb) return false;
  if (aa.n === bb.n && aa.mode !== bb.mode) return true;
  if (aa.mode !== bb.mode) return false;
  const diff = Math.abs(aa.n - bb.n);
  return diff === 1 || diff === 11;
}

function levelFromScore(score: number): ConfidenceLevelClass {
  if (!Number.isFinite(score)) return 'level-unknown';
  if (score >= 70) return 'level-high';
  if (score >= 45) return 'level-medium';
  return 'level-low';
}

function emptyEntry(loading = false): KeyDisplayEntry {
  return {
    value: '---',
    score: 0,
    level: 'level-unknown',
    loading,
    present: false
  };
}

function scoreCandidate(result: KeyAnalysisResult, index: number): number {
  const candidate = result.topKeys[index];
  if (!candidate) return 0;

  const top1 = result.topKeys[0];
  const top2 = result.topKeys[1];
  const topGap = top1 && top2 ? Math.max(0, top1.weight - top2.weight) : 25;

  const relNorm = clamp(result.reliability / 10, 0, 1);
  const gapNorm = clamp(topGap / 25, 0, 1);
  const weightNorm = clamp(candidate.weight / 70, 0, 1);
  const windowsNorm = clamp(result.windowsAnalyzed / 20, 0, 1);

  let score = (40 * relNorm) + (35 * gapNorm) + (15 * weightNorm) + (10 * windowsNorm);

  if (result.dualCenter) {
    score -= 20;
  }
  if (top1 && top2 && areHarmonicNeighbors(top1.camelot, top2.camelot)) {
    score -= 10;
  }
  if (index > 0) {
    score -= 10;
  }

  return clamp(score, 0, 100);
}

function makeEntry(result: KeyAnalysisResult, index: number): KeyDisplayEntry {
  const candidate = result.topKeys[index];
  if (!candidate) return emptyEntry(false);
  const score = scoreCandidate(result, index);
  return {
    value: candidate.camelot || '---',
    score,
    level: levelFromScore(score),
    loading: false,
    present: true
  };
}

export function buildKeyDisplay(
  result: KeyAnalysisResult | null | undefined,
  options?: { isAnalyzing?: boolean; key2MinScore?: number }
): KeyDisplayResult {
  const isAnalyzing = Boolean(options?.isAnalyzing);
  const key2MinScore = Number.isFinite(options?.key2MinScore) ? Number(options?.key2MinScore) : 45;

  if (!result) {
    return {
      key1: emptyEntry(isAnalyzing),
      key2: emptyEntry(isAnalyzing)
    };
  }

  const key1 = makeEntry(result, 0);
  const key2 = makeEntry(result, 1);
  if (!key2.present || key2.score < key2MinScore) {
    return { key1, key2: emptyEntry(false) };
  }
  return { key1, key2 };
}
