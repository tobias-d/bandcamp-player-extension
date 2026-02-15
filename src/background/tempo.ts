/**
 * ============================================================================
 * TEMPO ESTIMATION ENGINE
 * ============================================================================
 *
 * Advanced multi-window BPM detection with beat type classification and
 * harmonic relationship analysis for music tempo estimation.
 *
 * ALGORITHM OVERVIEW:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. ONSET DETECTION: Extracts energy-based onset envelope from audio
 * 2. AUTOCORRELATION: Uses Pearson correlation to find periodic patterns
 * 3. MULTI-WINDOW ANALYSIS: Analyzes 4 different segments (10s, 45s, 80s, 115s)
 * 4. HYPOTHESIS GENERATION: Creates BPM candidates with harmonic variations
 * 5. CLUSTERING: Groups similar BPM estimates to find consensus
 * 6. BEAT CLASSIFICATION: Distinguishes straight (four-on-floor) from breakbeat
 * 7. REFINEMENT: Fine-tunes BPM and selects best tempo from harmonics
 * 8. TEMPO PROMOTION: Resolves common octave errors (halftime detection)
 *
 * @module background/tempo
 * @version 2026-02-15-typescript
 */

import type { BeatMode, BeatType, TempoResult, OnsetResult, TempoCandidateResult, TempoCluster, MeterEvidence } from '../shared/index';

/* ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================ */

/**
 * Clamp a value between minimum and maximum bounds.
 */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Fold BPM into valid range by doubling/halving.
 */
function foldIntoRange(bpm: number, minBpm: number, maxBpm: number): number {
  let x = bpm;
  while (x < minBpm) x *= 2;
  while (x > maxBpm) x /= 2;
  return x;
}

/**
 * Safe logarithm for positive values.
 */
function safeLog1p(x: number): number {
  return Math.log(1 + Math.max(0, x));
}

/* ============================================================================
 * CONFIGURATION PARAMETERS
 * ============================================================================ */

const BPM_MIN = 70;
const BPM_MAX = 220;
const BPM_WINDOWS = [10, 45, 80, 115];
const BPM_WINDOW_LEN = 24;
const BPM_GROUP_TOL = 4.5;
const BPM_TOPK = 6;

const BREAKBEAT_OFFBEAT_RATIO_MIN = 0.85;

const DNB_HALFTIME_MIN = 105;
const DNB_HALFTIME_MAX = 130;
const DNB_RANGE_MIN = 155;
const DNB_RANGE_MAX = 190;
const DNB_SUPPORT_RATIO = 0.93;

const FAST_DOUBLE_SRC_MIN = 68;
const FAST_DOUBLE_SRC_MAX = 88;
const FAST_DOUBLE_DST_MIN = 132;
const FAST_DOUBLE_DST_MAX = 180;
const FAST_DOUBLE_SUPPORT_RATIO = 0.90;

const FAST_3OVER2_SRC_MIN = 85;
const FAST_3OVER2_SRC_MAX = 130;
const FAST_3OVER2_DST_MIN = 135;
const FAST_3OVER2_DST_MAX = 195;
const FAST_3OVER2_SUPPORT_RATIO = 0.55;
const FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT = 0.50;
const FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT_IMPROVED = 0.45;

const METER_DOM_WEIGHT = 0.25;

const REFINE_RANGE_BPM = 8;
const REFINE_STEP_BPM = 0.2;

/* ============================================================================
 * ONSET DETECTION
 * ============================================================================ */

interface OnsetOptions {
  hop?: number;
  win?: number;
  smoothHalfWidth?: number;
}

function onsetEnvelopeFromEnergy(
  mono: Float32Array,
  sr: number,
  opts: OnsetOptions = {}
): OnsetResult | null {
  const { hop = 128, win = 1024, smoothHalfWidth = 4 } = opts;
  const frameCount = Math.floor((mono.length - win) / hop);
  if (frameCount <= 30) return null;

  const oenv = new Float32Array(frameCount);
  let prevRms = 0;

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < win; i++) {
      const v = mono[start + i] || 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / win);
    const d = Math.max(0, rms - prevRms);
    oenv[f] = d;
    prevRms = rms;
  }

  let maxV = 1e-12;
  for (let i = 0; i < oenv.length; i++) if (oenv[i] > maxV) maxV = oenv[i];
  for (let i = 0; i < oenv.length; i++) oenv[i] /= maxV;

  const smooth = new Float32Array(frameCount);
  const k = smoothHalfWidth;
  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    let n = 0;
    for (let j = -k; j <= k; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < frameCount) {
        acc += oenv[idx];
        n++;
      }
    }
    smooth[i] = acc / Math.max(1, n);
  }

  const frameRate = sr / hop;
  return { oenv: smooth, frameRate };
}

