import { extractRhythmEvidence, type EssentiaTempoResult, type RhythmEvidenceResult } from '@/background/audio/tempo';

const RHYTHM_MIN_BPM = 70;
const RHYTHM_MAX_BPM = 170;

export const HIGH_CORRECTION_MIN_BPM = 150;
export const HIGH_CORRECTION_MAX_BPM = 170;
export const HIGH_NONCLASSIC_CORRECTION_MIN_BPM = 145;
export const HIGH_NONCLASSIC_CORRECTION_MAX_BPM = 149;
const LOW_CORRECTION_MIN_BPM = 85;
const LOW_CORRECTION_MAX_BPM = 100;
const LOW_CORRECTION_MAX_CONFIDENCE = 40;
const MID_UNDERREAD_MIN_BPM = 85;
const MID_UNDERREAD_MAX_BPM = 100;
const MID_DRIFT_MIN_BPM = 120;
const MID_DRIFT_MAX_BPM = 140;
const MID_DRIFT_MAX_CONFIDENCE = 45;
const LOW_CORRECTION_TARGET_MIN_BPM = 112;
const LOW_CORRECTION_TARGET_MAX_BPM = 130;
const LOW_CORRECTION_STRUCTURED_ALIGNMENT_MAX_BPM_DELTA = 4;

export type SupportSignal = 'rhythm' | 'interval' | 'estimate' | 'ticks' | 'family';
export type CorrectionMode = 'high-overshoot' | 'high-overread-nonclassic' | 'low-ambiguous' | 'mid-underread' | 'mid-drift';
type FamilyReferenceRatio = '3/4' | '4/5' | '5/6';
type FamilyReferenceSource = 'rhythm' | 'interval' | 'estimate';

interface CandidateDefinition {
  label: string;
  resolveRawBpm: (baseBpm: number, rhythm: RhythmEvidenceResult) => number;
}

interface FoldedFamilyReference {
  source: FamilyReferenceSource;
  ratio: FamilyReferenceRatio;
  bpm: number;
}

export interface CandidateFamilyReferenceMatch {
  source: FamilyReferenceSource;
  ratio: FamilyReferenceRatio;
  bpm: number;
  score: number;
}

export interface CandidateScore {
  bpm: number;
  rawBpm: number;
  label: string;
  score: number;
  rhythmScore: number;
  intervalScore: number;
  estimateScore: number;
  tickScore: number;
  familyScore: number;
  foldedFamilyScore: number;
  familyBestMatch: CandidateFamilyReferenceMatch | null;
  familyTopMatches: CandidateFamilyReferenceMatch[];
  foldedFamilyBestMatch: CandidateFamilyReferenceMatch | null;
  foldedFamilyTopMatches: CandidateFamilyReferenceMatch[];
  supportSignals: SupportSignal[];
}

export interface TempoCorrectionEvaluation {
  mode: CorrectionMode;
  rhythm: RhythmEvidenceResult;
  scored: CandidateScore[];
  baseCandidate: CandidateScore;
  alternativeCandidates: CandidateScore[];
}

export function isLowCorrectionMode(mode: CorrectionMode): boolean {
  return mode === 'low-ambiguous' || mode === 'mid-underread';
}

export function selectPreferredCorrectionAlternative(evaluation: TempoCorrectionEvaluation): CandidateScore | null {
  const { mode, alternativeCandidates } = evaluation;
  const bestAlternative = alternativeCandidates[0] ?? null;
  if (!bestAlternative) {
    return null;
  }

  if (!isLowCorrectionMode(mode)) {
    return bestAlternative;
  }

  const fallback = alternativeCandidates.find((candidate) => candidate.label === 'rhythm') ?? bestAlternative;
  const structuredAlternative = alternativeCandidates.find((candidate) => candidate.label !== 'rhythm') ?? null;
  const roundedFallbackBpm = Math.round(fallback.bpm);
  const alignedStructuredFiveQuarterAlternative = (
    structuredAlternative
    && structuredAlternative.label === '5/4'
    && roundedFallbackBpm >= LOW_CORRECTION_TARGET_MIN_BPM
    && roundedFallbackBpm <= LOW_CORRECTION_TARGET_MAX_BPM
    && Math.abs(fallback.bpm - structuredAlternative.bpm) <= LOW_CORRECTION_STRUCTURED_ALIGNMENT_MAX_BPM_DELTA
    && structuredAlternative.score >= 0.9
    && structuredAlternative.intervalScore >= 0.9
    && structuredAlternative.estimateScore >= 0.9
    && structuredAlternative.tickScore >= 0.82
    && structuredAlternative.supportSignals.length >= 3
    && structuredAlternative.score >= fallback.score - 0.02
  );

  if (alignedStructuredFiveQuarterAlternative) {
    return structuredAlternative;
  }

  if (
    structuredAlternative
    && structuredAlternative.familyScore >= 0.72
    && structuredAlternative.score >= fallback.score - 0.06
  ) {
    return structuredAlternative;
  }

  return fallback;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

export function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

export function median(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!finite.length) {
    return 0;
  }
  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 0) {
    return (finite[middle - 1] + finite[middle]) / 2;
  }
  return finite[middle];
}

