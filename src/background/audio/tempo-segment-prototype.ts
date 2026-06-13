import { estimateTempo, findAdaptiveAnalysisStartSample, type RhythmEvidenceResult } from '@/background/audio/tempo';
import {
  evaluateTempoCorrectionCandidates,
  roundScore,
  type TempoCorrectionEvaluation
} from '@/background/audio/tempo-correction-support';
import type { EssentiaTempoResult } from '@/background/audio/tempo';
import type {
  BpmPrototypeAnalysisResult,
  BpmPrototypeRecommendation,
  BpmPrototypeSegmentResult,
  BpmPrototypeVoteSummary
} from '@/shared/types';

const PROTOTYPE_TEMPO_OPTIONS = {
  method: 'percival' as const,
  minBpm: 70,
  maxBpm: 170,
  targetMinBpm: 70,
  targetMaxBpm: 170,
  preferFasterAmbiguous: true,
  includeConfidence: false,
  quality: 'fast' as const
};

const SEGMENT_LENGTH_SEC = 16;
const HOP_LENGTH_SEC = 8;
const MIN_SEGMENT_LENGTH_SEC = 10;
const MAX_RUNTIME_SEGMENT_ANALYSIS_SECONDS = 72;
const DEFAULT_MAX_WINDOWS = 4;
const DEFAULT_SPARSE_MAX_WINDOWS = 6;
const FAMILY_CLUSTER_TOLERANCE = 4;
const PROMOTION_MIN_WEIGHT = 8;
const PROMOTION_MIN_WEIGHTED_SHARE = 0.55;
const PROMOTION_MIN_DIRECT_COUNT = 4;
const PROMOTION_MIN_REMAPPED_COUNT = 4;
const PROMOTION_BASE_MARGIN = 3;
const PROMOTION_SPLIT_SUPPORT_MAX_BASE_WEIGHT = 0.25;
const PROMOTION_COMBINED_34_MIN_WEIGHT = 0.8;
const PROMOTION_COMBINED_34_MIN_WEIGHTED_SHARE = 0.58;
const PROMOTION_COMBINED_34_REMAPPED_WEIGHT = 0.75;
const PROMOTION_COMBINED_34_FULL_TRACK_SCORE_MIN = 0.95;
const PROMOTION_COMBINED_34_FULL_TRACK_BASE_SCORE_MAX = 0.1;
const PROMOTION_COMBINED_34_FULL_TRACK_BOOST = 1.5;
const PROMOTION_COMBINED_34_MIN_SUPPORT = 2.2;
const SEGMENT_RULE_VERSION = 'segment-vote-v2-split34';
const SPARSE_PROMOTION_MIN_WEIGHT = 1.2;
const SPARSE_PROMOTION_MIN_WEIGHTED_SHARE = 0.45;
const SPARSE_PROMOTION_MIN_DIRECT_COUNT = 2;
const SPARSE_PROMOTION_MIN_REMAPPED_COUNT = 1;
const SPARSE_FALSE_160_BASE_SCORE_MAX = 0.38;
const SPARSE_FALSE_160_MIXED_SCORE_MIN = 0.5;
const SPARSE_SPLIT_LEAKY_FALSE_160_BASE_BPM_MIN = 158;
const SPARSE_SPLIT_LEAKY_FALSE_160_BASE_BPM_MAX = 164;
const SPARSE_SPLIT_LEAKY_FALSE_160_SCORE_MAX = 0.1;
const SPARSE_SPLIT_LEAKY_FALSE_160_FOLDED_34_MIN = 0.65;
const SPARSE_SPLIT_LEAKY_FALSE_160_FOLDED_45_MIN = 0.75;
const SPARSE_SPLIT_LEAKY_FALSE_160_MIN_WEIGHT = 0.5;
const SPARSE_SPLIT_LEAKY_FALSE_160_MAX_WEIGHT_GAP = 0.08;
const SPARSE_SPLIT_LEAKY_FALSE_160_MIN_DIRECT_COUNT = 1;

type CandidateLike = { bpm: number; label: string; score: number };
type FamilyLabel = 'base' | '3/4' | '4/5';

interface FamilyTarget {
  label: FamilyLabel;
  bpm: number;
  tolerance: number;
}

interface StableSupport {
  label: FamilyLabel;
  bpm: number;
  reliability: number;
  supportType: BpmPrototypeSegmentResult['supportType'];
}

interface VoteAccumulator {
  label: FamilyLabel;
  supports: Array<{
    bpm: number;
    reliability: number;
    supportType: BpmPrototypeSegmentResult['supportType'];
  }>;
}