/* ============================================================================
 * AUTOCORRELATION & PEAK DETECTION
 * ============================================================================ */

function pearsonAutocorrScores(
  oenv: Float32Array,
  lagMin: number,
  lagMax: number
): Float32Array | null {
  let mean = 0;
  for (let i = 0; i < oenv.length; i++) mean += oenv[i];
  mean /= Math.max(1, oenv.length);

  let denom = 0;
  for (let i = 0; i < oenv.length; i++) {
    const x = oenv[i] - mean;
    denom += x * x;
  }

  if (denom <= 1e-12) return null;

  const scores = new Float32Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let num = 0;
    for (let i = 0; i + lag < oenv.length; i++) {
      const a = oenv[i] - mean;
      const b = oenv[i + lag] - mean;
      num += a * b;
    }
    scores[lag] = num / denom;
  }

  return scores;
}

function parabolicRefine(scores: Float32Array, lag: number): number {
  if (lag < 1 || lag > scores.length - 2) return lag;
  const sL = scores[lag - 1];
  const s0 = scores[lag];
  const sR = scores[lag + 1];
  const denom = (sL - 2 * s0 + sR);
  if (Math.abs(denom) < 1e-12) return lag;
  const offset = 0.5 * (sL - sR) / denom;
  return lag + clamp(offset, -1, 1);
}

interface TempoCandidatesOptions {
  minBpm?: number;
  maxBpm?: number;
  topK?: number;
}

function tempoCandidatesFromOenv(
  oenv: Float32Array,
  frameRate: number,
  opts: TempoCandidatesOptions = {}
): TempoCandidateResult[] | null {
  const { minBpm = BPM_MIN, maxBpm = BPM_MAX, topK = BPM_TOPK } = opts;
  const lagMin = Math.floor((60 * frameRate) / maxBpm);
  const lagMax = Math.floor((60 * frameRate) / minBpm);
  if (lagMax <= lagMin + 8) return null;

  const scores = pearsonAutocorrScores(oenv, lagMin, lagMax);
  if (!scores) return null;

  const peaks: Array<{ lag: number; score: number }> = [];
  for (let lag = lagMin + 1; lag <= lagMax - 1; lag++) {
    const s = scores[lag];
    if (s > scores[lag - 1] && s > scores[lag + 1]) {
      peaks.push({ lag, score: s });
    }
  }

  peaks.sort((a, b) => b.score - a.score);

  const picked: Array<{ lag: number; score: number }> = [];
  const minSep = 3;
  for (const p of peaks) {
    if (picked.length >= topK) break;
    if (picked.some((q) => Math.abs(q.lag - p.lag) < minSep)) continue;
    picked.push(p);
  }

  return picked.map((p) => {
    const refinedLag = parabolicRefine(scores, p.lag);
    const rawBpm = (60 * frameRate) / refinedLag;
    const bpm = foldIntoRange(rawBpm, minBpm, maxBpm);
    return { bpm, score: p.score };
  });
}

/* ============================================================================
 * BEAT TYPE CLASSIFICATION
 * ============================================================================ */

function offbeatRatioForTempo(oenv: Float32Array, frameRate: number, bpm: number): number {
  const period = (60 * frameRate) / bpm;
  if (!Number.isFinite(period) || period < 4) return 0;

  let on = 0;
  let off = 0;
  for (let k = 2; k < 80; k++) {
    const iOn = Math.round(k * period);
    const iOff = Math.round(iOn + period / 2);
    if (iOff >= oenv.length) break;
    on += oenv[iOn] || 0;
    off += oenv[iOff] || 0;
  }

  return off / (on + 1e-9);
}

function onbeatDominanceForTempo(oenv: Float32Array, frameRate: number, bpm: number): number {
  const period = (60 * frameRate) / bpm;
  if (!Number.isFinite(period) || period < 4) return 0;

  let on = 0;
  let off = 0;
  for (let k = 2; k < 80; k++) {
    const iOn = Math.round(k * period);
    const iOff = Math.round(iOn + period / 2);
    if (iOff >= oenv.length) break;
    on += oenv[iOn] || 0;
    off += oenv[iOff] || 0;
  }

  return on / (off + 1e-9);
}

