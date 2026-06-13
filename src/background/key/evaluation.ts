import { aggregateCamelotWeights, detectDualCenter } from '@/background/key/aggregation';
import { buildSegments, smoothKeySequence } from '@/background/key/segments';
import { scoreWindowKey } from '@/background/key/scoring';
import type { HPCPResult, PrefilterResult, WindowBounds } from '@/background/key/types';
import type { KeyAnalysisParams, KeyAnalysisResult, KeyWindowData } from '@/shared/types';

interface WindowVote {
  camelot: string;
  combinedWeight: number;
  keyStrength: number;
}

interface EvaluationResult {
  result: KeyAnalysisResult;
  scoreMs: number;
  aggregateMs: number;
}

function reliabilityFromWeights(values: Array<number | null>): number {
  const finite = values.filter((v): v is number => Number.isFinite(v ?? NaN));
  if (!finite.length) {
    return 0;
  }
  const sum = finite.reduce((acc, value) => acc + value, 0);
  return sum / finite.length;
}

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

function blendWindowScores(
  primaryProfile: string,
  pcp: Float32Array,
  harmonicEnergy: number,
  pcpSize: number,
  profileMix: boolean,
  essentia: any,
  essentiaModule: any
): { display: ReturnType<typeof scoreWindowKey> | null; votes: WindowVote[] } {
  const primary = scoreWindowKey(
    pcp,
    harmonicEnergy,
    primaryProfile,
    pcpSize,
    essentia,
    essentiaModule
  );
  if (!profileMix) {
    if (!primary?.camelot) {
      return { display: primary, votes: [] };
    }
    return {
      display: primary,
      votes: [{ camelot: primary.camelot, combinedWeight: primary.combinedWeight, keyStrength: primary.keyStrength }]
    };
  }

  const mixed = scoreWindowKey(
    pcp,
    harmonicEnergy,
    primaryProfile === 'edmm' ? 'edma' : 'edmm',
    pcpSize,
    essentia,
    essentiaModule
  );
  const withCamelot = [primary, mixed].filter((score): score is NonNullable<typeof score> => Boolean(score?.camelot));
  if (!withCamelot.length) {
    return { display: primary || mixed || null, votes: [] };
  }
  if (withCamelot.length === 1) {
    const only = withCamelot[0];
    return {
      display: only,
      votes: [{ camelot: only.camelot!, combinedWeight: only.combinedWeight, keyStrength: only.keyStrength }]
    };
  }

  const [a, b] = withCamelot;
  if (a.camelot === b.camelot) {
    const avgStrength = (a.keyStrength + b.keyStrength) / 2;
    const avgCombinedWeight = (a.combinedWeight + b.combinedWeight) / 2;
    return {
      display: {
        ...a,
        keyStrength: avgStrength,
        combinedWeight: avgCombinedWeight,
        firstToSecondRelativeStrength: (a.firstToSecondRelativeStrength + b.firstToSecondRelativeStrength) / 2
      },
      votes: [{ camelot: a.camelot!, combinedWeight: avgCombinedWeight, keyStrength: avgStrength }]
    };
  }

  const voteA: WindowVote = { camelot: a.camelot!, combinedWeight: a.combinedWeight / 2, keyStrength: a.keyStrength };
  const voteB: WindowVote = { camelot: b.camelot!, combinedWeight: b.combinedWeight / 2, keyStrength: b.keyStrength };
  const display = a.combinedWeight >= b.combinedWeight ? a : b;
  return { display, votes: [voteA, voteB] };
}