interface UnderreadSupportOptions {
  toleranceRatio?: number;
  minimumReliability?: number;
  minimumEstimateMatch?: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function closenessScore(candidateBpm: number, referenceBpm: number, toleranceRatio = 0.05): number {
  if (!Number.isFinite(candidateBpm) || candidateBpm <= 0 || !Number.isFinite(referenceBpm) || referenceBpm <= 0) {
    return 0;
  }

  const distance = Math.abs(Math.log(candidateBpm / referenceBpm));
  const tolerance = Math.log(1 + toleranceRatio);
  if (tolerance <= 0) {
    return 0;
  }
  return clamp(1 - distance / tolerance, 0, 1);
}

function median(values: number[]): number {
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

function createSlicedAudioBuffer(audioBuffer: AudioBuffer, startSeconds: number, endSeconds: number): AudioBuffer {
  const startSample = Math.max(0, Math.floor(startSeconds * audioBuffer.sampleRate));
  const endSample = Math.min(audioBuffer.length, Math.ceil(endSeconds * audioBuffer.sampleRate));
  const length = Math.max(1, endSample - startSample);
  const sliced = new AudioBuffer({
    length,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate
  });

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const source = audioBuffer.getChannelData(channel).subarray(startSample, endSample);
    sliced.copyToChannel(source, channel, 0);
  }

  return sliced;
}

function buildWindowStarts(
  audioBuffer: AudioBuffer,
  analysisDurationSec: number,
  maxWindows: number
): number[] {
  const maxStart = Math.max(0, analysisDurationSec - SEGMENT_LENGTH_SEC);
  const adaptiveStartSample = findAdaptiveAnalysisStartSample(audioBuffer);
  const adaptiveStartSec = adaptiveStartSample === null
    ? Math.min(8, maxStart)
    : Math.min(Math.max(0, adaptiveStartSample / audioBuffer.sampleRate), maxStart);

  const desiredWindows = Math.max(1, Math.min(maxWindows, Math.floor(analysisDurationSec / MIN_SEGMENT_LENGTH_SEC)));
  if (desiredWindows <= 1 || maxStart <= 0) {
    return [round2(Math.min(adaptiveStartSec, maxStart))];
  }

  const starts = new Set<number>();
  starts.add(round2(adaptiveStartSec));

  const step = maxStart / Math.max(1, desiredWindows - 1);
  for (let index = 0; index < desiredWindows; index += 1) {
    starts.add(round2(Math.min(maxStart, index * step)));
  }

  const sorted = Array.from(starts).sort((left, right) => left - right);
  if (sorted.length <= desiredWindows) {
    return sorted;
  }

  const selected: number[] = [];
  for (let index = 0; index < desiredWindows; index += 1) {
    const mappedIndex = Math.round(index * (sorted.length - 1) / Math.max(1, desiredWindows - 1));
    const candidate = sorted[mappedIndex];
    if (Number.isFinite(candidate) && !selected.includes(candidate)) {
      selected.push(candidate);
    }
  }

  for (const candidate of sorted) {
    if (selected.length >= desiredWindows) {
      break;
    }
    if (!selected.includes(candidate)) {
      selected.push(candidate);
    }
  }

  return selected.sort((left, right) => left - right);
}

function chooseWinningCandidate(
  candidates: CandidateLike[],
  baseBpm: number
): CandidateLike {
  if (!candidates.length) {
    return { bpm: baseBpm, label: 'base', score: 1 };
  }

  const sorted = [...candidates].sort((left, right) => right.score - left.score || left.bpm - right.bpm);
  return sorted[0] ?? { bpm: baseBpm, label: 'base', score: 1 };
}

function buildFamilyTargets(trackBaseBpm: number): FamilyTarget[] {
  return [
    {
      label: '3/4',
      bpm: trackBaseBpm * 0.75,
      tolerance: 5
    },
    {
      label: '4/5',
      bpm: trackBaseBpm * 0.8,
      tolerance: 5
    },
    {
      label: 'base',
      bpm: trackBaseBpm,
      tolerance: 6
    }
  ];
}

function resolveFamilyLabelBpm(baseBpm: number, label: FamilyLabel, fallbackBpm: number): number {
  if (label === '3/4') {
    return Math.round(baseBpm * 0.75);
  }
  if (label === '4/5') {
    return Math.round(baseBpm * 0.8);
  }
  return Math.round(fallbackBpm);
}

function findNearestFamily(bpm: number, targets: FamilyTarget[]): FamilyTarget | null {
  let best: FamilyTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const distance = Math.abs(bpm - target.bpm);
    if (distance > target.tolerance) {
      continue;
    }
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }

  return best;
}

