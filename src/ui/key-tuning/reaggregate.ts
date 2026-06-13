import type { KeyAnalysisDebugResult, KeyAnalysisParams, KeyCandidate, KeySegment } from '@/shared/types';
import type { ReaggregateOutcome } from '@/ui/key-tuning/types';

type PrefilterReason = 'pitch-salience' | 'hfc' | null;

const CAMELOT_MAP: Readonly<Record<string, string>> = {
  'Ab minor': '1A', 'G# minor': '1A', 'B major': '1B',
  'Eb minor': '2A', 'D# minor': '2A', 'F# major': '2B', 'Gb major': '2B',
  'Bb minor': '3A', 'A# minor': '3A', 'Db major': '3B', 'C# major': '3B',
  'F minor': '4A', 'Ab major': '4B', 'G# major': '4B',
  'C minor': '5A', 'Eb major': '5B', 'D# major': '5B',
  'G minor': '6A', 'Bb major': '6B', 'A# major': '6B',
  'D minor': '7A', 'F major': '7B',
  'A minor': '8A', 'C major': '8B',
  'E minor': '9A', 'G major': '9B',
  'B minor': '10A', 'D major': '10B',
  'F# minor': '11A', 'Gb minor': '11A', 'A major': '11B',
  'C# minor': '12A', 'Db minor': '12A', 'E major': '12B'
};

const EXCLUDED_PAIRS = new Set<string>();
for (let n = 1; n <= 12; n += 1) EXCLUDED_PAIRS.add(`${n}A|${n}B`);
for (let n = 1; n <= 12; n += 1) {
  const next = n === 12 ? 1 : n + 1;
  EXCLUDED_PAIRS.add(`${n}A|${next}A`);
  EXCLUDED_PAIRS.add(`${n}B|${next}B`);
}

function areClose(a: string, b: string): boolean {
  return EXCLUDED_PAIRS.has(`${a}|${b}`) || EXCLUDED_PAIRS.has(`${b}|${a}`);
}

function camelotName(camelot: string): string {
  for (const [name, value] of Object.entries(CAMELOT_MAP)) {
    if (value === camelot) return name;
  }
  return camelot;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * Math.max(0, Math.min(1, p)))));
  return sorted[idx];
}

function smooth(labels: Array<string | null>, winSize: number): Array<string | null> {
  const n = labels.length;
  if (!n) return [];
  const size = Math.max(1, Math.floor(winSize) | 1);
  const radius = Math.floor(size / 2);
  const out = new Array<string | null>(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (!labels[i]) continue;
    const counts = new Map<string, number>();
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j += 1) {
      const label = labels[j];
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    let best = labels[i];
    let bestCount = -1;
    for (const [label, count] of counts.entries()) {
      if (count > bestCount || (count === bestCount && label === labels[i])) {
        best = label;
        bestCount = count;
      }
    }
    out[i] = best;
  }
  return out;
}

function buildSegments(
  windows: KeyAnalysisDebugResult['windows'],
  labels: Array<string | null>,
  minWindows: number
): KeySegment[] {
  const segments: KeySegment[] = [];
  let start = -1;
  let end = -1;
  let current: string | null = null;
  const minLen = Math.max(1, Math.floor(minWindows));

  const flush = (): void => {
    if (!current || start < 0 || end < start) return;
    if (end - start + 1 < minLen) return;
    segments.push({
      startSeconds: windows[start].startSeconds,
      endSeconds: windows[end].endSeconds,
      camelot: current
    });
  };

  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (!label) {
      flush();
      start = -1;
      end = -1;
      current = null;
      continue;
    }
    if (label === current) {
      end = i;
      continue;
    }
    flush();
    start = i;
    end = i;
    current = label;
  }
  flush();

  return new Set(segments.map((s) => s.camelot)).size <= 1 ? [] : segments;
}

function parseCamelot(value: string): { n: number; mode: 'A' | 'B' } | null {
  const match = String(value || '').trim().toUpperCase().match(/^(1[0-2]|[1-9])([AB])$/);
  if (!match) return null;
  return { n: Number(match[1]), mode: match[2] as 'A' | 'B' };
}

function camelotDistance(a: string, b: string): number {
  const aa = parseCamelot(a);
  const bb = parseCamelot(b);
  if (!aa || !bb) return 1;
  const ring = Math.abs(aa.n - bb.n);
  const wrapped = Math.min(ring, 12 - ring);
  const modePenalty = aa.mode === bb.mode ? 0 : 1;
  return Math.min(1, (wrapped + modePenalty) / 7);
}