interface BeatTypeClassification {
  beatType: BeatType;
  breakbeatScore: number;
}

function classifyBeatType(mono: Float32Array, sr: number, bpm: number): BeatTypeClassification {
  const ratios: number[] = [];
  for (const startSec of BPM_WINDOWS) {
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    if ((end - start) < sr * 10) continue;
    const seg = mono.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, sr);
    if (!onset) continue;
    ratios.push(offbeatRatioForTempo(onset.oenv, onset.frameRate, bpm));
  }

  if (!ratios.length) return { beatType: 'unknown', breakbeatScore: 0 };

  const avg = ratios.reduce((a, x) => a + x, 0) / ratios.length;
  return {
    beatType: avg >= BREAKBEAT_OFFBEAT_RATIO_MIN ? 'breakbeat' : 'straight',
    breakbeatScore: avg,
  };
}

/* ============================================================================
 * TEMPO SUPPORT SCORING
 * ============================================================================ */

function tempoSupportScore(mono: Float32Array, sr: number, bpm: number): number {
  let sum = 0;
  let n = 0;
  for (const startSec of BPM_WINDOWS) {
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    if ((end - start) < sr * 10) continue;
    const seg = mono.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, sr);
    if (!onset) continue;

    const frameRate = onset.frameRate;
    const lagMin = Math.floor((60 * frameRate) / BPM_MAX);
    const lagMax = Math.floor((60 * frameRate) / BPM_MIN);
    const scores = pearsonAutocorrScores(onset.oenv, lagMin, lagMax);
    if (!scores) continue;

    const lag0 = (60 * frameRate) / bpm;
    const lagI = Math.round(lag0);

    let best = -Infinity;
    for (let d = -2; d <= 2; d++) {
      const li = lagI + d;
      if (li >= lagMin && li <= lagMax) best = Math.max(best, scores[li]);
    }

    sum += Math.max(0, best);
    n++;
  }

  return n ? (sum / n) : 0;
}

function avgOnbeatDominance(mono: Float32Array, sr: number, bpm: number): number {
  let sum = 0;
  let n = 0;
  for (const startSec of BPM_WINDOWS) {
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    if ((end - start) < sr * 10) continue;
    const seg = mono.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, sr);
    if (!onset) continue;
    sum += onbeatDominanceForTempo(onset.oenv, onset.frameRate, bpm);
    n++;
  }

  return n ? (sum / n) : 0;
}

/* ============================================================================
 * REFINEMENT & HARMONIC SELECTION
 * ============================================================================ */

function fineTuneOnly(mono: Float32Array, sr: number, bpm0: number): number {
  if (!Number.isFinite(bpm0) || bpm0 <= 0) return bpm0;
  let bestBpm = bpm0;
  let bestScore = tempoSupportScore(mono, sr, bpm0);

  const r = REFINE_RANGE_BPM;
  const step = REFINE_STEP_BPM;
  for (let b = Math.max(BPM_MIN, bpm0 - r); b <= Math.min(BPM_MAX, bpm0 + r); b += step) {
    const s = tempoSupportScore(mono, sr, b);
    if (s > bestScore) {
      bestScore = s;
      bestBpm = b;
    }
  }

  return bestBpm;
}

interface RefineAndPickHarmonicsOptions {
  fineTuneOnly?: boolean;
}