function classifyStableSupport(
  segment: Pick<BpmPrototypeSegmentResult, 'winningLabel' | 'winningBpm' | 'winningScore' | 'baseScore'>,
  targets: FamilyTarget[]
): StableSupport | null {
  const nearestFamily = findNearestFamily(segment.winningBpm, targets);
  if (!nearestFamily) {
    return null;
  }

  if (nearestFamily.label === 'base') {
    const reliability = Math.max(segment.winningScore, segment.baseScore);
    if (reliability < 0.35) {
      return null;
    }
    return {
      label: 'base',
      bpm: segment.winningBpm,
      reliability: round2(reliability),
      supportType: 'direct'
    };
  }

  if (segment.winningLabel === 'base') {
    if (segment.baseScore < 0.9) {
      return null;
    }
    return {
      label: nearestFamily.label,
      bpm: segment.winningBpm,
      reliability: round2(clamp(segment.baseScore * 0.85, 0, 1)),
      supportType: 'remapped-base'
    };
  }

  if (segment.winningScore < 0.45) {
    return null;
  }

  return {
    label: nearestFamily.label,
    bpm: segment.winningBpm,
    reliability: round2(segment.winningScore),
    supportType: 'direct'
  };
}

function detectSupportType(
  segment: Pick<BpmPrototypeSegmentResult, 'winningLabel' | 'winningScore' | 'baseScore'>,
  stableSupport: StableSupport | null
): BpmPrototypeSegmentResult['supportType'] {
  if (stableSupport) {
    return stableSupport.supportType;
  }
  if (segment.winningLabel === 'base' && segment.baseScore < 0.35) {
    return 'weak-base';
  }
  if (segment.winningLabel !== 'base' && segment.winningScore < 0.45) {
    return 'low-score';
  }
  return 'outlier';
}