function aggregate(
  rows: Array<{ idx: number; camelot: string; weight: number }>,
  floor: number,
  rankMode: KeyAnalysisParams['rankMode']
): { topKeys: KeyCandidate[]; preFloor: Array<{ camelot: string; weight: number }> } {
  const bins = new Map<string, { sumWeight: number; count: number; longestRun: number }>();
  const sortedByIndex = [...rows].sort((a, b) => a.idx - b.idx);
  let runCamelot = '';
  let runLength = 0;
  for (const row of sortedByIndex) {
    const entry = bins.get(row.camelot) || { sumWeight: 0, count: 0, longestRun: 0 };
    entry.sumWeight += row.weight;
    entry.count += 1;
    bins.set(row.camelot, entry);

    if (row.camelot === runCamelot) {
      runLength += 1;
    } else {
      runCamelot = row.camelot;
      runLength = 1;
    }
    const current = bins.get(row.camelot)!;
    current.longestRun = Math.max(current.longestRun, runLength);
  }
  if (!bins.size) return { topKeys: [], preFloor: [] };

  const totalWeight = Array.from(bins.values()).reduce((a, b) => a + b.sumWeight, 0);
  if (totalWeight <= 0) return { topKeys: [], preFloor: [] };

  let preFloor: Array<{ camelot: string; weight: number }>;
  if (rankMode === 'consensus') {
    const totalIncluded = Math.max(1, rows.length);
    const maxBinWeight = Math.max(1, ...Array.from(bins.values()).map((v) => v.sumWeight));
    const raw = Array.from(bins.entries()).map(([camelot, bin]) => {
      const coverageScore = bin.count / totalIncluded;
      const weightScore = bin.sumWeight / maxBinWeight;
      const stabilityScore = bin.longestRun / Math.max(1, bin.count);
      const avgDistance = rows.reduce(
        (sum, row) => sum + camelotDistance(camelot, row.camelot) * row.weight,
        0
      ) / totalWeight;
      const adjacencyPenalty = 0.15 * avgDistance;
      const score = (0.45 * coverageScore) + (0.35 * weightScore) + (0.20 * stabilityScore) - adjacencyPenalty;
      return { camelot, score: Math.max(0, score) };
    });
    const totalScore = raw.reduce((sum, item) => sum + item.score, 0);
    preFloor = (totalScore > 0 ? raw.map((item) => ({ camelot: item.camelot, weight: (item.score / totalScore) * 100 })) : [])
      .sort((a, b) => b.weight - a.weight);
  } else {
    preFloor = Array.from(bins.entries())
      .map(([camelot, value]) => ({ camelot, weight: (value.sumWeight / totalWeight) * 100 }))
      .sort((a, b) => b.weight - a.weight);
  }

  const topKeys = preFloor
    .filter((c) => c.weight >= floor)
    .slice(0, 3)
    .map((c) => ({ camelot: c.camelot, key: camelotName(c.camelot), weight: Number(c.weight.toFixed(3)) }));

  return { topKeys, preFloor };
}

export function reaggregate(data: KeyAnalysisDebugResult, params: KeyAnalysisParams): ReaggregateOutcome {
  const hfcValues = data.windows.map((w) => w.hfc);
  const hfcCutoff = percentile(hfcValues, params.hfcPercentileThreshold);

  const passPrefilter = data.windows.map((w) =>
    w.pitchSalience >= params.pitchSalienceThreshold && w.hfc <= hfcCutoff
  );

  let maxEnergy = 0;
  for (let i = 0; i < data.windows.length; i += 1) {
    const w = data.windows[i];
    if (!passPrefilter[i] || w.harmonicEnergy === null) continue;
    if (w.harmonicEnergy > maxEnergy) maxEnergy = w.harmonicEnergy;
  }

  const weighted: Array<{ idx: number; camelot: string; weight: number }> = [];
  for (let i = 0; i < data.windows.length; i += 1) {
    const w = data.windows[i];
    if (!passPrefilter[i] || w.harmonicEnergy === null || !w.camelot || w.combinedWeight === null) continue;
    const passEnergy = maxEnergy > 0 && w.harmonicEnergy >= params.relativeEnergyGate * maxEnergy;
    if (!passEnergy) continue;
    weighted.push({ idx: i, camelot: w.camelot, weight: w.combinedWeight });
  }

  const reliability = weighted.length
    ? weighted.reduce((sum, row) => sum + row.weight, 0) / weighted.length
    : 0;

  const states = data.windows.map((w, i) => {
    const pre = passPrefilter[i];
    const passEnergy = pre && w.harmonicEnergy !== null && maxEnergy > 0
      ? w.harmonicEnergy >= params.relativeEnergyGate * maxEnergy
      : false;
    const included = weighted.some((row) => row.idx === i);
    const prefilterReason: PrefilterReason = pre
      ? null
      : (w.pitchSalience < params.pitchSalienceThreshold ? 'pitch-salience' : 'hfc');
    return {
      passedPrefilter: pre,
      prefilterReason,
      passedEnergyGate: passEnergy,
      included
    };
  });

  if (reliability < params.reliabilityFloor) {
    return {
      result: {
        topKeys: [],
        dualCenter: false,
        segments: [],
        method: 'essentia-hpcp-key',
        windowsAnalyzed: weighted.length,
        windowsTotal: data.windows.length,
        reliability
      },
      hfcCutoff,
      preFloorCandidates: [],
      windowStates: states
    };
  }

  const { topKeys, preFloor } = aggregate(
    weighted.map((w) => ({ idx: w.idx, camelot: w.camelot, weight: w.weight })),
    params.minCandidateWeight,
    params.rankMode
  );

  const dualCenter = Boolean(
    topKeys.length >= 2
    && reliability >= params.reliabilityFloor * 1.5
    && topKeys[0].weight > 0
    && ((topKeys[0].weight - topKeys[1].weight) / topKeys[0].weight) < params.dualCenterGapThreshold
    && !areClose(topKeys[0].camelot, topKeys[1].camelot)
  );

  const labelByIndex = new Map<number, string>();
  for (const row of weighted) labelByIndex.set(row.idx, row.camelot);
  const labels = data.windows.map((_w, i) => labelByIndex.get(i) || null);
  const segments = buildSegments(data.windows, smooth(labels, params.smoothingWindowSize), params.minSegmentWindows);

  return {
    result: {
      topKeys,
      dualCenter,
      segments,
      method: 'essentia-hpcp-key',
      windowsAnalyzed: weighted.length,
      windowsTotal: data.windows.length,
      reliability
    },
    hfcCutoff,
    preFloorCandidates: preFloor,
    windowStates: states
  };
}
