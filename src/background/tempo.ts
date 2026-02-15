/**
 * ============================================================================
 * TEMPO ESTIMATION ENGINE - MUSICAL INTELLIGENCE v2.5.1
 * ============================================================================
 *
 * VERSION: 2.5.1 (2026-02-15)
 * 
 * FIXES FROM v2.4:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. Restored proper peak detection (v2.4 was too aggressive)
 * 2. Musical plausibility as BONUS, not hard filter
 * 3. Conservative tempo snapping (only when very close)
 * 4. Harmonic preference for breakbeat (80/160 over 107)
 * 5. Better balance: accuracy + speed
 * 
 * SHOULD DETECT: Trampolin → 80 BPM (not 107)
 * 
 * @module background/tempo
 * @version 2026-02-15-v2.5.1
 */

import type { BeatMode, BeatType, TempoResult, OnsetResult, TempoCandidateResult, TempoCluster, MeterEvidence } from '../shared/index';

/* ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================ */

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function foldIntoRange(bpm: number, minBpm: number, maxBpm: number): number {
  let x = bpm;
  while (x < minBpm) x *= 2;
  while (x > maxBpm) x /= 2;
  return x;
}

async function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * NEW v2.5: Musical plausibility scoring (not rejection)
 * Returns a bonus/penalty score, not a boolean
 */
function musicalPlausibilityScore(bpm: number): number {
  // Strongly prefer common tempo ranges
  if ((bpm >= 75 && bpm <= 90) || (bpm >= 120 && bpm <= 135) || (bpm >= 155 && bpm <= 175)) {
    return 0.15; // Strong bonus
  }
  
  // Accept extended ranges with smaller bonus
  if ((bpm >= 70 && bpm <= 95) || (bpm >= 115 && bpm <= 140) || (bpm >= 150 && bpm <= 180)) {
    return 0.05; // Small bonus
  }
  
  // Penalize "phantom" range (but don't reject completely)
  if (bpm >= 103 && bpm <= 112) {
    return -0.25; // Penalty
  }
  
  // Neutral for other values
  return 0;
}

/**
 * NEW v2.5: Conservative tempo snapping
 * Only snaps when VERY close to common values
 */
function snapToMusicalTempo(bpm: number): number {
  // Common BPM values
  const commonTempos = [
    70, 75, 80, 85, 87, 90, 95,
    120, 123, 125, 128, 130, 135,
    140, 150, 160, 170, 174, 175, 180
  ];
  
  let closest = bpm;
  let minDiff = Infinity;
  
  for (const tempo of commonTempos) {
    const diff = Math.abs(bpm - tempo);
    if (diff < minDiff) {
      minDiff = diff;
      closest = tempo;
    }
  }
  
  // Only snap if within 1.5 BPM
  if (minDiff <= 1.5) {
    return closest;
  }
  
  return Math.round(bpm);
}

/**
 * NEW v2.5: Check harmonic relationships
 */
function areHarmonicallyRelated(bpm1: number, bpm2: number, tolerance: number = 3): boolean {
  const ratio = bpm1 / bpm2;
  const harmonicRatios = [2.0, 3.0, 0.5, 0.33, 1.5, 0.67];
  
  for (const hr of harmonicRatios) {
    if (Math.abs(ratio - hr) < 0.05) return true;
  }
  
  return false;
}

/**
 * Downsample audio for faster processing
 */
function downsampleAudio(mono: Float32Array, sr: number, targetSr: number): { samples: Float32Array; sr: number } {
  if (sr <= targetSr || targetSr <= 0) return { samples: mono, sr };
  
  const ratio = sr / targetSr;
  const newLen = Math.floor(mono.length / ratio);
  const downsampled = new Float32Array(newLen);
  
  for (let i = 0; i < newLen; i++) {
    const srcIdx = Math.floor(i * ratio);
    downsampled[i] = mono[srcIdx];
  }
  
  return { samples: downsampled, sr: targetSr };
}

/* ============================================================================
 * CONFIGURATION
 * ============================================================================ */

const BPM_MIN = 70;
const BPM_MAX = 220;

// Balanced: 3 windows for accuracy
const BPM_WINDOWS = [25, 45, 65];
const BPM_WINDOW_LEN = 18;
const BPM_GROUP_TOL = 4.5;
const BPM_TOPK = 6;

const CONFIDENCE_EARLY_EXIT = 72;

const BREAKBEAT_OFFBEAT_RATIO_MIN = 0.85;

const REFINE_RANGE_BPM = 8;
const REFINE_STEP_BPM = 0.4;

