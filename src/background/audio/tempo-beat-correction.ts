import { analyzeTempoBySegments, analyzeTempoBySparseWindows } from '@/background/audio/tempo-segment-prototype';
import {
  clamp01,
  evaluateTempoCorrectionCandidates,
  roundScore,
  selectPreferredCorrectionAlternative,
  type CandidateScore,
  type CorrectionMode,
  type SupportSignal
} from '@/background/audio/tempo-correction-support';
import { classifyBeatType, type EssentiaTempoResult, type RhythmEvidenceResult } from '@/background/audio/tempo';

const LOW_CORRECTION_RHYTHM_MIN_BPM = 112;
const LOW_CORRECTION_RHYTHM_MAX_BPM = 130;
const LOW_FAMILY_ALIGNMENT_MAX_BPM_DELTA = 4;
// 131 intentionally bridges the old 130/132 gap for under-read tracks that
// consistently land near 87 with strong rhythm evidence around 131.
const MID_UNDERREAD_RHYTHM_MIN_BPM = 131;
const MID_UNDERREAD_RHYTHM_MAX_BPM = 145;
const MID_DRIFT_MIN_DELTA_BPM = 3;
const MID_DRIFT_MAX_DELTA_BPM = 6;
const HIGH_SEGMENT_GATE_MIN_ALT_SCORE = 0.52;
const HIGH_SEGMENT_GATE_MIN_FAMILY_SCORE = 0.72;
const HIGH_SEGMENT_GATE_MIN_ESTIMATE_SCORE = 0.5;
const HIGH_SPARSE_GATE_MAX_BASE_SCORE = 0.35;
const HIGH_SPARSE_GATE_MAX_ALIGNED_FAMILY_SCORE = 0.12;
const HIGH_SPARSE_GATE_MIN_FOLDED_FAMILY_SCORE = 0.75;
const HIGH_SPARSE_GATE_MIN_34_FOLDED_FAMILY_SCORE = 0.65;

export interface TempoBeatCorrectionResult {
  bpm: number;
  beatTypeAuto: ReturnType<typeof classifyBeatType>;
  summary: string;
  gateDebug: string;
  decisionConfidence: number;
  candidates: Array<{ bpm: number; label: string; score: number }>;
  deferredSegmentAnalysis?: boolean;
}

function isHighCorrectionMode(mode: CorrectionMode): boolean {
  return mode === 'high-overshoot' || mode === 'high-overread-nonclassic';
}

function summarizeReason(candidate: CandidateScore): string {
  const top = candidate.supportSignals.slice(0, 2);
  if (top.length) {
    return top.join('+');
  }
  return 'keep-base';
}

function formatSupportSignals(candidate: CandidateScore): string {
  return candidate.supportSignals.length ? candidate.supportSignals.join('+') : '-';
}

function formatGateDebug(params: {
  mode: CorrectionMode;
  baseTempo: EssentiaTempoResult;
  rhythm: RhythmEvidenceResult;
  baseCandidate: CandidateScore;
  alternative: CandidateScore;
  targetRhythmInBand: boolean;
  minimumScore: number;
  requiredMargin: number;
  minimumTickLead: number;
  requireTickLead: boolean;
  supportCount: number;
  applyCorrection: boolean;
  decisionConfidence: number;
}): string {
  const {
    mode,
    baseTempo,
    rhythm,
    baseCandidate,
    alternative,
    targetRhythmInBand,
    minimumScore,
    requiredMargin,
    minimumTickLead,
    requireTickLead,
    supportCount,
    applyCorrection,
    decisionConfidence
  } = params;

  const passScore = alternative.score >= minimumScore;
  const passSupport = alternative.supportSignals.length >= supportCount;
  const passMargin = alternative.score - baseCandidate.score >= requiredMargin;
  const passTick = !requireTickLead || alternative.tickScore >= baseCandidate.tickScore + minimumTickLead;
  const passDifferent = alternative.bpm !== baseCandidate.bpm;
  const passTargetBand = isHighCorrectionMode(mode) ? true : targetRhythmInBand;

  return [
    `mode=${mode}`,
    `base=${baseTempo.bpm}`,
    `rhythm=${Math.round(rhythm.bpm)}`,
    `alt=${alternative.label}:${alternative.bpm}`,
    `altScore=${roundScore(alternative.score)}`,
    `baseScore=${roundScore(baseCandidate.score)}`,
    `altTick=${roundScore(alternative.tickScore)}`,
    `baseTick=${roundScore(baseCandidate.tickScore)}`,
    `altFamily=${roundScore(alternative.familyScore)}`,
    `altFolded=${roundScore(alternative.foldedFamilyScore)}`,
    `altSupport=${formatSupportSignals(alternative)}`,
    `flags=score:${passScore ? 1 : 0}|support:${passSupport ? 1 : 0}|margin:${passMargin ? 1 : 0}|tick:${passTick ? 1 : 0}|targetBand:${passTargetBand ? 1 : 0}|different:${passDifferent ? 1 : 0}`,
    `thresholds=minScore:${roundScore(minimumScore)}|margin:${roundScore(requiredMargin)}|tickLead:${requireTickLead ? roundScore(minimumTickLead) : 'off'}|support:${supportCount}`,
    `decision=${Math.round(decisionConfidence)}`,
    `apply=${applyCorrection ? 1 : 0}`
  ].join(' ');
}