function closenessScore(candidateBpm: number, referenceBpm: number, toleranceRatio = 0.08): number {
  if (!Number.isFinite(candidateBpm) || candidateBpm <= 0 || !Number.isFinite(referenceBpm) || referenceBpm <= 0) {
    return 0;
  }

  const distance = Math.abs(Math.log(candidateBpm / referenceBpm));
  const tolerance = Math.log(1 + toleranceRatio);
  if (tolerance <= 0) {
    return 0;
  }
  return clamp01(1 - distance / tolerance);
}

function estimateNeighborhoodSupport(estimates: number[], candidateBpm: number, toleranceRatio = 0.06): number {
  const finite = estimates.filter((value) => Number.isFinite(value) && value > 0);
  if (!finite.length || !Number.isFinite(candidateBpm) || candidateBpm <= 0) {
    return 0;
  }

  const threshold = Math.log(1 + toleranceRatio);
  let matches = 0;
  for (const estimate of finite) {
    const distance = Math.abs(Math.log(estimate / candidateBpm));
    if (distance <= threshold) {
      matches += 1;
    }
  }
  return matches / finite.length;
}

function intervalConsistencyScore(intervals: number[], candidateBpm: number): number {
  const targetInterval = 60 / candidateBpm;
  if (!Number.isFinite(targetInterval) || targetInterval <= 0) {
    return 0;
  }

  const positiveIntervals = intervals.filter((value) => Number.isFinite(value) && value > 0);
  if (!positiveIntervals.length) {
    return 0;
  }

  const derivedBpm = 60 / median(positiveIntervals);
  return closenessScore(candidateBpm, derivedBpm, 0.08);
}

function tickConsistencyScore(ticks: number[], candidateBpm: number): number {
  const targetInterval = 60 / candidateBpm;
  if (!Number.isFinite(targetInterval) || targetInterval <= 0) {
    return 0;
  }

  const deltas: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const delta = ticks[i] - ticks[i - 1];
    if (Number.isFinite(delta) && delta > 0) {
      deltas.push(delta);
    }
  }
  if (!deltas.length) {
    return 0;
  }

  let total = 0;
  let count = 0;
  for (const delta of deltas) {
    const multiples = delta / targetInterval;
    const nearest = Math.max(1, Math.round(multiples));
    const error = Math.abs(multiples - nearest);
    const score = clamp01(1 - error / 0.2);
    total += score;
    count += 1;
  }

  return count > 0 ? total / count : 0;
}

function isSuspiciousDoubleHigh(baseBpm: number, rhythmBpm: number): boolean {
  return (
    baseBpm >= 158
    && baseBpm <= 165
    && rhythmBpm >= 148
    && rhythmBpm <= 165
    && Math.abs(baseBpm - rhythmBpm) <= 10
  );
}

function buildFoldedFamilyReferences(
  rhythmBpm: number,
  intervalDerivedBpm: number,
  estimateMedianBpm: number
): FoldedFamilyReference[] {
  const rawSources: Array<{ source: FamilyReferenceSource; bpm: number }> = [
    { source: 'rhythm', bpm: rhythmBpm },
    { source: 'interval', bpm: intervalDerivedBpm },
    { source: 'estimate', bpm: estimateMedianBpm }
  ];
  const sources = rawSources.filter((entry) => Number.isFinite(entry.bpm) && entry.bpm > 0);
  const ratios: Array<{ ratio: FamilyReferenceRatio; value: number }> = [
    { ratio: '3/4', value: 3 / 4 },
    { ratio: '4/5', value: 4 / 5 },
    { ratio: '5/6', value: 5 / 6 }
  ];

  return sources.flatMap(({ source, bpm }) =>
    ratios.map(({ ratio, value }) => ({
      source,
      ratio,
      bpm: bpm * value
    }))
  );
}

function resolveFamilyReferenceRatio(label: string): FamilyReferenceRatio | null {
  if (label === '3/4' || label === '4/5' || label === '5/6') {
    return label;
  }
  return null;
}

function buildAlignedFamilyReferences(
  label: string,
  rhythmBpm: number,
  intervalDerivedBpm: number,
  estimateMedianBpm: number
): FoldedFamilyReference[] {
  const ratio = resolveFamilyReferenceRatio(label);
  if (!ratio) {
    return [];
  }

  return buildFoldedFamilyReferences(rhythmBpm, intervalDerivedBpm, estimateMedianBpm)
    .filter((reference) => reference.ratio === ratio);
}

