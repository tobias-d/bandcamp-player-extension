import type { KeyAnalysisResult } from '@/shared/types';

export type KeyDecision = 'AUTO' | 'REVIEW' | 'REJECT';

export interface DecisionOutcome {
  decision: KeyDecision;
  ambiguous: boolean;
  topGapPercent: number;
}

const MIN_AUTO_RELIABILITY = 6;
const MIN_WINDOWS_FOR_DECISION = 8;
const AMBIGUOUS_TOP_GAP_PERCENT = 8;

function normalizeCamelot(raw: string | null | undefined): string | null {
  const value = String(raw || '').trim().toUpperCase();
  const match = value.match(/^(1[0-2]|[1-9])([AB])$/);
  if (!match) return null;
  return `${match[1]}${match[2]}`;
}

export function evaluateDecision(result: KeyAnalysisResult, referenceCamelot?: string | null): DecisionOutcome {
  const top1 = result.topKeys[0] || null;
  const top2 = result.topKeys[1] || null;
  const topGapPercent = top1 && top2 ? Math.max(0, top1.weight - top2.weight) : Infinity;
  const ambiguous = Boolean(result.dualCenter || (top1 && top2 && topGapPercent < AMBIGUOUS_TOP_GAP_PERCENT));
  const reference = normalizeCamelot(referenceCamelot);
  if (reference) {
    const top = result.topKeys.map((k) => normalizeCamelot(k.camelot)).filter(Boolean) as string[];
    if (top[0] === reference) {
      return { decision: 'AUTO', ambiguous, topGapPercent };
    }
    if (top.includes(reference)) {
      return { decision: 'REVIEW', ambiguous, topGapPercent };
    }
    return { decision: 'REJECT', ambiguous, topGapPercent };
  }

  if (!result.topKeys.length || result.windowsAnalyzed < MIN_WINDOWS_FOR_DECISION) {
    return { decision: 'REJECT', ambiguous, topGapPercent };
  }
  if (!ambiguous && result.reliability >= MIN_AUTO_RELIABILITY) {
    return { decision: 'AUTO', ambiguous, topGapPercent };
  }
  return { decision: 'REVIEW', ambiguous, topGapPercent };
}