function formatSegmentGateDebug(segmentAnalysis: Awaited<ReturnType<typeof analyzeTempoBySegments>>): string {
  const topVotes = segmentAnalysis.votes
    .slice(0, 3)
    .map((vote) => {
      const weightedShare = Math.round(vote.weightedShare * 100);
      return `${vote.label}:${vote.count}@${vote.medianBpm}:w=${vote.weight.toFixed(2)}:s=${weightedShare}%:d=${vote.directCount}:r=${vote.remappedCount}`;
    })
    .join(',');

  return [
    `segmentMethod=${segmentAnalysis.method}`,
    `segmentStable=${segmentAnalysis.stableSegments}/${segmentAnalysis.segmentsAnalyzed}`,
    `segmentVotes=${topVotes || '-'}`,
    `segmentAction=${segmentAnalysis.recommendation.action}`,
    `segmentLabel=${segmentAnalysis.recommendation.label}`,
    `segmentBpm=${segmentAnalysis.recommendation.bpm}`,
    `segmentConfidence=${segmentAnalysis.recommendation.confidence}`
  ].join(' ');
}

function formatHighCandidateScores(scored: CandidateScore[]): string {
  return ['base', '3/4', '4/5']
    .map((label) => {
      const candidate = scored.find((entry) => entry.label === label);
      if (!candidate) {
        return `${label}:-`;
      }
      return [
        `${label}:${roundScore(candidate.score)}`,
        `tick=${roundScore(candidate.tickScore)}`,
        `fam=${roundScore(candidate.familyScore)}`,
        `fold=${roundScore(candidate.foldedFamilyScore)}`,
        `est=${roundScore(candidate.estimateScore)}`,
        `int=${roundScore(candidate.intervalScore)}`
      ].join(':');
    })
    .join(',');
}

function formatHighFamilyReferences(scored: CandidateScore[]): string {
  return ['base', '3/4', '4/5']
    .map((label) => {
      const candidate = scored.find((entry) => entry.label === label);
      if (!candidate || !candidate.foldedFamilyTopMatches.length) {
        return `${label}:-`;
      }

      const references = candidate.foldedFamilyTopMatches
        .map((match) => `${match.ratio}@${roundScore(match.bpm)}[${match.source}]=${roundScore(match.score)}`)
        .join('&');
      return `${label}:${references}`;
    })
    .join(',');
}

function formatHighAlignedFamilyReferences(scored: CandidateScore[]): string {
  return ['base', '3/4', '4/5']
    .map((label) => {
      const candidate = scored.find((entry) => entry.label === label);
      if (!candidate || !candidate.familyTopMatches.length) {
        return `${label}:-`;
      }

      const references = candidate.familyTopMatches
        .map((match) => `${match.ratio}@${roundScore(match.bpm)}[${match.source}]=${roundScore(match.score)}`)
        .join('&');
      return `${label}:${references}`;
    })
    .join(',');
}

