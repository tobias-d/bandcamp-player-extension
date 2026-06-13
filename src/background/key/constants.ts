import type { KeyAnalysisParams } from '@/shared/types';

export const CAMELOT_MAP: Readonly<Record<string, string>> = {
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

const excludedPairs = new Set<string>();
for (let n = 1; n <= 12; n += 1) {
  excludedPairs.add(`${n}A|${n}B`);
}
for (let n = 1; n <= 12; n += 1) {
  const next = n === 12 ? 1 : n + 1;
  excludedPairs.add(`${n}A|${next}A`);
  excludedPairs.add(`${n}B|${next}B`);
}

export const EXCLUDED_PAIRS = excludedPairs;

export const DEFAULT_KEY_PARAMS: Readonly<KeyAnalysisParams> = {
  windowBeats: 64,
  hopBeats: 32,
  pitchSalienceThreshold: 0.24,
  hfcPercentileThreshold: 0.7,
  prefilterFrameCount: 3,
  relativeEnergyGate: 0.35,
  reliabilityFloor: 0.25,
  dualCenterGapThreshold: 0.12,
  minCandidateWeight: 5,
  smoothingWindowSize: 3,
  minSegmentWindows: 2,
  profileType: 'edma',
  pcpSize: 36,
  profileMix: false,
  rankMode: 'baseline'
};

export function areHarmonicallyClosePair(a: string, b: string): boolean {
  return EXCLUDED_PAIRS.has(`${a}|${b}`) || EXCLUDED_PAIRS.has(`${b}|${a}`);
}

export function camelotToKeyName(camelot: string): string {
  for (const [name, mapped] of Object.entries(CAMELOT_MAP)) {
    if (mapped === camelot) {
      return name;
    }
  }
  return camelot;
}