export function evaluateWindowHPCPMap(
  windows: readonly WindowBounds[],
  prefilters: readonly PrefilterResult[],
  hfcCutoff: number,
  hpcpByWindow: ReadonlyMap<number, HPCPResult>,
  params: KeyAnalysisParams,
  essentia: any,
  essentiaModule: any,
  windowData?: KeyWindowData[] | null
): EvaluationResult {
  let maxEnergy = 0;
  for (const hpcp of hpcpByWindow.values()) {
    if (hpcp.harmonicEnergy > maxEnergy) {
      maxEnergy = hpcp.harmonicEnergy;
    }
  }

  const scoreRows: Array<{ index: number; camelot: string; combinedWeight: number; keyStrength: number }> = [];
  const primaryRows: Array<{ index: number; camelot: string; combinedWeight: number }> = [];
  const labels = new Array<string | null>(windows.length).fill(null);

  const scoreStartedAt = performance.now();
  for (let i = 0; i < windows.length; i += 1) {
    const pre = prefilters[i];
    const hpcp = hpcpByWindow.get(i);
    const passPrefilter = pre.pitchSalience >= params.pitchSalienceThreshold && pre.hfc <= hfcCutoff;

    if (!hpcp) {
      if (windowData) {
        windowData[i].passedPrefilter = passPrefilter;
        windowData[i].prefilterReason = passPrefilter ? null : (pre.pitchSalience < params.pitchSalienceThreshold ? 'pitch-salience' : 'hfc');
      }
      continue;
    }

    const energyGate = maxEnergy > 0
      ? hpcp.harmonicEnergy >= params.relativeEnergyGate * maxEnergy
      : false;

    if (windowData) {
      windowData[i].passedPrefilter = passPrefilter;
      windowData[i].prefilterReason = passPrefilter ? null : (pre.pitchSalience < params.pitchSalienceThreshold ? 'pitch-salience' : 'hfc');
      windowData[i].passedEnergyGate = energyGate;
    }

    const scored = blendWindowScores(
      params.profileType,
      hpcp.meanHPCP,
      hpcp.harmonicEnergy,
      params.pcpSize,
      params.profileMix,
      essentia,
      essentiaModule
    );
    const score = scored.display;

    if (score && windowData) {
      windowData[i].key = score.key;
      windowData[i].scale = score.scale;
      windowData[i].camelot = score.camelot;
      windowData[i].keyStrength = score.keyStrength;
      windowData[i].firstToSecondRelativeStrength = score.firstToSecondRelativeStrength;
      windowData[i].combinedWeight = score.combinedWeight;
    }

    if (!score || !score.camelot || !passPrefilter || !energyGate || !scored.votes.length) {
      continue;
    }

    primaryRows.push({
      index: i,
      camelot: score.camelot,
      combinedWeight: score.combinedWeight
    });
    labels[i] = score.camelot;
    scored.votes.forEach((vote) => {
      scoreRows.push({
        index: i,
        camelot: vote.camelot,
        combinedWeight: vote.combinedWeight,
        keyStrength: vote.keyStrength
      });
    });
  }
  const scoreMs = Math.round(performance.now() - scoreStartedAt);

  const reliability = reliabilityFromWeights(primaryRows.map((row) => row.combinedWeight));
  const windowsTotal = windows.length;
  const windowsAnalyzed = primaryRows.length;

  if (reliability < params.reliabilityFloor) {
    return {
      result: baseResult(windowsTotal, windowsAnalyzed, reliability),
      scoreMs,
      aggregateMs: 0
    };
  }

  const aggregateStartedAt = performance.now();
  const topKeys = aggregateCamelotWeights(
    scoreRows.map((row) => ({ camelot: row.camelot, combinedWeight: row.combinedWeight })),
    params.minCandidateWeight
  );

  const dualCenter = detectDualCenter(
    topKeys,
    params.dualCenterGapThreshold,
    reliability,
    params.reliabilityFloor
  );

  const smoothed = smoothKeySequence(labels, params.smoothingWindowSize);
  const segments = buildSegments(windows, smoothed, 16000, params.minSegmentWindows);
  const aggregateMs = Math.round(performance.now() - aggregateStartedAt);

  return {
    result: {
      topKeys,
      dualCenter,
      segments,
      method: 'essentia-hpcp-key',
      windowsAnalyzed,
      windowsTotal,
      reliability
    },
    scoreMs,
    aggregateMs
  };
}