function getLowCandidateLabels(mode: CorrectionMode): string[] {
  if (mode === 'low-ambiguous') {
    return ['base', '5/4', 'rhythm'];
  }
  if (mode === 'mid-underread') {
    return ['base', '3/2', 'rhythm'];
  }
  return ['base', 'rhythm'];
}

function formatLowCandidateScores(scored: CandidateScore[], mode: CorrectionMode): string {
  return getLowCandidateLabels(mode)
    .map((label) => {
      const candidate = scored.find((entry) => entry.label === label);
      if (!candidate) {
        return `${label}:-`;
      }
      return [
        `${label}:${roundScore(candidate.score)}`,
        `tick=${roundScore(candidate.tickScore)}`,
        `fam=${roundScore(candidate.familyScore)}`,
        `fold=${roundScore(candidate.foldedFamilyScore)}`,
        `est=${roundScore(candidate.estimateScore)}`,
        `int=${roundScore(candidate.intervalScore)}`,
        `support=${formatSupportSignals(candidate)}`
      ].join(':');
    })
    .join(',');
}

function formatLowFamilyReferences(scored: CandidateScore[], mode: CorrectionMode): string {
  return getLowCandidateLabels(mode)
    .map((label) => {
      const candidate = scored.find((entry) => entry.label === label);
      if (!candidate || !candidate.foldedFamilyTopMatches.length) {
        return `${label}:-`;
      }

      const references = candidate.foldedFamilyTopMatches
        .map((match) => `${match.ratio}@${roundScore(match.bpm)}[${match.source}]=${roundScore(match.score)}`)
        .join('&');
      return `${label}:${references}`;
    })
    .join(',');
}

function formatHighSegmentRejectReason(segmentAnalysis: Awaited<ReturnType<typeof analyzeTempoBySegments>> | null): string {
  if (!segmentAnalysis) {
    return 'not-run';
  }

  return [
    `action=${segmentAnalysis.recommendation.action}`,
    `label=${segmentAnalysis.recommendation.label}`,
    `bpm=${segmentAnalysis.recommendation.bpm}`,
    `confidence=${segmentAnalysis.recommendation.confidence}`,
    `reason=${segmentAnalysis.recommendation.reason || '-'}`
  ].join(':');
}

function formatSparseGateDebug(sparseAnalysis: Awaited<ReturnType<typeof analyzeTempoBySparseWindows>>): string {
  const topVotes = sparseAnalysis.votes
    .slice(0, 3)
    .map((vote) => {
      const weightedShare = Math.round(vote.weightedShare * 100);
      return `${vote.label}:${vote.count}@${vote.medianBpm}:w=${vote.weight.toFixed(2)}:s=${weightedShare}%:d=${vote.directCount}:r=${vote.remappedCount}`;
    })
    .join(',');

  return [
    `sparseMethod=${sparseAnalysis.method}`,
    `sparseStable=${sparseAnalysis.stableSegments}/${sparseAnalysis.segmentsAnalyzed}`,
    `sparseVotes=${topVotes || '-'}`,
    `sparseAction=${sparseAnalysis.recommendation.action}`,
    `sparseLabel=${sparseAnalysis.recommendation.label}`,
    `sparseBpm=${sparseAnalysis.recommendation.bpm}`,
    `sparseConfidence=${sparseAnalysis.recommendation.confidence}`
  ].join(' ');
}

function computeDecisionConfidence(params: {
  mode: CorrectionMode;
  selected: CandidateScore;
  applyCorrection: boolean;
  targetRhythmInBand: boolean;
}): number {
  const { mode, selected, applyCorrection, targetRhythmInBand } = params;
  const supportBonus = Math.max(0, Math.min(2, selected.supportSignals.length - 1)) * 15;

  if (isHighCorrectionMode(mode)) {
    return Math.max(
      0,
      Math.min(
        100,
        Math.round(
          (clamp01(selected.score) * 35)
          + supportBonus
          + (selected.familyScore >= 0.72 ? 10 : 0)
          + (applyCorrection ? 10 : 0)
        )
      )
    );
  }

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (clamp01(selected.score) * 45)
        + supportBonus
        + (targetRhythmInBand ? 10 : 0)
        + (applyCorrection ? 10 : 0)
      )
    )
  );
}