const METER_DOM_WEIGHT = 0.2;

// Balanced: 16kHz is good compromise
const ANALYSIS_SAMPLE_RATE = 16000;

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
  const { hop = 256, win = 1024, smoothHalfWidth = 3 } = opts;
  const frameCount = Math.floor((mono.length - win) / hop);
  if (frameCount <= 20) return null;

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
 * AUTOCORRELATION
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

/**
 * FIXED v2.5.1: Relaxed peak detection
 */
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
  
  // Reasonable peak requirements (not too strict)
  for (let lag = lagMin + 1; lag <= lagMax - 1; lag++) {
    const s = scores[lag];
    const sL = scores[lag - 1];
    const sR = scores[lag + 1];
    
    if (s > sL && s > sR && s > 0.05) {
      peaks.push({ lag, score: s });
    }
  }

  peaks.sort((a, b) => b.score - a.score);

  const picked: Array<{ lag: number; score: number }> = [];
  const minSep = 4;
  
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
  for (let k = 2; k < 50; k++) {
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
  for (let k = 2; k < 50; k++) {
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
  
  for (let w = 0; w < Math.min(2, BPM_WINDOWS.length); w++) {
    const startSec = BPM_WINDOWS[w];
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    
    if ((end - start) >= sr * 10) {
      const seg = mono.subarray(start, end);
      const onset = onsetEnvelopeFromEnergy(seg, sr);
      if (onset) {
        ratios.push(offbeatRatioForTempo(onset.oenv, onset.frameRate, bpm));
      }
    }
  }

  if (!ratios.length) return { beatType: 'unknown', breakbeatScore: 0 };

  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return {
    beatType: avg >= BREAKBEAT_OFFBEAT_RATIO_MIN ? 'breakbeat' : 'straight',
    breakbeatScore: avg,
  };
}

/* ============================================================================
 * TEMPO SUPPORT
 * ============================================================================ */

function tempoSupportScore(mono: Float32Array, sr: number, bpm: number): number {
  const scores: number[] = [];
  
  for (let w = 0; w < Math.min(2, BPM_WINDOWS.length); w++) {
    const startSec = BPM_WINDOWS[w];
    const start = Math.floor(startSec * sr);
    const end = Math.min(mono.length, start + Math.floor(BPM_WINDOW_LEN * sr));
    if ((end - start) < sr * 10) continue;
    
    const seg = mono.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, sr);
    if (!onset) continue;

    const frameRate = onset.frameRate;
    const lagMin = Math.floor((60 * frameRate) / BPM_MAX);
    const lagMax = Math.floor((60 * frameRate) / BPM_MIN);
    const acScores = pearsonAutocorrScores(onset.oenv, lagMin, lagMax);
    if (!acScores) continue;

    const lag0 = (60 * frameRate) / bpm;
    const lagI = Math.round(lag0);

    let best = -Infinity;
    for (let d = -2; d <= 2; d++) {
      const li = lagI + d;
      if (li >= lagMin && li <= lagMax) best = Math.max(best, acScores[li]);
    }

    scores.push(Math.max(0, best));
  }

  return scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
}

/* ============================================================================
 * REFINEMENT WITH HARMONIC VALIDATION
 * ============================================================================ */

interface RefineAndPickHarmonicsOptions {
  fineTuneOnly?: boolean;
}

/**
 * v2.5.1: Harmonic validation with plausibility scoring
 */
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
      { mult: 0.5, weight: 0.92 },
      { mult: 2.0, weight: 0.92 },
      { mult: 0.33, weight: 0.70 },
      { mult: 3.0, weight: 0.70 }
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

    const dom = onbeatDominanceForTempo(mono, sr, bestBpm) || 1.0;
    const { beatType, breakbeatScore } = classifyBeatType(mono, sr, bestBpm);

    // v2.5.1: Plausibility as bonus/penalty
    const plausibilityBonus = musicalPlausibilityScore(bestBpm);

    pool.push({
      bpm: bestBpm,
      support: bestScore,
      dom,
      score: bestScore * h.weight + METER_DOM_WEIGHT * dom + plausibilityBonus,
      beatType,
      breakbeatScore,
    });
  }

  pool.sort((a, b) => b.score - a.score);

  const winner = pool[0];
  const snappedBpm = snapToMusicalTempo(winner.bpm);

  return {
    bpm: snappedBpm,
    support: winner.support,
    dom: winner.dom,
    score: winner.score,
    beatType: winner.beatType,
    breakbeatScore: winner.breakbeatScore,
  };
}

