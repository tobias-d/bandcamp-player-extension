import type { KeyCandidate } from '@/shared/types';
import { areHarmonicallyClosePair, camelotToKeyName } from '@/background/key/constants';

interface Accumulator {
  camelot: string;
  weight: number;
}

export function aggregateCamelotWeights(
  scores: Array<{ camelot: string; combinedWeight: number }>,
  minCandidateWeight: number
): KeyCandidate[] {
  if (!scores.length) {
    return [];
  }

  const buckets = new Map<string, number>();
  for (const score of scores) {
    if (!score.camelot) {
      continue;
    }
    const prev = buckets.get(score.camelot) ?? 0;
    buckets.set(score.camelot, prev + Math.max(0, Number(score.combinedWeight) || 0));
  }

  const total = Array.from(buckets.values()).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return [];
  }

  const normalized: Accumulator[] = Array.from(buckets.entries()).map(([camelot, value]) => ({
    camelot,
    weight: (value / total) * 100
  }));

  normalized.sort((a, b) => b.weight - a.weight);

  return normalized
    .filter((entry) => entry.weight >= minCandidateWeight)
    .slice(0, 3)
    .map((entry) => ({
      camelot: entry.camelot,
      key: camelotToKeyName(entry.camelot),
      weight: Number(entry.weight.toFixed(3))
    }));
}

export function detectDualCenter(
  topKeys: KeyCandidate[],
  threshold: number,
  reliability: number,
  reliabilityFloor: number
): boolean {
  if (topKeys.length < 2) {
    return false;
  }

  if (reliability < reliabilityFloor * 1.5) {
    return false;
  }

  const first = topKeys[0];
  const second = topKeys[1];
  if (!first || !second || first.weight <= 0) {
    return false;
  }

  if (areHarmonicallyClosePair(first.camelot, second.camelot)) {
    return false;
  }

  const gap = (first.weight - second.weight) / first.weight;
  return gap < threshold;
}