export async function correctTempoByBeatEvidence(
  audioBuffer: AudioBuffer,
  baseTempo: EssentiaTempoResult,
  options?: {
    deferSegmentAnalysis?: boolean;
  }
): Promise<TempoBeatCorrectionResult | null> {
  const evaluation = await evaluateTempoCorrectionCandidates(audioBuffer, baseTempo);
  if (!evaluation) {
    return null;
  }

  const { mode, rhythm, scored, baseCandidate, alternativeCandidates } = evaluation;
  const bestAlternative = alternativeCandidates[0] ?? null;
  if (!bestAlternative) {
    return null;
  }

  const highMode = isHighCorrectionMode(mode);
  const lowMode = mode === 'low-ambiguous';
  const midUnderreadMode = mode === 'mid-underread';
  const midDriftMode = mode === 'mid-drift';
  const roundedRhythmBpm = Math.round(rhythm.bpm);
  const lowRhythmInTargetBand =
    roundedRhythmBpm >= LOW_CORRECTION_RHYTHM_MIN_BPM && roundedRhythmBpm <= LOW_CORRECTION_RHYTHM_MAX_BPM;
  const midUnderreadRhythmInTargetBand =
    roundedRhythmBpm >= MID_UNDERREAD_RHYTHM_MIN_BPM && roundedRhythmBpm <= MID_UNDERREAD_RHYTHM_MAX_BPM;
  const targetRhythmInBand = lowMode
    ? (lowRhythmInTargetBand || midUnderreadRhythmInTargetBand)
    : midUnderreadMode
      ? midUnderreadRhythmInTargetBand
      : midDriftMode
        ? true
      : true;
  const requiredMargin = highMode
    ? (rhythm.confidence >= 55 ? 0.18 : 0.22)
    : midUnderreadMode
      ? 0.18
      : midDriftMode
        ? 0.12
      : (rhythm.confidence >= 35 ? 0.14 : 0.18);
  const minimumScore = highMode ? 0.72 : midUnderreadMode ? 0.7 : midDriftMode ? 0.74 : 0.62;
  const minimumTickLead = highMode ? 0.04 : midUnderreadMode ? 0 : midDriftMode ? 0 : 0.02;
  const requireTickLead = highMode || lowMode;
  const supportCount = 2;
  const structuredLowCandidate = lowMode
    ? alternativeCandidates.find((candidate) => candidate.label !== 'rhythm') ?? null
    : null;
  const rhythmCandidate = alternativeCandidates.find((candidate) => candidate.label === 'rhythm') ?? bestAlternative;
  const lowPreferredAlternative = selectPreferredCorrectionAlternative(evaluation) ?? rhythmCandidate;
  const preferredAlternative = (midUnderreadMode || lowMode)
    ? lowPreferredAlternative
    : bestAlternative;
  const passTickLead = !requireTickLead || preferredAlternative.tickScore >= baseCandidate.tickScore + minimumTickLead;
  const passMidUnderreadDirectEvidence =
    !midUnderreadMode
    || (
      preferredAlternative.label === 'rhythm'
      && (
        preferredAlternative.intervalScore >= 0.68
        || preferredAlternative.estimateScore >= 0.6
      )
    );
  const classicLowIntervalPromotion = (
    lowRhythmInTargetBand
    && preferredAlternative.label !== 'rhythm'
    && preferredAlternative.score >= minimumScore
    && preferredAlternative.supportSignals.length >= supportCount
    && preferredAlternative.score - baseCandidate.score >= requiredMargin
    && preferredAlternative.tickScore >= baseCandidate.tickScore + minimumTickLead
    && preferredAlternative.bpm !== baseCandidate.bpm
  );
  const classicLowPromotion = classicLowIntervalPromotion;
  const guardedLowFamilyPromotion = (
    lowMode
    && lowRhythmInTargetBand
    && preferredAlternative.label === 'rhythm'
    && structuredLowCandidate?.label === '5/4'
    && Math.abs(preferredAlternative.bpm - structuredLowCandidate.bpm) <= LOW_FAMILY_ALIGNMENT_MAX_BPM_DELTA
    && preferredAlternative.score >= 0.62
    && preferredAlternative.supportSignals.length >= supportCount
    && preferredAlternative.score - baseCandidate.score >= 0.08
    && preferredAlternative.rhythmScore >= 0.8
    && preferredAlternative.intervalScore >= 0.68
    && preferredAlternative.bpm !== baseCandidate.bpm
  );
  const guardedMidUnderreadPromotion = (
    lowMode
    && midUnderreadRhythmInTargetBand
    && preferredAlternative.label === 'rhythm'
    && preferredAlternative.bpm !== baseCandidate.bpm
    && preferredAlternative.score >= 0.58
    && preferredAlternative.score - baseCandidate.score >= 0.08
    && preferredAlternative.rhythmScore >= 0.8
    && preferredAlternative.intervalScore >= 0.72
  );
  const guardedMidDriftPromotion = (
    midDriftMode
    && preferredAlternative.label === 'rhythm'
    && Math.abs(preferredAlternative.bpm - baseCandidate.bpm) >= MID_DRIFT_MIN_DELTA_BPM
    && Math.abs(preferredAlternative.bpm - baseCandidate.bpm) <= MID_DRIFT_MAX_DELTA_BPM
    && preferredAlternative.score >= minimumScore
    && preferredAlternative.supportSignals.length >= supportCount
    && preferredAlternative.score - baseCandidate.score >= requiredMargin
    && preferredAlternative.intervalScore >= 0.72
    && preferredAlternative.estimateScore >= 0.55
    && preferredAlternative.tickScore >= baseCandidate.tickScore - 0.03
    && preferredAlternative.bpm !== baseCandidate.bpm
  );

  const oneShotApplyCorrection = highMode
    ? (
      preferredAlternative.score >= minimumScore
      && preferredAlternative.supportSignals.length >= supportCount
      && preferredAlternative.score - baseCandidate.score >= requiredMargin
      && passTickLead
      && preferredAlternative.bpm !== baseCandidate.bpm
    )
    : lowMode
      ? (classicLowPromotion || guardedLowFamilyPromotion || guardedMidUnderreadPromotion)
      : midDriftMode
        ? guardedMidDriftPromotion
      : (
        midUnderreadRhythmInTargetBand
        && preferredAlternative.score >= minimumScore
        && preferredAlternative.supportSignals.length >= supportCount
        && preferredAlternative.score - baseCandidate.score >= requiredMargin
        && passMidUnderreadDirectEvidence
        && preferredAlternative.bpm !== baseCandidate.bpm
      );

  if (highMode) {
    const vote34 = scored.find((candidate) => candidate.label === '3/4') ?? null;
    const shouldRunSegmentAnalysis = (
      preferredAlternative.score >= HIGH_SEGMENT_GATE_MIN_ALT_SCORE
      && (
        preferredAlternative.familyScore >= HIGH_SEGMENT_GATE_MIN_FAMILY_SCORE
        || preferredAlternative.estimateScore >= HIGH_SEGMENT_GATE_MIN_ESTIMATE_SCORE
      )
    );
    const shouldRunSparseFallback = (
      !shouldRunSegmentAnalysis
      && baseCandidate.score <= HIGH_SPARSE_GATE_MAX_BASE_SCORE
      && preferredAlternative.familyScore <= HIGH_SPARSE_GATE_MAX_ALIGNED_FAMILY_SCORE
      && preferredAlternative.foldedFamilyScore >= HIGH_SPARSE_GATE_MIN_FOLDED_FAMILY_SCORE
      && (vote34?.foldedFamilyScore ?? 0) >= HIGH_SPARSE_GATE_MIN_34_FOLDED_FAMILY_SCORE
    );
    if (shouldRunSegmentAnalysis && options?.deferSegmentAnalysis) {
      const gateDebug = [
        formatGateDebug({
          mode,
          baseTempo,
          rhythm,
          baseCandidate,
          alternative: preferredAlternative,
          targetRhythmInBand,
          minimumScore,
          requiredMargin,
          minimumTickLead,
          requireTickLead,
          supportCount,
          decisionConfidence: computeDecisionConfidence({
            mode,
            selected: baseCandidate,
            applyCorrection: false,
            targetRhythmInBand
          }),
          applyCorrection: oneShotApplyCorrection
        }),
        `highScores=${formatHighCandidateScores(scored)}`,
        `highFamilyRefs=${formatHighFamilyReferences(scored)}`,
        `highAlignedFamilyRefs=${formatHighAlignedFamilyReferences(scored)}`,
        'segmentGate=1',
        `sparseGate=${shouldRunSparseFallback ? 1 : 0}`,
        'segmentDeferred=1'
      ].join(' | ');

      return {
        bpm: baseTempo.bpm,
        beatTypeAuto: classifyBeatType(baseTempo.bpm),
        summary: `tempo-segment-correction base=${baseTempo.bpm} rhythm=${Math.round(rhythm.bpm)} final=${baseTempo.bpm} label=base reason=deferred-segment-v2 method=${baseTempo.method}`,
        gateDebug,
        decisionConfidence: computeDecisionConfidence({
          mode,
          selected: baseCandidate,
          applyCorrection: false,
          targetRhythmInBand
        }),
        candidates: scored.map((candidate) => ({
          bpm: candidate.bpm,
          label: candidate.label,
          score: roundScore(candidate.score)
        })),
        deferredSegmentAnalysis: true
      };
    }
    const segmentAnalysis = shouldRunSegmentAnalysis
      ? await analyzeTempoBySegments(audioBuffer, baseTempo, {
        maxDurationSec: 72,
        earlyExit: true,
        maxWindows: 4,
        fullTrackEvaluation: evaluation
      })
      : null;
    const sparseAnalysis = shouldRunSparseFallback
      ? await analyzeTempoBySparseWindows(audioBuffer, baseTempo, {
        maxDurationSec: 72,
        maxWindows: 6,
        fullTrackEvaluation: evaluation
      })
      : null;
    const applySegmentCorrection = segmentAnalysis?.recommendation.action === 'promote-slower';
    const applySparseCorrection = !applySegmentCorrection && sparseAnalysis?.recommendation.action === 'promote-slower';
    const finalBpm = applySegmentCorrection
      ? Number(segmentAnalysis?.recommendation.bpm)
      : applySparseCorrection
        ? Number(sparseAnalysis?.recommendation.bpm)
        : baseTempo.bpm;
    const finalLabel = applySegmentCorrection
      ? segmentAnalysis?.recommendation.label
      : applySparseCorrection
        ? sparseAnalysis?.recommendation.label
        : 'base';
    const finalReason = applySegmentCorrection
      ? 'segment-v2'
      : applySparseCorrection
        ? 'sparse-window-v2'
        : 'keep-base';
    const summary = (applySegmentCorrection || applySparseCorrection)
      ? `tempo-segment-correction base=${baseTempo.bpm} rhythm=${Math.round(rhythm.bpm)} final=${finalBpm} label=${finalLabel} reason=${finalReason} method=${baseTempo.method}`
      : `tempo-segment-correction base=${baseTempo.bpm} rhythm=${Math.round(rhythm.bpm)} final=${baseTempo.bpm} label=base reason=keep-base method=${baseTempo.method}`;
    const gateParts = [
      formatGateDebug({
        mode,
        baseTempo,
        rhythm,
        baseCandidate,
        alternative: preferredAlternative,
        targetRhythmInBand,
        minimumScore,
        requiredMargin,
        minimumTickLead,
        requireTickLead,
        supportCount,
        decisionConfidence: segmentAnalysis?.recommendation.confidence ?? computeDecisionConfidence({
          mode,
          selected: baseCandidate,
          applyCorrection: false,
          targetRhythmInBand
        }),
        applyCorrection: oneShotApplyCorrection
      })
    ];
    gateParts.push(`highScores=${formatHighCandidateScores(scored)}`);
    gateParts.push(`highFamilyRefs=${formatHighFamilyReferences(scored)}`);
    gateParts.push(`highAlignedFamilyRefs=${formatHighAlignedFamilyReferences(scored)}`);
    gateParts.push(`segmentGate=${shouldRunSegmentAnalysis ? 1 : 0}`);
    gateParts.push(`sparseGate=${shouldRunSparseFallback ? 1 : 0}`);
    if (segmentAnalysis) {
      gateParts.push(formatSegmentGateDebug(segmentAnalysis));
      if (!applySegmentCorrection) {
        gateParts.push(`segmentReject=${formatHighSegmentRejectReason(segmentAnalysis)}`);
      }
    } else {
      gateParts.push('segmentReject=not-run');
    }
    if (sparseAnalysis) {
      gateParts.push(formatSparseGateDebug(sparseAnalysis));
      if (!applySparseCorrection) {
        gateParts.push(`sparseReject=${sparseAnalysis.recommendation.reason || 'not-promoted'}`);
      }
    } else {
      gateParts.push('sparseReject=not-run');
    }
    const gateDebug = gateParts.join(' | ');

    return {
      bpm: finalBpm,
      beatTypeAuto: classifyBeatType(finalBpm),
      summary,
      gateDebug,
      decisionConfidence: segmentAnalysis?.recommendation.confidence
        ?? sparseAnalysis?.recommendation.confidence
        ?? computeDecisionConfidence({
          mode,
          selected: baseCandidate,
          applyCorrection: false,
          targetRhythmInBand
      }),
      candidates: segmentAnalysis
        ? segmentAnalysis.votes.map((vote) => ({
          bpm: vote.medianBpm,
          label: vote.label,
          score: roundScore(vote.weightedShare)
        }))
        : sparseAnalysis
          ? sparseAnalysis.votes.map((vote) => ({
            bpm: vote.medianBpm,
            label: vote.label,
            score: roundScore(vote.weightedShare)
          }))
        : scored.map((candidate) => ({
          bpm: candidate.bpm,
          label: candidate.label,
          score: roundScore(candidate.score)
      }))
    };
  }

  const selected = oneShotApplyCorrection
    ? (
      guardedLowFamilyPromotion && structuredLowCandidate
        ? structuredLowCandidate
        : preferredAlternative
    )
    : baseCandidate;
  const decisionConfidence = computeDecisionConfidence({
    mode,
    selected,
    applyCorrection: oneShotApplyCorrection,
    targetRhythmInBand
  });
  const reason = summarizeReason(selected);
  const summary = oneShotApplyCorrection
    ? `tempo-beat-correction base=${baseTempo.bpm} rhythm=${Math.round(rhythm.bpm)} final=${selected.bpm} label=${selected.label} reason=${reason} method=${baseTempo.method}`
    : `tempo-beat-correction base=${baseTempo.bpm} rhythm=${Math.round(rhythm.bpm)} final=${baseTempo.bpm} label=base reason=keep-base method=${baseTempo.method}`;
  const gateDebug = formatGateDebug({
    mode,
    baseTempo,
    rhythm,
    baseCandidate,
    alternative: preferredAlternative,
    targetRhythmInBand,
    minimumScore,
    requiredMargin,
    minimumTickLead,
    requireTickLead,
    supportCount,
    decisionConfidence,
    applyCorrection: oneShotApplyCorrection
  }) + (highMode
    ? ''
    : ` | lowScores=${formatLowCandidateScores(scored, mode)} | lowFamilyRefs=${formatLowFamilyReferences(scored, mode)}`);

  return {
    bpm: oneShotApplyCorrection ? selected.bpm : baseTempo.bpm,
    // Classify from the rounded BPM both branches: classifyBeatType has a hard
    // boundary at 120, so a raw float like 119.7 would land 'unknown' while its
    // rounded 120 is 'straight'. Use the integer the user actually sees.
    beatTypeAuto: classifyBeatType(oneShotApplyCorrection ? selected.bpm : baseTempo.bpm),
    summary,
    gateDebug,
    decisionConfidence,
    candidates: scored.map((candidate) => ({
      bpm: candidate.bpm,
      label: candidate.label,
      score: roundScore(candidate.score)
    }))
  };
}