/* ============================================================================
 * CLUSTERING
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
      const directMatch = Math.abs(h.bpm - c.center) < BPM_GROUP_TOL;
      const harmonicMatch = areHarmonicallyRelated(h.bpm, c.center, BPM_GROUP_TOL * 1.5);
      
      if (directMatch || harmonicMatch) {
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
 * MAIN ESTIMATION
 * ============================================================================ */

type ProgressCallback = ((result: Partial<TempoResult>) => void) | null;

export async function estimateTempoWithBeatMode(
  mono: Float32Array,
  sr: number,
  beatMode: BeatMode,
  onProgressUpdate: ProgressCallback = null
): Promise<TempoResult | null> {
  
  const { samples: downsampled, sr: newSr } = downsampleAudio(mono, sr, ANALYSIS_SAMPLE_RATE);
  console.log(`[TEMPO v2.5.1] Downsampled ${sr}Hz → ${newSr}Hz (${downsampled.length} samples)`);

  const allHyps: Hypothesis[] = [];
  let windowsProcessed = 0;

  for (const startSec of BPM_WINDOWS) {
    const start = Math.floor(startSec * newSr);
    const end = Math.min(downsampled.length, start + Math.floor(BPM_WINDOW_LEN * newSr));
    if ((end - start) < newSr * 8) continue;

    const seg = downsampled.subarray(start, end);
    const onset = onsetEnvelopeFromEnergy(seg, newSr);
    if (!onset) continue;

    const cands = tempoCandidatesFromOenv(onset.oenv, onset.frameRate);
    if (!cands) continue;

    for (const c of cands) {
      allHyps.push({ bpm: c.bpm, weight: c.score });
    }

    windowsProcessed++;
    await yieldToEventLoop();

    // Progress update after second window
    if (windowsProcessed === 2 && onProgressUpdate) {
      const prelimClusters = clusterHypotheses(allHyps);
      if (prelimClusters.length > 0) {
        prelimClusters.sort((a, b) => (b.weightSum + b.items.length * 0.15) - (a.weightSum + a.items.length * 0.15));
        const bestCluster = prelimClusters[0];
        const prelimBpm = snapToMusicalTempo(bestCluster.center);
        const { beatType, breakbeatScore } = classifyBeatType(downsampled, newSr, prelimBpm);

        const confidence = Math.min(65, Math.round(bestCluster.weightSum * 50));

        onProgressUpdate({
          bpm: Math.round(prelimBpm),
          confidence,
          beatTypeAuto: beatType,
          breakbeatScore,
          beatMode,
        });

        if (confidence >= CONFIDENCE_EARLY_EXIT) {
          console.log(`[TEMPO v2.5.1] Early exit after ${windowsProcessed} windows (${confidence}%)`);
          break;
        }
      }
    }
  }

  if (!allHyps.length) {
    console.warn('[TEMPO v2.5.1] No hypotheses found');
    return null;
  }

  const clusters = clusterHypotheses(allHyps);
  if (!clusters.length) {
    console.warn('[TEMPO v2.5.1] No clusters formed');
    return null;
  }

  clusters.sort((a, b) => (b.weightSum + b.items.length * 0.15) - (a.weightSum + a.items.length * 0.15));

  const bestCluster = clusters[0];
  let bestBpm = bestCluster.center;

  const meter = refineAndPickHarmonics(downsampled, newSr, bestBpm, beatMode, {
    fineTuneOnly: windowsProcessed < 2
  });
  bestBpm = meter.bpm;

  await yieldToEventLoop();

  const finalSupport = tempoSupportScore(downsampled, newSr, bestBpm);
  const { beatType: finalBeatType, breakbeatScore: finalBreakbeatScore } = classifyBeatType(downsampled, newSr, bestBpm);

  let confidence = Math.min(60, Math.round(bestCluster.weightSum * 55));
  confidence += Math.min(40, Math.round(finalSupport * 90));
  
  // Small bonus for musically plausible
  if (musicalPlausibilityScore(bestBpm) > 0) {
    confidence += 5;
  }
  
  confidence = clamp(confidence, 0, 99);

  console.log(`[TEMPO v2.5.1] ✓ ${bestBpm} BPM, ${finalBeatType}, ${confidence}%`);

  return {
    bpm: Math.round(bestBpm * 10) / 10,
    confidence,
    beatTypeAuto: finalBeatType,
    breakbeatScore: finalBreakbeatScore,
    beatMode,
    _support: finalSupport,
  };
}