function evaluateFoldedFamilyReferences(
  candidateBpm: number,
  references: FoldedFamilyReference[]
): {
  score: number;
  bestMatch: CandidateFamilyReferenceMatch | null;
  topMatches: CandidateFamilyReferenceMatch[];
} {
  if (!references.length || !Number.isFinite(candidateBpm) || candidateBpm <= 0) {
    return {
      score: 0,
      bestMatch: null,
      topMatches: []
    };
  }

  const matches = references
    .map((reference) => ({
      source: reference.source,
      ratio: reference.ratio,
      bpm: reference.bpm,
      score: closenessScore(candidateBpm, reference.bpm, 0.05)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return Math.abs(left.bpm - candidateBpm) - Math.abs(right.bpm - candidateBpm);
    });

  const bestMatch = matches[0] ?? null;
  return {
    score: bestMatch?.score ?? 0,
    bestMatch,
    topMatches: matches.slice(0, 3)
  };
}

function scoreCandidate(
  candidate: CandidateDefinition,
  baseBpm: number,
  rhythm: RhythmEvidenceResult,
  mode: CorrectionMode
): CandidateScore {
  const rawBpm = candidate.resolveRawBpm(baseBpm, rhythm);
  const bpm = Math.round(rawBpm);
  const intervalDerivedBpm = rhythm.bpmIntervals.length ? 60 / median(rhythm.bpmIntervals) : 0;
  const estimateMedianBpm = rhythm.estimates.length ? median(rhythm.estimates) : 0;
  const suspiciousDoubleHigh = mode === 'high-overshoot' && isSuspiciousDoubleHigh(baseBpm, rhythm.bpm);
  const lowCorrectionMode = isLowCorrectionMode(mode);
  const familyReferences = candidate.label === 'base'
    ? []
    : suspiciousDoubleHigh
      ? buildFoldedFamilyReferences(rhythm.bpm, intervalDerivedBpm, estimateMedianBpm)
      : lowCorrectionMode
        ? buildFoldedFamilyReferences(rhythm.bpm, intervalDerivedBpm, estimateMedianBpm)
      : [];
  const alignedFamilyReferences = candidate.label === 'base'
    ? []
    : suspiciousDoubleHigh
      ? buildAlignedFamilyReferences(candidate.label, rhythm.bpm, intervalDerivedBpm, estimateMedianBpm)
      : [];
  const foldedFamilyEvaluation = evaluateFoldedFamilyReferences(rawBpm, familyReferences);
  const alignedFamilyEvaluation = evaluateFoldedFamilyReferences(rawBpm, alignedFamilyReferences);
  const familyScore = alignedFamilyEvaluation.score;
  const rhythmScore = Math.max(
    closenessScore(rawBpm, rhythm.bpm, 0.08),
    closenessScore(rawBpm, intervalDerivedBpm, 0.08)
  );
  const intervalScore = intervalConsistencyScore(rhythm.bpmIntervals, rawBpm);
  const estimateScore = Math.max(
    estimateNeighborhoodSupport(rhythm.estimates, rawBpm, 0.06),
    closenessScore(rawBpm, estimateMedianBpm, 0.08)
  );
  const tickScore = tickConsistencyScore(rhythm.ticks, rawBpm);
  const baseScore = (rhythmScore * 0.35) + (intervalScore * 0.3) + (estimateScore * 0.2) + (tickScore * 0.15);
  const activeFamilyScore = suspiciousDoubleHigh ? alignedFamilyEvaluation.score : lowCorrectionMode ? foldedFamilyEvaluation.score : 0;
  const familyBlend = suspiciousDoubleHigh
    ? (activeFamilyScore * 0.72) + (intervalScore * 0.12) + (estimateScore * 0.08) + (tickScore * 0.08)
    : lowCorrectionMode
      ? (activeFamilyScore * 0.7) + (intervalScore * 0.15) + (estimateScore * 0.1) + (tickScore * 0.05)
      : 0;
  const suspicionPenalty = suspiciousDoubleHigh && candidate.label === 'base' ? 0.62 : 1;
  const score = Math.max(baseScore * suspicionPenalty, familyBlend);
  const supportSignals: SupportSignal[] = [];

  if (rhythmScore >= 0.72) {
    supportSignals.push('rhythm');
  }
  if (intervalScore >= 0.68) {
    supportSignals.push('interval');
  }
  if (estimateScore >= 0.55) {
    supportSignals.push('estimate');
  }
  if (tickScore >= 0.68) {
    supportSignals.push('ticks');
  }
  if (activeFamilyScore >= 0.72) {
    supportSignals.push('family');
  }

  return {
    bpm,
    rawBpm,
    label: candidate.label,
    score,
    rhythmScore,
    intervalScore,
    estimateScore,
    tickScore,
    familyScore: activeFamilyScore,
    foldedFamilyScore: foldedFamilyEvaluation.score,
    familyBestMatch: alignedFamilyEvaluation.bestMatch,
    familyTopMatches: alignedFamilyEvaluation.topMatches,
    foldedFamilyBestMatch: foldedFamilyEvaluation.bestMatch,
    foldedFamilyTopMatches: foldedFamilyEvaluation.topMatches,
    supportSignals
  };
}

export function resolveCorrectionMode(baseTempo: EssentiaTempoResult): CorrectionMode | null {
  if (baseTempo.bpm >= HIGH_CORRECTION_MIN_BPM && baseTempo.bpm <= HIGH_CORRECTION_MAX_BPM) {
    return 'high-overshoot';
  }

  if (baseTempo.bpm >= HIGH_NONCLASSIC_CORRECTION_MIN_BPM && baseTempo.bpm <= HIGH_NONCLASSIC_CORRECTION_MAX_BPM) {
    return 'high-overread-nonclassic';
  }

  if (
    baseTempo.bpm >= LOW_CORRECTION_MIN_BPM
    && baseTempo.bpm <= LOW_CORRECTION_MAX_BPM
    && baseTempo.confidence <= LOW_CORRECTION_MAX_CONFIDENCE
  ) {
    return 'low-ambiguous';
  }

  if (baseTempo.bpm >= MID_UNDERREAD_MIN_BPM && baseTempo.bpm <= MID_UNDERREAD_MAX_BPM) {
    return 'mid-underread';
  }

  if (
    baseTempo.bpm >= MID_DRIFT_MIN_BPM
    && baseTempo.bpm <= MID_DRIFT_MAX_BPM
    && baseTempo.confidence <= MID_DRIFT_MAX_CONFIDENCE
  ) {
    return 'mid-drift';
  }

  return null;
}

function buildCandidates(mode: CorrectionMode): CandidateDefinition[] {
  if (mode === 'high-overshoot') {
    return [
      { label: 'base', resolveRawBpm: (baseBpm) => baseBpm },
      { label: '3/4', resolveRawBpm: (baseBpm) => baseBpm * 0.75 },
      { label: '4/5', resolveRawBpm: (baseBpm) => baseBpm * 0.8 }
    ];
  }

  if (mode === 'high-overread-nonclassic') {
    return [
      { label: 'base', resolveRawBpm: (baseBpm) => baseBpm },
      { label: '3/4', resolveRawBpm: (baseBpm) => baseBpm * 0.75 },
      { label: '4/5', resolveRawBpm: (baseBpm) => baseBpm * 0.8 }
    ];
  }

  if (mode === 'mid-underread' || mode === 'low-ambiguous') {
    return [
      { label: 'base', resolveRawBpm: (baseBpm) => baseBpm },
      ...(mode === 'low-ambiguous'
        ? [{ label: '5/4', resolveRawBpm: (baseBpm: number) => baseBpm * 1.25 }]
        : [{ label: '3/2', resolveRawBpm: (baseBpm: number) => baseBpm * 1.5 }]),
      { label: 'rhythm', resolveRawBpm: (_baseBpm, rhythm) => rhythm.bpm }
    ];
  }

  if (mode === 'mid-drift') {
    return [
      { label: 'base', resolveRawBpm: (baseBpm) => baseBpm },
      { label: 'rhythm', resolveRawBpm: (_baseBpm, rhythm) => rhythm.bpm }
    ];
  }
  return [];
}

export async function evaluateTempoCorrectionCandidates(
  audioBuffer: AudioBuffer,
  baseTempo: EssentiaTempoResult
): Promise<TempoCorrectionEvaluation | null> {
  const mode = resolveCorrectionMode(baseTempo);
  if (!mode) {
    return null;
  }

  const rhythm = await extractRhythmEvidence(audioBuffer, {
    minBpm: RHYTHM_MIN_BPM,
    maxBpm: RHYTHM_MAX_BPM,
    quality: 'fast'
  });
  if (!Number.isFinite(rhythm.bpm) || rhythm.bpm <= 0) {
    return null;
  }

  const scored = buildCandidates(mode)
    .map((candidate) => scoreCandidate(candidate, baseTempo.bpm, rhythm, mode))
    .sort((a, b) => b.score - a.score);
  const baseCandidate = scored.find((candidate) => candidate.label === 'base');
  const alternativeCandidates = scored.filter((candidate) => candidate.label !== 'base');

  if (!baseCandidate || !alternativeCandidates.length) {
    return null;
  }

  return {
    mode,
    rhythm,
    scored,
    baseCandidate,
    alternativeCandidates
  };
}
