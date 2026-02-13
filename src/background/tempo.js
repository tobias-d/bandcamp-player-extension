function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function foldIntoRange(bpm, minBpm, maxBpm) {
  let x = bpm;
  while (x < minBpm) x *= 2;
  while (x > maxBpm) x /= 2;
  return x;
}

function safeLog1p(x) {
  return Math.log(1 + Math.max(0, x));
}

/* ----------------- Tunables (TRULY FORCED) ----------------- */
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

/* ----------------- Onset envelope ----------------- */
function onsetEnvelopeFromEnergy(mono, sr, opts = {}) {
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

function pearsonAutocorrScores(oenv, lagMin, lagMax) {
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

function parabolicRefine(scores, lag) {
  if (lag < 1 || lag > scores.length - 2) return lag;

  const sL = scores[lag - 1];
  const s0 = scores[lag];
  const sR = scores[lag + 1];

  const denom = (sL - 2 * s0 + sR);
  if (Math.abs(denom) < 1e-12) return lag;

  const offset = 0.5 * (sL - sR) / denom;
  return lag + clamp(offset, -1, 1);
}

function tempoCandidatesFromOenv(oenv, frameRate, opts = {}) {
  const { minBpm = BPM_MIN, maxBpm = BPM_MAX, topK = BPM_TOPK } = opts;

  const lagMin = Math.floor((60 * frameRate) / maxBpm);
  const lagMax = Math.floor((60 * frameRate) / minBpm);

  if (lagMax <= lagMin + 8) return null;

  const scores = pearsonAutocorrScores(oenv, lagMin, lagMax);
  if (!scores) return null;

  const peaks = [];
  for (let lag = lagMin + 1; lag <= lagMax - 1; lag++) {
    const s = scores[lag];
    if (s > scores[lag - 1] && s > scores[lag + 1]) peaks.push({ lag, score: s });
  }

  peaks.sort((a, b) => b.score - a.score);

  const picked = [];
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

function offbeatRatioForTempo(oenv, frameRate, bpm) {
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

function onbeatDominanceForTempo(oenv, frameRate, bpm) {
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

function classifyBeatType(mono, sr, bpm) {
  const ratios = [];

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

function tempoSupportScore(mono, sr, bpm) {
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

function avgOnbeatDominance(mono, sr, bpm) {
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

// NEW: Fine-tune only (no harmonic checking)
function fineTuneOnly(mono, sr, bpm0) {
  if (!Number.isFinite(bpm0) || bpm0 <= 0) return bpm0;

  const base = foldIntoRange(bpm0, BPM_MIN, BPM_MAX);
  let bestBpm = base;
  let bestSupport = tempoSupportScore(mono, sr, base);

  // ONLY fine-tune around the given BPM, NO harmonic checking
  for (let d = -REFINE_RANGE_BPM; d <= REFINE_RANGE_BPM + 1e-9; d += REFINE_STEP_BPM) {
    const b = base + d;
    if (b < BPM_MIN || b > BPM_MAX) continue;

    const s = tempoSupportScore(mono, sr, b);
    if (s > bestSupport) {
      bestSupport = s;
      bestBpm = b;
    }
  }

  return bestBpm;
}

function refineBpmBySupport(mono, sr, bpm0) {
  if (!Number.isFinite(bpm0) || bpm0 <= 0) return bpm0;

  const base = foldIntoRange(bpm0, BPM_MIN, BPM_MAX);
  let bestBpm = base;
  let bestSupport = tempoSupportScore(mono, sr, base);

  const harmonics = [
    { bpm: foldIntoRange(base * 0.5, BPM_MIN, BPM_MAX), factor: 0.5 },
    { bpm: foldIntoRange(base * 2.0, BPM_MIN, BPM_MAX), factor: 2.0 },
    { bpm: foldIntoRange(base * (2/3), BPM_MIN, BPM_MAX), factor: 2/3 },
    { bpm: foldIntoRange(base * (3/2), BPM_MIN, BPM_MAX), factor: 3/2 },
  ];

  for (const h of harmonics) {
    if (Math.abs(h.bpm - base) < 3) continue;
    const hSupport = tempoSupportScore(mono, sr, h.bpm);

    if (hSupport > bestSupport) {
      bestBpm = h.bpm;
      bestSupport = hSupport;
    }
  }

  for (let d = -REFINE_RANGE_BPM; d <= REFINE_RANGE_BPM + 1e-9; d += REFINE_STEP_BPM) {
    const b = bestBpm + d;
    if (b < BPM_MIN || b > BPM_MAX) continue;

    const s = tempoSupportScore(mono, sr, b);
    if (s > bestSupport) {
      bestSupport = s;
      bestBpm = b;
    }
  }

  return bestBpm;
}

function addHypothesis(hyps, bpm, weight) {
  if (!Number.isFinite(bpm)) return;

  const b = foldIntoRange(bpm, BPM_MIN, BPM_MAX);
  if (b < BPM_MIN || b > BPM_MAX) return;

  hyps.push({ bpm: b, weight });
}

function clusterHypotheses(allHyps) {
  const clusters = [];

  for (const h of allHyps) {
    let placed = false;
    for (const cl of clusters) {
      if (Math.abs(cl.center - h.bpm) <= BPM_GROUP_TOL) {
        cl.items.push(h);
        const wsum = cl.items.reduce((a, x) => a + x.weight, 0) || 1;
        cl.center = cl.items.reduce((a, x) => a + x.bpm * x.weight, 0) / wsum;
        cl.weightSum = wsum;
        placed = true;
        break;
      }
    }

    if (!placed) {
      clusters.push({ center: h.bpm, items: [h], weightSum: h.weight });
    }
  }

  clusters.sort((a, b) => (b.weightSum + b.items.length * 0.15) - (a.weightSum + a.items.length * 0.15));
  return clusters;
}

function buildTempoClusters(mono, sr, onProgressUpdate = null) {
  const hyps = [];
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
      addHypothesis(hyps, c.bpm, c.score);
      addHypothesis(hyps, c.bpm * 0.5, c.score * 0.85);
      addHypothesis(hyps, c.bpm * 2.0, c.score * 0.85);
      addHypothesis(hyps, c.bpm * (3 / 2), c.score * 0.82);
      addHypothesis(hyps, c.bpm * (2 / 3), c.score * 0.82);
      addHypothesis(hyps, c.bpm * (4 / 3), c.score * 0.78);
      addHypothesis(hyps, c.bpm * (3 / 4), c.score * 0.78);
    }

    windowsProcessed++;

    if (windowsProcessed === 2 && hyps.length >= 4 && typeof onProgressUpdate === 'function') {
      try {
        const quickClusters = clusterHypotheses([...hyps]);
        if (quickClusters && quickClusters.length) {
          const quickBpm = foldIntoRange(quickClusters[0].center, BPM_MIN, BPM_MAX);
          onProgressUpdate({
            bpm: quickBpm,
            confidence: 65,
            preliminary: true,
          });
        }
      } catch (_) {}
    }
  }

  if (!hyps.length) return null;

  const clusters = clusterHypotheses(hyps);
  return clusters.length ? clusters : null;
}

function computeConfidence(mono, sr, bpm, clusters) {
  const topSupport = tempoSupportScore(mono, sr, bpm);

  const alts = [
    foldIntoRange(bpm * 0.5, BPM_MIN, BPM_MAX),
    foldIntoRange(bpm * 2.0, BPM_MIN, BPM_MAX),
    foldIntoRange(bpm * (2 / 3), BPM_MIN, BPM_MAX),
    foldIntoRange(bpm * (3 / 2), BPM_MIN, BPM_MAX),
  ].filter((b) => Math.abs(b - bpm) > 1);

  const altSupport = alts.length ? Math.max(...alts.map((b) => tempoSupportScore(mono, sr, b)), 0) : 0;
  const margin = topSupport - altSupport;

  let closest = clusters?.[0] || null;
  let bestD = Infinity;

  for (const cl of clusters || []) {
    const d = Math.abs(cl.center - bpm);
    if (d < bestD) {
      bestD = d;
      closest = cl;
    }
  }

  const agreement = clamp(((closest?.items?.length || 0) / BPM_WINDOWS.length) * 55, 0, 55);
  const marginConf = clamp(margin * 70, 0, 45);

  return clamp(agreement + marginConf, 0, 99);
}

function smoothstep(x, edge0, edge1) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function breakbeatPrior(bpm) {
  const up = smoothstep(bpm, 120, 140);
  const down = 1 - smoothstep(bpm, 190, 205);
  const band = clamp(Math.min(up, down), 0, 1);
  const slowPenalty = 1 - 0.50 * smoothstep(bpm, 90, 115);
  return (0.55 + 0.45 * band) * slowPenalty;
}

function straightPrior(bpm) {
  const up = smoothstep(bpm, 112, 120);
  const down = 1 - smoothstep(bpm, 150, 162);
  const band = clamp(Math.min(up, down), 0, 1);
  return 0.35 + 0.65 * band;
}

function pickInitialBpmFromClusters(clusters, mode) {
  let best = clusters[0];
  let bestScore = -Infinity;

  for (const cl of clusters) {
    const prior = mode === 'breakbeat' ? breakbeatPrior(cl.center) : straightPrior(cl.center);
    const score = (cl.weightSum + cl.items.length * 0.15) * prior;

    if (score > bestScore) {
      bestScore = score;
      best = cl;
    }
  }

  return foldIntoRange(best.center, BPM_MIN, BPM_MAX);
}

function meterEvidence(mono, sr, bpm) {
  const support = tempoSupportScore(mono, sr, bpm);
  const dom = avgOnbeatDominance(mono, sr, bpm);
  const beat = classifyBeatType(mono, sr, bpm);
  const score = support * (1 + METER_DOM_WEIGHT * safeLog1p(dom));

  return {
    bpm,
    support,
    dom,
    score,
    beatType: beat.beatType,
    breakbeatScore: beat.breakbeatScore,
  };
}

function maybePreferFasterMeter(mono, sr, clusters, bpm0, beatMode) {
  const bpm = foldIntoRange(bpm0, BPM_MIN, BPM_MAX);
  const base = meterEvidence(mono, sr, bpm);

  if (bpm >= FAST_DOUBLE_SRC_MIN && bpm <= FAST_DOUBLE_SRC_MAX) {
    const b2 = foldIntoRange(bpm * 2, BPM_MIN, BPM_MAX);
    if (b2 >= FAST_DOUBLE_DST_MIN && b2 <= FAST_DOUBLE_DST_MAX) {
      const cand = meterEvidence(mono, sr, b2);
      const ok =
        cand.support >= base.support * FAST_DOUBLE_SUPPORT_RATIO ||
        cand.score >= base.score * 0.98;

      if (ok) return refineBpmBySupport(mono, sr, b2);
    }
  }

  if (bpm >= FAST_3OVER2_SRC_MIN && bpm <= FAST_3OVER2_SRC_MAX) {
    const b32 = foldIntoRange(bpm * (3 / 2), BPM_MIN, BPM_MAX);
    if (b32 >= FAST_3OVER2_DST_MIN && b32 <= FAST_3OVER2_DST_MAX) {
      const cand = meterEvidence(mono, sr, b32);
      const candLooksBreakbeat =
        cand.beatType === 'breakbeat' || cand.breakbeatScore >= BREAKBEAT_OFFBEAT_RATIO_MIN;

      const isBreakbeatMode = beatMode === 'breakbeat';
      const ratio = (candLooksBreakbeat || isBreakbeatMode)
        ? FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT
        : FAST_3OVER2_SUPPORT_RATIO;

      const breakbeatImproved = (cand.breakbeatScore - base.breakbeatScore) >= 0.06;

      const ok =
        cand.support >= base.support * ratio ||
        (breakbeatImproved && cand.support >= base.support * FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT_IMPROVED) ||
        cand.score >= base.score * 0.98;

      if (ok) return refineBpmBySupport(mono, sr, b32);
    }
  }

  return bpm;
}

function maybePromoteBreakbeat3over2(mono, sr, bpm0, beatMode) {
  const slow = foldIntoRange(bpm0, BPM_MIN, BPM_MAX);
  const fast = foldIntoRange(slow * (3 / 2), BPM_MIN, BPM_MAX);

  if (!(slow >= 85 && slow <= 130)) return slow;
  if (!(fast >= 135 && fast <= 195)) return slow;

  const beatSlow = classifyBeatType(mono, sr, slow);
  const beatFast = classifyBeatType(mono, sr, fast);

  const sSlow = tempoSupportScore(mono, sr, slow);
  const sFast = tempoSupportScore(mono, sr, fast);

  const fastLooksBreakbeat =
    beatFast.beatType === 'breakbeat' || beatFast.breakbeatScore >= BREAKBEAT_OFFBEAT_RATIO_MIN;

  const breakbeatImproved = (beatFast.breakbeatScore - beatSlow.breakbeatScore) >= 0.06;

  const ratio = (beatMode === 'breakbeat' || fastLooksBreakbeat)
    ? FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT
    : FAST_3OVER2_SUPPORT_RATIO;

  const ok =
    sFast >= sSlow * ratio ||
    (breakbeatImproved && sFast >= sSlow * FAST_3OVER2_SUPPORT_RATIO_BREAKBEAT_IMPROVED);

  if (ok) return refineBpmBySupport(mono, sr, fast);

  return slow;
}

// TRULY FORCED: Uses fineTuneOnly (no harmonic checking)
function forcedHalftimeCorrection(mono, sr, bpm) {
  // If BPM is 100-115, FORCE promote to 1.5× and fine-tune WITHOUT harmonic checking
  if (bpm >= 100 && bpm <= 115) {
    const promoted = foldIntoRange(bpm * 1.5, BPM_MIN, BPM_MAX);
    if (promoted >= 150 && promoted <= 175) {
      // Use fineTuneOnly to prevent reverting to slow tempo
      return fineTuneOnly(mono, sr, promoted);
    }
  }

  // If BPM is 85-100, check if 1.5× lands in reasonable range
  if (bpm >= 85 && bpm < 100) {
    const promoted = foldIntoRange(bpm * 1.5, BPM_MIN, BPM_MAX);
    if (promoted >= 128 && promoted <= 150) {
      // Use fineTuneOnly to prevent reverting
      return fineTuneOnly(mono, sr, promoted);
    }
  }

  return bpm;
}

function solveForMode(mono, sr, clusters, mode) {
  let bpm = pickInitialBpmFromClusters(clusters, mode);
  bpm = refineBpmBySupport(mono, sr, bpm);

  if (mode === 'breakbeat') {
    bpm = maybePromoteBreakbeat3over2(mono, sr, bpm, mode);
  }

  if (mode === 'breakbeat' && Number.isFinite(bpm)) {
    const bpmHalf = bpm;
    if (bpmHalf >= DNB_HALFTIME_MIN && bpmHalf <= DNB_HALFTIME_MAX) {
      const bpmFast = foldIntoRange(bpmHalf * (3 / 2), BPM_MIN, BPM_MAX);
      if (bpmFast >= DNB_RANGE_MIN && bpmFast <= DNB_RANGE_MAX) {
        const beatHalf = classifyBeatType(mono, sr, bpmHalf);
        const beatFast = classifyBeatType(mono, sr, bpmFast);

        const beatOk =
          beatHalf.beatType === 'breakbeat' ||
          beatFast.beatType === 'breakbeat' ||
          beatHalf.breakbeatScore >= BREAKBEAT_OFFBEAT_RATIO_MIN ||
          beatFast.breakbeatScore >= BREAKBEAT_OFFBEAT_RATIO_MIN;

        if (beatOk) {
          const supportHalf = tempoSupportScore(mono, sr, bpmHalf);
          const supportFast = tempoSupportScore(mono, sr, bpmFast);

          if (supportFast >= supportHalf * DNB_SUPPORT_RATIO) {
            bpm = refineBpmBySupport(mono, sr, bpmFast);
          }
        }
      }
    }
  }

  bpm = maybePreferFasterMeter(mono, sr, clusters, bpm, mode);

  // TRULY FORCED: Apply correction with no harmonic reverting
  bpm = forcedHalftimeCorrection(mono, sr, bpm);

  const confidence = computeConfidence(mono, sr, bpm, clusters);
  const beat = classifyBeatType(mono, sr, bpm);

  return {
    bpm,
    confidence,
    beatTypeAuto: beat.beatType,
    breakbeatScore: beat.breakbeatScore,
    beatMode: mode,
    _support: tempoSupportScore(mono, sr, bpm),
  };
}

export function estimateTempoWithBeatMode(mono, sr, beatMode, onProgressUpdate = null) {
  const clusters = buildTempoClusters(mono, sr, onProgressUpdate);
  if (!clusters) return null;

  const mode = (beatMode === 'straight' || beatMode === 'breakbeat' || beatMode === 'auto') ? beatMode : 'auto';

  if (mode === 'straight') {
    const r = solveForMode(mono, sr, clusters, 'straight');
    delete r._support;
    return r;
  }

  if (mode === 'breakbeat') {
    const r = solveForMode(mono, sr, clusters, 'breakbeat');
    delete r._support;
    return r;
  }

  const straightRes = solveForMode(mono, sr, clusters, 'straight');
  const breakRes = solveForMode(mono, sr, clusters, 'breakbeat');

  let res = straightRes;
  if (breakRes.confidence > straightRes.confidence) res = breakRes;
  else if (breakRes.confidence === straightRes.confidence && breakRes._support > straightRes._support) res = breakRes;

  delete res._support;
  return res;
}