function refineAndPickHarmonics(
  mono: Float32Array,
  sr: number,
  bpm0: number,
  beatMode: BeatMode,
  opts: RefineAndPickHarmonicsOptions = {}
): MeterEvidence {
  const { fineTuneOnly: onlyFineTune } = opts;

  const harmonics: Array<{ mult: number; weight: number }> = [
    { mult: 1, weight: 1.0 },
  ];

  if (!onlyFineTune) {
    harmonics.push(
      { mult: 0.5, weight: 0.85 },
      { mult: 2.0, weight: 0.85 },
      { mult: 2 / 3, weight: 0.82 },
      { mult: 3 / 2, weight: 0.82 },
      { mult: 3 / 4, weight: 0.78 },
      { mult: 4 / 3, weight: 0.78 }
    );
  }

  const pool: MeterEvidence[] = [];

  for (const h of harmonics) {
    const bpmTest = foldIntoRange(bpm0 * h.mult, BPM_MIN, BPM_MAX);
    let bestBpm = bpmTest;
    let bestScore = tempoSupportScore(mono, sr, bpmTest);

    const r = REFINE_RANGE_BPM;
    const step = REFINE_STEP_BPM;
    for (let b = Math.max(BPM_MIN, bpmTest - r); b <= Math.min(BPM_MAX, bpmTest + r); b += step) {
      const s = tempoSupportScore(mono, sr, b);
      if (s > bestScore) {
        bestScore = s;
        bestBpm = b;
      }
    }

    const dom = avgOnbeatDominance(mono, sr, bestBpm);
    const { beatType, breakbeatScore } = classifyBeatType(mono, sr, bestBpm);

    pool.push({
      bpm: bestBpm,
      support: bestScore,
      dom,
      score: bestScore * h.weight + METER_DOM_WEIGHT * dom,
      beatType,
      breakbeatScore,
    });
  }

  pool.sort((a, b) => b.score - a.score);

  const winner = pool[0];

  return {
    bpm: bayesianPriorBPM(winner.bpm, beatMode, winner.beatType),
    support: winner.support,
    dom: winner.dom,
    score: winner.score,
    beatType: winner.beatType,
    breakbeatScore: winner.breakbeatScore,
  };
}

function bayesianPriorBPM(bpm: number, beatMode: BeatMode, beatType: BeatType): number {
  const isBreakbeat = (beatMode === 'breakbeat' || beatType === 'breakbeat');

  const peakBpm = isBreakbeat ? 150 : 128;
  const sigma = isBreakbeat ? 25 : 30;

  const dist = Math.abs(bpm - peakBpm);
  const logLikelihood = -(dist * dist) / (2 * sigma * sigma);
  const likelihood = Math.exp(logLikelihood);

  const adjustment = 0.03 * likelihood;
  return bpm + adjustment * (peakBpm - bpm);
}

/* ============================================================================
 * TEMPO PROMOTION & CORRECTION
 * ============================================================================ */

function tempoPromotion(mono: Float32Array, sr: number, bpm: number, beatMode: BeatMode): number {
  // 1. D&B halftime detection
  if (bpm >= DNB_HALFTIME_MIN && bpm <= DNB_HALFTIME_MAX && beatMode === 'breakbeat') {
    const fast = bpm * 1.5;
    if (fast >= DNB_RANGE_MIN && fast <= DNB_RANGE_MAX) {
      const slowSupport = tempoSupportScore(mono, sr, bpm);
      const fastSupport = tempoSupportScore(mono, sr, fast);
      if (fastSupport >= slowSupport * DNB_SUPPORT_RATIO) {
        return fineTuneOnly(mono, sr, fast);
      }
    }
  }

  // 2. Fast double-time
  if (bpm >= FAST_DOUBLE_SRC_MIN && bpm <= FAST_DOUBLE_SRC_MAX) {
    const fast = bpm * 2;
    if (fast >= FAST_DOUBLE_DST_MIN && fast <= FAST_DOUBLE_DST_MAX) {
      const slowSupport = tempoSupportScore(mono, sr, bpm);
      const fastSupport = tempoSupportScore(mono, sr, fast);
      if (fastSupport >= slowSupport * FAST_DOUBLE_SUPPORT_RATIO) {
        return fineTuneOnly(mono, sr, fast);
      }
    }
  }

  // 3. Fast 3/2 promotion
  if (bpm >= FAST_3OVER2_SRC_MIN && bpm <= FAST_3OVER2_SRC_MAX) {
    const fast = bpm * 1.5;
    if (fast >= FAST_3OVER2_DST_MIN && fast <= FAST_3OVER2_DST_MAX) {
      const { beatType } = classifyBeatType(mono, sr, bpm);
      const isBreakbeat = (beatType === 'breakbeat');

      const slowSupport = tempoSupportScore(mono, sr, bpm);
      const fastSupport = tempoSupportScore(mono, sr, fast);

      let threshold = FAST_3OVER2_SUPPORT_RATIO;
      if (isBreakbeat) {
        threshold = FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT;
        const fastDom = avgOnbeatDominance(mono, sr, fast);
        if (fastDom > 1.5) {
          threshold = FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT_IMPROVED;
        }
      }

      if (fastSupport >= slowSupport * threshold) {
        return fineTuneOnly(mono, sr, fast);
      }
    }
  }

  // 4. Forced halftime corrections
  if (bpm >= 100 && bpm <= 115) {
    return fineTuneOnly(mono, sr, bpm * 1.5);
  }
  if (bpm >= 85 && bpm < 100) {
    return fineTuneOnly(mono, sr, bpm * 1.5);
  }

  return bpm;
}