function estimateNeighborhoodSupport(estimates: number[], candidateBpm: number, toleranceRatio = 0.05): number {
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

function detectUnderreadSupport(
  rhythm: RhythmEvidenceResult | null | undefined,
  targets: FamilyTarget[],
  options?: UnderreadSupportOptions
): StableSupport | null {
  if (!rhythm) {
    return null;
  }

  const toleranceRatio = options?.toleranceRatio ?? 0.04;
  const minimumReliability = options?.minimumReliability ?? 0.72;
  const minimumEstimateMatch = options?.minimumEstimateMatch ?? 0.45;

  const intervalDerivedBpm = rhythm.bpmIntervals.length ? 60 / median(rhythm.bpmIntervals) : 0;
  const estimateMedianBpm = rhythm.estimates.length ? median(rhythm.estimates) : 0;

  let best: StableSupport | null = null;
  let bestReliability = 0;

  for (const target of targets) {
    if (target.label === 'base') {
      continue;
    }

    const intervalMatch = closenessScore(intervalDerivedBpm, target.bpm, toleranceRatio);
    const estimateMatch = Math.max(
      closenessScore(estimateMedianBpm, target.bpm, toleranceRatio),
      estimateNeighborhoodSupport(rhythm.estimates, target.bpm, toleranceRatio),
      estimateNeighborhoodSupport(rhythm.estimates, target.bpm - 1, toleranceRatio),
      estimateNeighborhoodSupport(rhythm.estimates, target.bpm + 1, toleranceRatio)
    );
    const reliability = round2((intervalMatch * 0.45) + (estimateMatch * 0.55));

    if (
      reliability >= minimumReliability
      && estimateMatch >= minimumEstimateMatch
      && reliability > bestReliability
    ) {
      const derivedCandidates = [intervalDerivedBpm, estimateMedianBpm]
        .filter((value) => closenessScore(value, target.bpm, toleranceRatio) >= 0.6);
      const derivedBpm = derivedCandidates.length ? median(derivedCandidates) : target.bpm;
      best = {
        label: target.label,
        bpm: derivedBpm,
        reliability,
        supportType: 'remapped-base'
      };
      bestReliability = reliability;
    }
  }

  return best;
}

function clusterSupportsByFamily(segments: BpmPrototypeSegmentResult[]): Map<FamilyLabel, VoteAccumulator> {
  const grouped = new Map<FamilyLabel, VoteAccumulator>();

  for (const segment of segments) {
    if (!segment.stableLabel || !Number.isFinite(segment.stableBpm)) {
      continue;
    }
    const label = segment.stableLabel as FamilyLabel;
    const entry = grouped.get(label) || { label, supports: [] };
    entry.supports.push({
      bpm: Number(segment.stableBpm),
      reliability: segment.reliability,
      supportType: segment.supportType
    });
    grouped.set(label, entry);
  }

  for (const [label, entry] of grouped.entries()) {
    const clusterMedian = median(entry.supports.map((support) => support.bpm));
    const clustered = entry.supports.filter((support) => Math.abs(support.bpm - clusterMedian) <= FAMILY_CLUSTER_TOLERANCE);
    grouped.set(label, { label, supports: clustered });
  }

  return grouped;
}

function buildVoteSummary(
  grouped: Map<FamilyLabel, VoteAccumulator>,
  stableSegmentCount: number
): BpmPrototypeVoteSummary[] {
  const totalWeight = Array.from(grouped.values())
    .flatMap((entry) => entry.supports)
    .reduce((sum, support) => sum + support.reliability, 0);

  return Array.from(grouped.values())
    .map((entry) => {
      const count = entry.supports.length;
      const weight = entry.supports.reduce((sum, support) => sum + support.reliability, 0);
      const directCount = entry.supports.filter((support) => support.supportType === 'direct').length;
      const remappedCount = entry.supports.filter((support) => support.supportType === 'remapped-base').length;

      return {
        label: entry.label,
        count,
        share: round2(count / Math.max(1, stableSegmentCount)),
        weight: round2(weight),
        weightedShare: round2(weight / Math.max(1, totalWeight)),
        medianBpm: Math.round(median(entry.supports.map((support) => support.bpm))),
        averageScore: round2(weight / Math.max(1, count)),
        directCount,
        remappedCount
      };
    })
    .filter((vote) => vote.count > 0)
    .sort((left, right) => right.weight - left.weight || right.count - left.count || right.averageScore - left.averageScore);
}

function buildRecommendation(
  votes: BpmPrototypeVoteSummary[],
  baseBpm: number,
  fullTrackEvaluation: TempoCorrectionEvaluation | null = null
): BpmPrototypeRecommendation {
  const baseVote = votes.find((vote) => vote.label === 'base') || null;
  const slowerVotes = votes
    .filter((vote) => vote.label !== 'base' && vote.medianBpm < baseBpm)
    .sort((left, right) => right.weight - left.weight || right.count - left.count || right.averageScore - left.averageScore);
  const bestSlower = slowerVotes[0] || null;

  if (!bestSlower) {
    return {
      action: 'keep-base',
      label: 'base',
      bpm: Math.round(baseBpm),
      confidence: 0,
      reason: 'No stable slower cluster survived filtering.'
    };
  }

  const baseWeight = baseVote?.weight || 0;
  const hasEnoughWeight = bestSlower.weight >= PROMOTION_MIN_WEIGHT;
  const hasEnoughShare = bestSlower.weightedShare >= PROMOTION_MIN_WEIGHTED_SHARE;
  const hasEnoughDirectSupport = bestSlower.directCount >= PROMOTION_MIN_DIRECT_COUNT;
  const hasEnoughRemappedSupport = bestSlower.remappedCount >= PROMOTION_MIN_REMAPPED_COUNT;
  const clearsBase = bestSlower.weight >= baseWeight + PROMOTION_BASE_MARGIN;
  const combinedSupportCount = bestSlower.directCount + bestSlower.remappedCount;
  const hasLowBaseResistance = baseWeight <= PROMOTION_SPLIT_SUPPORT_MAX_BASE_WEIGHT;
  const fullTrack34Score = findCandidateScore(fullTrackEvaluation, '3/4');
  const fullTrackBaseScore = fullTrackEvaluation?.baseCandidate.score ?? 1;
  const hasStrongFullTrack34 = (
    bestSlower.label === '3/4'
    && fullTrack34Score >= PROMOTION_COMBINED_34_FULL_TRACK_SCORE_MIN
    && fullTrackBaseScore <= PROMOTION_COMBINED_34_FULL_TRACK_BASE_SCORE_MAX
  );
  const combined34Support = (
    bestSlower.directCount
    + (bestSlower.remappedCount * PROMOTION_COMBINED_34_REMAPPED_WEIGHT)
    + (hasStrongFullTrack34 ? PROMOTION_COMBINED_34_FULL_TRACK_BOOST : 0)
  );
  const hasDominantCombined34Support = (
    bestSlower.label === '3/4'
    && bestSlower.weight >= PROMOTION_COMBINED_34_MIN_WEIGHT
    && bestSlower.weightedShare >= PROMOTION_COMBINED_34_MIN_WEIGHTED_SHARE
    && combined34Support >= PROMOTION_COMBINED_34_MIN_SUPPORT
    && hasLowBaseResistance
  );

  if (
    (hasEnoughWeight && hasEnoughShare && hasEnoughDirectSupport && hasEnoughRemappedSupport && clearsBase)
    || hasDominantCombined34Support
  ) {
    const promotedForCombined34Support = hasDominantCombined34Support
      && !(hasEnoughWeight && hasEnoughShare && hasEnoughDirectSupport && hasEnoughRemappedSupport && clearsBase);
    const promotedLabel = bestSlower.label as FamilyLabel;
    return {
      action: 'promote-slower',
      label: promotedLabel,
      bpm: resolveFamilyLabelBpm(baseBpm, promotedLabel, bestSlower.medianBpm),
      confidence: clamp(
        Math.round(
          (bestSlower.weightedShare * 55)
          + (bestSlower.averageScore * 20)
          + (Math.min(bestSlower.directCount, 10) * 2)
          + (Math.min(bestSlower.remappedCount, 10) * 2)
        ),
        0,
        100
      ),
      reason: promotedForCombined34Support
        ? `${SEGMENT_RULE_VERSION}: Stable ${bestSlower.label} cluster survived combined-support filtering with weight ${bestSlower.weight.toFixed(2)}, weighted share ${(bestSlower.weightedShare * 100).toFixed(0)}%, support ${combined34Support.toFixed(2)}, ${bestSlower.directCount} direct slower segments, ${bestSlower.remappedCount} remapped under-read segments, full-track 3/4 score ${fullTrack34Score.toFixed(2)}, and base weight ${baseWeight.toFixed(2)}.`
        : `${SEGMENT_RULE_VERSION}: Stable ${bestSlower.label} cluster survived filtering with weight ${bestSlower.weight.toFixed(2)}, weighted share ${(bestSlower.weightedShare * 100).toFixed(0)}%, ${bestSlower.directCount} direct slower segments, and ${bestSlower.remappedCount} remapped under-read segments.`
    };
  }

  const failureReasons: string[] = [];
  if (!hasEnoughWeight) {
    failureReasons.push(`weight ${bestSlower.weight.toFixed(2)} < ${PROMOTION_MIN_WEIGHT}`);
  }
  if (!hasEnoughShare) {
    failureReasons.push(`weighted share ${(bestSlower.weightedShare * 100).toFixed(0)}% < ${(PROMOTION_MIN_WEIGHTED_SHARE * 100).toFixed(0)}%`);
  }
  if (!hasEnoughDirectSupport) {
    failureReasons.push(`direct slower segments ${bestSlower.directCount} < ${PROMOTION_MIN_DIRECT_COUNT}`);
  }
  if (!hasEnoughRemappedSupport) {
    failureReasons.push(`remapped under-read segments ${bestSlower.remappedCount} < ${PROMOTION_MIN_REMAPPED_COUNT}`);
  }
  if (!clearsBase) {
    failureReasons.push(`slower weight ${bestSlower.weight.toFixed(2)} did not clear base weight ${baseWeight.toFixed(2)} by ${PROMOTION_BASE_MARGIN}`);
  }

  return {
    action: 'keep-base',
    label: 'base',
    bpm: Math.round(baseBpm),
    confidence: clamp(
      Math.round((bestSlower.weightedShare * 35) + (bestSlower.averageScore * 20) + bestSlower.directCount),
      0,
      100
    ),
    reason: `${SEGMENT_RULE_VERSION}: Best slower cluster ${bestSlower.label}@${bestSlower.medianBpm} was filtered out: ${failureReasons.join('; ')}; combined34=${hasDominantCombined34Support ? 1 : 0}; combined34Support=${combined34Support.toFixed(2)}; full34=${fullTrack34Score.toFixed(2)}; combined=${combinedSupportCount}; baseWeight=${baseWeight.toFixed(2)}.`
  };
}

function findVote(votes: BpmPrototypeVoteSummary[], label: FamilyLabel): BpmPrototypeVoteSummary | null {
  return votes.find((vote) => vote.label === label) || null;
}

function findCandidateScore(evaluation: TempoCorrectionEvaluation | null, label: FamilyLabel): number {
  if (!evaluation) {
    return 0;
  }
  return evaluation.scored.find((candidate) => candidate.label === label)?.score ?? 0;
}

function findCandidateFoldedFamilyScore(evaluation: TempoCorrectionEvaluation | null, label: FamilyLabel): number {
  if (!evaluation) {
    return 0;
  }
  return evaluation.scored.find((candidate) => candidate.label === label)?.foldedFamilyScore ?? 0;
}

function buildSparseRecommendation(
  votes: BpmPrototypeVoteSummary[],
  baseBpm: number,
  fullTrackEvaluation: TempoCorrectionEvaluation | null
): BpmPrototypeRecommendation {
  const fallback = buildRecommendation(votes, baseBpm, fullTrackEvaluation);
  const vote34 = findVote(votes, '3/4');
  const vote45 = findVote(votes, '4/5');
  const baseVote = findVote(votes, 'base');
  const baseScore = fullTrackEvaluation?.baseCandidate.score ?? 1;
  const score34 = findCandidateScore(fullTrackEvaluation, '3/4');
  const score45 = findCandidateScore(fullTrackEvaluation, '4/5');
  const folded34 = findCandidateFoldedFamilyScore(fullTrackEvaluation, '3/4');
  const folded45 = findCandidateFoldedFamilyScore(fullTrackEvaluation, '4/5');
  const rhythmBpm = fullTrackEvaluation?.rhythm.bpm ?? 0;
  const weakFullBase = baseScore <= SPARSE_FALSE_160_BASE_SCORE_MAX;
  const noMeaningfulBase = !baseVote || baseVote.weight < 0.9;
  const direct120Dominance = Boolean(
    vote34
    && vote34.weight >= SPARSE_PROMOTION_MIN_WEIGHT
    && vote34.weightedShare >= 0.65
    && vote34.directCount >= 3
    && vote34.weight > ((vote45?.weight ?? 0) + 0.35)
  );
  const weakBaseMixedSlow = Boolean(
    vote34
    && weakFullBase
    && noMeaningfulBase
    && score34 >= SPARSE_FALSE_160_MIXED_SCORE_MIN
    && score45 >= 0.58
    && vote34.directCount >= 1
  );
  const halfTimeRecovery = Boolean(
    vote34
    && rhythmBpm > 0
    && rhythmBpm <= (baseBpm * 0.56)
    && noMeaningfulBase
    && vote34.remappedCount >= SPARSE_PROMOTION_MIN_REMAPPED_COUNT
    && vote34.weightedShare >= SPARSE_PROMOTION_MIN_WEIGHTED_SHARE
  );
  const remappedRecovery = Boolean(
    vote34
    && vote34.weight >= SPARSE_PROMOTION_MIN_WEIGHT
    && vote34.weightedShare >= SPARSE_PROMOTION_MIN_WEIGHTED_SHARE
    && vote34.directCount >= SPARSE_PROMOTION_MIN_DIRECT_COUNT
    && vote34.remappedCount >= SPARSE_PROMOTION_MIN_REMAPPED_COUNT
    && (weakFullBase || score34 >= score45)
  );
  const splitLeakyFalse160Recovery = Boolean(
    vote34
    && vote45
    && weakFullBase
    && noMeaningfulBase
    && baseBpm >= SPARSE_SPLIT_LEAKY_FALSE_160_BASE_BPM_MIN
    && baseBpm <= SPARSE_SPLIT_LEAKY_FALSE_160_BASE_BPM_MAX
    && score34 <= SPARSE_SPLIT_LEAKY_FALSE_160_SCORE_MAX
    && score45 <= SPARSE_SPLIT_LEAKY_FALSE_160_SCORE_MAX
    && folded34 >= SPARSE_SPLIT_LEAKY_FALSE_160_FOLDED_34_MIN
    && folded45 >= SPARSE_SPLIT_LEAKY_FALSE_160_FOLDED_45_MIN
    && vote34.weight >= SPARSE_SPLIT_LEAKY_FALSE_160_MIN_WEIGHT
    && vote45.weight >= SPARSE_SPLIT_LEAKY_FALSE_160_MIN_WEIGHT
    && vote34.directCount >= SPARSE_SPLIT_LEAKY_FALSE_160_MIN_DIRECT_COUNT
    && vote45.directCount >= SPARSE_SPLIT_LEAKY_FALSE_160_MIN_DIRECT_COUNT
    && Math.abs(vote34.weight - vote45.weight) <= SPARSE_SPLIT_LEAKY_FALSE_160_MAX_WEIGHT_GAP
    && vote34.medianBpm <= Math.round(baseBpm * 0.76)
    && vote45.medianBpm <= Math.round(baseBpm * 0.81)
  );

  if (remappedRecovery || direct120Dominance || weakBaseMixedSlow || halfTimeRecovery || splitLeakyFalse160Recovery) {
    const reasons: string[] = [];
    if (remappedRecovery) {
      reasons.push(`${vote34?.remappedCount ?? 0} remapped under-read windows`);
    }
    if (direct120Dominance) {
      reasons.push(`${vote34?.directCount ?? 0} direct 3/4 windows dominated sparse scan`);
    }
    if (weakBaseMixedSlow) {
      reasons.push(`full-track base score ${round2(baseScore)} stayed weak while sparse windows still hit 3/4`);
    }
    if (halfTimeRecovery) {
      reasons.push(`rhythm collapsed to ${Math.round(rhythmBpm)} BPM with remapped 3/4 support`);
    }
    if (splitLeakyFalse160Recovery) {
      reasons.push(
        `full-track aligned family scores stayed near zero while sparse 3/4@${vote34?.medianBpm ?? '-'} and 4/5@${vote45?.medianBpm ?? '-'} windows remained nearly tied`
      );
    }

    return {
      action: 'promote-slower',
      label: '3/4',
      bpm: resolveFamilyLabelBpm(baseBpm, '3/4', vote34?.medianBpm ?? (baseBpm * 0.75)),
      confidence: clamp(
        Math.round(
          (((vote34?.weightedShare ?? 0) * 45)
          + ((vote34?.averageScore ?? 0) * 20)
          + ((vote34?.directCount ?? 0) * 4)
          + ((vote34?.remappedCount ?? 0) * 6))
        ),
        0,
        100
      ),
      reason: `Sparse false-160 detector promoted 3/4 because ${reasons.join('; ')}.`
    };
  }

  return fallback;
}

export async function analyzeTempoBySegments(
  audioBuffer: AudioBuffer,
  fullTrackBase?: EssentiaTempoResult,
  options?: {
    maxDurationSec?: number;
    earlyExit?: boolean;
    maxWindows?: number;
    fullTrackEvaluation?: TempoCorrectionEvaluation | null;
  }
): Promise<BpmPrototypeAnalysisResult> {
  const segments: BpmPrototypeSegmentResult[] = [];
  const durationSec = Math.min(audioBuffer.duration, options?.maxDurationSec ?? MAX_RUNTIME_SEGMENT_ANALYSIS_SECONDS);
  const resolvedFullTrackBase = fullTrackBase ?? await estimateTempo(audioBuffer, PROTOTYPE_TEMPO_OPTIONS);
  const familyTargets = buildFamilyTargets(resolvedFullTrackBase.bpm);
  const windowStarts = buildWindowStarts(audioBuffer, durationSec, options?.maxWindows ?? DEFAULT_MAX_WINDOWS);
  const totalPlannedSegments = windowStarts.length;

  for (let index = 0; index < windowStarts.length; index += 1) {
    const startSeconds = windowStarts[index] ?? 0;
    const endSeconds = Math.min(durationSec, startSeconds + SEGMENT_LENGTH_SEC);
    if (endSeconds - startSeconds < MIN_SEGMENT_LENGTH_SEC) {
      continue;
    }

    const segmentBuffer = createSlicedAudioBuffer(audioBuffer, startSeconds, endSeconds);
    const baseTempo = await estimateTempo(segmentBuffer, PROTOTYPE_TEMPO_OPTIONS);
    const evaluation = await evaluateTempoCorrectionCandidates(segmentBuffer, baseTempo);
    const candidates = evaluation?.scored.map((candidate) => ({
      bpm: candidate.bpm,
      label: candidate.label,
      score: roundScore(candidate.score)
    })) ?? [
      {
        bpm: baseTempo.bpm,
        label: 'base',
        score: 1
      }
    ];
    const winningCandidate = chooseWinningCandidate(candidates, baseTempo.bpm);
    const baseCandidate = candidates.find((candidate) => candidate.label === 'base') || {
      bpm: baseTempo.bpm,
      label: 'base',
      score: 1
    };
    const roundedWinningScore = round2(winningCandidate.score);
    const roundedBaseScore = round2(baseCandidate.score);
    const directSupport = classifyStableSupport(
      {
        winningLabel: winningCandidate.label,
        winningBpm: winningCandidate.bpm,
        winningScore: roundedWinningScore,
        baseScore: roundedBaseScore
      },
      familyTargets
    );
    const underreadSupport = detectUnderreadSupport(evaluation?.rhythm, familyTargets);
    const stableSupport = underreadSupport ?? directSupport;

    segments.push({
      index,
      startSeconds: round2(startSeconds),
      endSeconds: round2(endSeconds),
      baseBpm: baseTempo.bpm,
      currentBpm: winningCandidate.bpm,
      winningLabel: winningCandidate.label,
      winningBpm: winningCandidate.bpm,
      winningScore: roundedWinningScore,
      baseScore: roundedBaseScore,
      stableLabel: stableSupport?.label ?? null,
      stableBpm: stableSupport ? Math.round(stableSupport.bpm) : null,
      reliability: stableSupport?.reliability ?? 0,
      supportType: detectSupportType(
        {
          winningLabel: winningCandidate.label,
          winningScore: roundedWinningScore,
          baseScore: roundedBaseScore
        },
        stableSupport
      ),
      candidates: candidates.map((candidate) => ({
        bpm: candidate.bpm,
        label: candidate.label,
        score: round2(candidate.score)
      }))
    });

    if (options?.earlyExit) {
      const groupedVotes = clusterSupportsByFamily(segments);
      const stableSegments = Array.from(groupedVotes.values()).reduce((sum, entry) => sum + entry.supports.length, 0);
      const votes = buildVoteSummary(groupedVotes, stableSegments);
      const leadingSlower = votes.find((vote) => vote.label !== 'base') || null;
      const baseVote = votes.find((vote) => vote.label === 'base') || null;
      const remainingSegments = Math.max(0, totalPlannedSegments - (index + 1));

      if (leadingSlower) {
        if (leadingSlower.remappedCount >= PROMOTION_MIN_REMAPPED_COUNT && leadingSlower.weightedShare >= 0.6) {
          break;
        }

        const maxFutureWeight = remainingSegments * 0.85;
        const currentLead = leadingSlower.weight - (baseVote?.weight || 0);
        if (
          leadingSlower.remappedCount === 0
          && currentLead + maxFutureWeight < PROMOTION_BASE_MARGIN
        ) {
          break;
        }
      }
    }
  }

  const groupedVotes = clusterSupportsByFamily(segments);
  const stableSegments = Array.from(groupedVotes.values()).reduce((sum, entry) => sum + entry.supports.length, 0);
  const votes = buildVoteSummary(groupedVotes, stableSegments);
  const fullTrackEvaluation = options?.fullTrackEvaluation
    ?? await evaluateTempoCorrectionCandidates(audioBuffer, resolvedFullTrackBase);
  const recommendation = buildRecommendation(votes, resolvedFullTrackBase.bpm, fullTrackEvaluation);

  return {
    method: 'segment-vote-v2',
    segmentLengthSec: SEGMENT_LENGTH_SEC,
    hopLengthSec: HOP_LENGTH_SEC,
    segmentsAnalyzed: segments.length,
    stableSegments,
    votes,
    recommendation,
    segments
  };
}

export async function analyzeTempoBySparseWindows(
  audioBuffer: AudioBuffer,
  fullTrackBase?: EssentiaTempoResult,
  options?: {
    maxDurationSec?: number;
    maxWindows?: number;
    fullTrackEvaluation?: TempoCorrectionEvaluation | null;
  }
): Promise<BpmPrototypeAnalysisResult> {
  const segments: BpmPrototypeSegmentResult[] = [];
  const durationSec = Math.min(audioBuffer.duration, options?.maxDurationSec ?? MAX_RUNTIME_SEGMENT_ANALYSIS_SECONDS);
  const resolvedFullTrackBase = fullTrackBase ?? await estimateTempo(audioBuffer, PROTOTYPE_TEMPO_OPTIONS);
  const familyTargets = buildFamilyTargets(resolvedFullTrackBase.bpm);
  const windowStarts = buildWindowStarts(audioBuffer, durationSec, options?.maxWindows ?? DEFAULT_SPARSE_MAX_WINDOWS);
  const fullTrackEvaluation = options?.fullTrackEvaluation
    ?? await evaluateTempoCorrectionCandidates(audioBuffer, resolvedFullTrackBase);

  for (let index = 0; index < windowStarts.length; index += 1) {
    const startSeconds = windowStarts[index] ?? 0;
    const endSeconds = Math.min(durationSec, startSeconds + SEGMENT_LENGTH_SEC);
    if (endSeconds - startSeconds < MIN_SEGMENT_LENGTH_SEC) {
      continue;
    }

    const segmentBuffer = createSlicedAudioBuffer(audioBuffer, startSeconds, endSeconds);
    const evaluation = await evaluateTempoCorrectionCandidates(segmentBuffer, resolvedFullTrackBase);
    const candidates = evaluation?.scored.map((candidate) => ({
      bpm: candidate.bpm,
      label: candidate.label,
      score: roundScore(candidate.score)
    })) ?? [
      {
        bpm: resolvedFullTrackBase.bpm,
        label: 'base',
        score: 1
      }
    ];
    const winningCandidate = chooseWinningCandidate(candidates, resolvedFullTrackBase.bpm);
    const baseCandidate = candidates.find((candidate) => candidate.label === 'base') || {
      bpm: resolvedFullTrackBase.bpm,
      label: 'base',
      score: 1
    };
    const roundedWinningScore = round2(winningCandidate.score);
    const roundedBaseScore = round2(baseCandidate.score);
    const directSupport = classifyStableSupport(
      {
        winningLabel: winningCandidate.label,
        winningBpm: winningCandidate.bpm,
        winningScore: roundedWinningScore,
        baseScore: roundedBaseScore
      },
      familyTargets
    );
    const underreadSupport = detectUnderreadSupport(
      evaluation?.rhythm,
      familyTargets,
      {
        toleranceRatio: 0.08,
        minimumReliability: 0.56,
        minimumEstimateMatch: 0.24
      }
    );
    const stableSupport = underreadSupport ?? directSupport;

    segments.push({
      index,
      startSeconds: round2(startSeconds),
      endSeconds: round2(endSeconds),
      baseBpm: resolvedFullTrackBase.bpm,
      currentBpm: winningCandidate.bpm,
      winningLabel: winningCandidate.label,
      winningBpm: winningCandidate.bpm,
      winningScore: roundedWinningScore,
      baseScore: roundedBaseScore,
      stableLabel: stableSupport?.label ?? null,
      stableBpm: stableSupport ? Math.round(stableSupport.bpm) : null,
      reliability: stableSupport?.reliability ?? 0,
      supportType: detectSupportType(
        {
          winningLabel: winningCandidate.label,
          winningScore: roundedWinningScore,
          baseScore: roundedBaseScore
        },
        stableSupport
      ),
      candidates: candidates.map((candidate) => ({
        bpm: candidate.bpm,
        label: candidate.label,
        score: round2(candidate.score)
      }))
    });
  }

  const groupedVotes = clusterSupportsByFamily(segments);
  const stableSegments = Array.from(groupedVotes.values()).reduce((sum, entry) => sum + entry.supports.length, 0);
  const votes = buildVoteSummary(groupedVotes, stableSegments);
  const recommendation = buildSparseRecommendation(votes, resolvedFullTrackBase.bpm, fullTrackEvaluation);

  return {
    method: 'sparse-window-v2',
    segmentLengthSec: SEGMENT_LENGTH_SEC,
    hopLengthSec: HOP_LENGTH_SEC,
    segmentsAnalyzed: segments.length,
    stableSegments,
    votes,
    recommendation,
    segments
  };
}