/* ============================================================================
 * CLUSTERING & HYPOTHESIS GENERATION
 * ============================================================================ */

interface Hypothesis {
  bpm: number;
  weight: number;
}

function clusterHypotheses(allHyps: Hypothesis[]): TempoCluster[] {
  if (!allHyps.length) return [];

  const sorted = [...allHyps].sort((a, b) => a.bpm - b.bpm);
  const clusters: TempoCluster[] = [];

  for (const h of sorted) {
    let found = false;
    for (const c of clusters) {
      if (Math.abs(h.bpm - c.center) < BPM_GROUP_TOL) {
        c.items.push(h);
        c.weightSum += h.weight;
        c.center = c.items.reduce((sum: number, item: { bpm: number; weight: number }) => sum + item.bpm * item.weight, 0) / c.weightSum;
        found = true;
        break;
      }
    }
    if (!found) {
      clusters.push({
        center: h.bpm,
        items: [h],
        weightSum: h.weight,
      });
    }
  }

  return clusters;
}

/* ============================================================================
 * MAIN ESTIMATION FUNCTION
 * ============================================================================ */

type ProgressCallback = ((result: Partial<TempoResult>) => void) | null;

export function estimateTempoWithBeatMode(
  mono: Float32Array,
  sr: number,
  beatMode: BeatMode,
  onProgressUpdate: ProgressCallback = null
): TempoResult | null {
  const allHyps: Hypothesis[] = [];
  let windowsProcessed = 0;

  for (const startSec of BPM_WINDOWS) {
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    if ((end - start) < sr * 10) continue;

    const seg = mono.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, sr);
    if (!onset) continue;

    const cands = tempoCandidatesFromOenv(onset.oenv, onset.frameRate);
    if (!cands) continue;

    for (const c of cands) {
      allHyps.push({ bpm: c.bpm, weight: c.score });
    }

    windowsProcessed++;

    // Preliminary result after 2 windows
    if (windowsProcessed === 2 && onProgressUpdate) {
      const prelimClusters = clusterHypotheses(allHyps);
      if (prelimClusters.length > 0) {
        prelimClusters.sort((a, b) => (b.weightSum + b.items.length * 0.15) - (a.weightSum + a.items.length * 0.15));
        const bestCluster = prelimClusters[0];
        const prelimBpm = bestCluster.center;
        const { beatType, breakbeatScore } = classifyBeatType(mono, sr, prelimBpm);

        onProgressUpdate({
          bpm: Math.round(prelimBpm),
          confidence: 65,
          beatTypeAuto: beatType,
          breakbeatScore,
          beatMode,
        });
      }
    }
  }

  if (!allHyps.length) return null;

  const clusters = clusterHypotheses(allHyps);
  if (!clusters.length) return null;

  clusters.sort((a, b) => (b.weightSum + b.items.length * 0.15) - (a.weightSum + a.items.length * 0.15));

  const bestCluster = clusters[0];
  let bestBpm = bestCluster.center;

  const meter = refineAndPickHarmonics(mono, sr, bestBpm, beatMode);
  bestBpm = meter.bpm;

  bestBpm = tempoPromotion(mono, sr, bestBpm, beatMode);

  const finalSupport = tempoSupportScore(mono, sr, bestBpm);
  const { beatType: finalBeatType, breakbeatScore: finalBreakbeatScore } = classifyBeatType(mono, sr, bestBpm);

  const half = bestBpm / 2;
  const double = bestBpm * 2;
  const halfSupport = (half >= BPM_MIN && half <= BPM_MAX) ? tempoSupportScore(mono, sr, half) : 0;
  const doubleSupport = (double >= BPM_MIN && double <= BPM_MAX) ? tempoSupportScore(mono, sr, double) : 0;

  const maxAlt = Math.max(halfSupport, doubleSupport);
  const margin = finalSupport - maxAlt;

  let confidence = Math.min(55, Math.round(bestCluster.weightSum * 50));
  confidence += Math.min(45, Math.round(margin * 100));
  confidence = clamp(confidence, 0, 99);

  return {
    bpm: Math.round(bestBpm * 10) / 10,
    confidence,
    beatTypeAuto: finalBeatType,
    breakbeatScore: finalBreakbeatScore,
    beatMode,
    _support: finalSupport,
  };
}
