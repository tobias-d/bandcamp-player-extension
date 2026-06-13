import type { WaveformBands } from '@/shared/types';

// Low/mid crossover (Hz), matching the open-source Mixxx reference. Below this is the
// bass body; the steep filters below give clean separation from the mid band.
const LOW_MID_HZ = 600;
// Mid/high crossover. Set high (sizzle range) so the high band isolates hi-hats/cymbals,
// which are near-silent except where they play — that near-zero floor is what lets those
// sections rise out distinctly. Lower values scoop up always-on >4 kHz pad/reverb texture
// and wash the high band into a flat ribbon. Raise toward ~9 kHz for sparser highs.
const MID_HIGH_HZ = 7000;
// Per-band visual weights applied before normalization. The bands stack from the
// baseline (low at the bottom, high on top), so these control how much each band
// contributes to the silhouette. HIGH_WEIGHT is the main tuning knob for how far hi-hats
// poke up; it is large because the narrow sizzle band carries little energy, so it needs
// boosting to be visible where it does fire.
const LOW_WEIGHT = 1.0;
const MID_WEIGHT = 1.4;
const HIGH_WEIGHT = 4.0;
// Contrast exponent for the high band, applied around its own peak (see below). >1 pushes
// the faint ever-present sizzle "floor" down toward zero while leaving the loudest hi-hat
// buckets at full height, so peaks stand out instead of riding on a constant floor. This
// is the knob for "non-peak spots too prominent"; raise it to flatten the floor more.
const HIGH_CONTRAST_EXP = 2.5;
// Waveform rendering needs a stable visual summary, not a sample-perfect offline render,
// but we MUST process at (near) full sample rate: anything below ~2x MID_HIGH_HZ throws
// the high band away to aliasing. This cap only engages for pathologically long inputs
// (e.g. >~20 min mixes) to keep the background thread responsive; normal tracks run
// un-decimated.
const MAX_SAMPLES_PER_BUCKET = 200_000;

// One biquad section (Direct Form I). We cascade two of these per crossover to get a
// 4th-order Butterworth response (24 dB/octave) — far steeper than the previous one-pole
// (6 dB/octave) filters, which bled mid energy into the high band and washed it out.
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

// Q values for the two cascaded biquad sections of a 4th-order Butterworth lowpass,
// i.e. 1/(2·cos θ) for the standard pole angles 22.5° and 67.5°.
const BUTTERWORTH_4_Q = [0.54119610, 1.30656296];

function makeLowpassBiquad(cutoffHz: number, sampleRate: number, q: number): Biquad {
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(omega);
  const sin = Math.sin(omega);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;

  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0
  };
}

function processBiquad(state: Biquad, input: number): number {
  const output =
    state.b0 * input +
    state.b1 * state.x1 +
    state.b2 * state.x2 -
    state.a1 * state.y1 -
    state.a2 * state.y2;

  state.x2 = state.x1;
  state.x1 = input;
  state.y2 = state.y1;
  state.y1 = output;
  return output;
}

// A 4th-order Butterworth lowpass = two cascaded biquads with the Butterworth Q pair.
function makeLowpass4(cutoffHz: number, sampleRate: number): [Biquad, Biquad] {
  return [
    makeLowpassBiquad(cutoffHz, sampleRate, BUTTERWORTH_4_Q[0]),
    makeLowpassBiquad(cutoffHz, sampleRate, BUTTERWORTH_4_Q[1])
  ];
}

function processLowpass4(sections: [Biquad, Biquad], input: number): number {
  return processBiquad(sections[1], processBiquad(sections[0], input));
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function buildEmptyWaveform(bucketCount: number, durationSec: number): WaveformBands {
  const buckets = Math.max(1, bucketCount);
  return {
    peaksLow: new Array(buckets).fill(0),
    peaksMid: new Array(buckets).fill(0),
    peaksHigh: new Array(buckets).fill(0),
    duration: Number.isFinite(durationSec) ? durationSec : 0,
    buckets
  };
}

interface BandLevels {
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

// Normalize all three bands by one shared scale: the loudest stacked sum (low+mid+high)
// across buckets. This maps the loudest moment to full height and keeps the bands in a
// common space so the stack reads correctly. A single shared scale (rather than
// per-band) preserves cross-track and cross-section loudness — a quiet intro stays short.
function sharedNormalize(bands: BandLevels): WaveformBands {
  const length = bands.low.length;
  let maxSum = 1e-9;
  for (let index = 0; index < length; index += 1) {
    const sum = bands.low[index] + bands.mid[index] + bands.high[index];
    if (sum > maxSum) {
      maxSum = sum;
    }
  }

  const inv = 1 / maxSum;
  const peaksLow: number[] = new Array(length);
  const peaksMid: number[] = new Array(length);
  const peaksHigh: number[] = new Array(length);

  for (let index = 0; index < length; index += 1) {
    peaksLow[index] = clamp01(bands.low[index] * inv);
    peaksMid[index] = clamp01(bands.mid[index] * inv);
    peaksHigh[index] = clamp01(bands.high[index] * inv);
  }

  return {
    peaksLow,
    peaksMid,
    peaksHigh,
    duration: 0,
    buckets: length
  };
}

function computeBucketedBandLevels(audioBuffer: AudioBuffer, bucketCount: number): BandLevels {
  const sampleRate = audioBuffer.sampleRate;
  const frameCount = audioBuffer.length;
  const channelCount = Math.max(1, audioBuffer.numberOfChannels);
  const maxProcessedSamples = Math.max(bucketCount, bucketCount * MAX_SAMPLES_PER_BUCKET);
  const stride = Math.max(1, Math.ceil(frameCount / maxProcessedSamples));
  // The biquad coefficients are computed for the rate we actually step at, so a strided
  // (long-track) pass stays correctly tuned.
  const effectiveSampleRate = sampleRate / stride;

  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channelData.push(audioBuffer.getChannelData(channel));
  }

  // Complementary split via two lowpasses: low = LP(LOW_MID), mid = LP(MID_HIGH) - LP(LOW_MID),
  // high = signal - LP(MID_HIGH). low + mid + high reconstructs the signal exactly.
  const lowpassLow = makeLowpass4(LOW_MID_HZ, effectiveSampleRate);
  const lowpassMid = makeLowpass4(MID_HIGH_HZ, effectiveSampleRate);

  // All bands use RMS (average energy). What makes hi-hats stand out is NOT the measure
  // (peak just grabbed always-present pad/reverb texture in this ambient track) but the
  // crossover: MID_HIGH_HZ sits in the "sizzle" range, near-silent except where hats/
  // cymbals play, so those sections rise out of a near-zero floor.
  const lowSumSq = new Float64Array(bucketCount);
  const midSumSq = new Float64Array(bucketCount);
  const highSumSq = new Float64Array(bucketCount);
  const bucketSampleCounts = new Uint32Array(bucketCount);

  for (let index = 0; index < frameCount; index += stride) {
    let mono = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      mono += channelData[channel]?.[index] || 0;
    }
    mono /= channelCount;

    const lp600 = processLowpass4(lowpassLow, mono);
    const lpHigh = processLowpass4(lowpassMid, mono);
    const lowVal = lp600;
    const midVal = lpHigh - lp600;
    const highVal = mono - lpHigh;

    const bucket = Math.min(bucketCount - 1, Math.floor((index * bucketCount) / Math.max(1, frameCount)));

    lowSumSq[bucket] += lowVal * lowVal;
    midSumSq[bucket] += midVal * midVal;
    highSumSq[bucket] += highVal * highVal;
    bucketSampleCounts[bucket] += 1;
  }

  const low = new Float32Array(bucketCount);
  const mid = new Float32Array(bucketCount);
  const high = new Float32Array(bucketCount);

  let highRmsMax = 1e-9;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const sampleCount = Math.max(1, bucketSampleCounts[bucket] || 0);
    low[bucket] = Math.sqrt(lowSumSq[bucket] / sampleCount) * LOW_WEIGHT;
    mid[bucket] = Math.sqrt(midSumSq[bucket] / sampleCount) * MID_WEIGHT;
    const highRms = Math.sqrt(highSumSq[bucket] / sampleCount);
    high[bucket] = highRms; // contrast + weight applied in the second pass below
    if (highRms > highRmsMax) {
      highRmsMax = highRms;
    }
  }

  // Contrast the high band around its own peak: scale to 0..1 by the loudest hi-hat
  // bucket, raise to HIGH_CONTRAST_EXP (floor → ~0, peak stays at 1), restore the absolute
  // scale, then weight. Anchoring at the peak is what keeps loud hi-hats full height while
  // only the floor drops — unlike a blind gamma, which would crush the peaks too.
  const invHighRmsMax = 1 / highRmsMax;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const norm = high[bucket] * invHighRmsMax;
    high[bucket] = Math.pow(norm, HIGH_CONTRAST_EXP) * highRmsMax * HIGH_WEIGHT;
  }

  return { low, mid, high };
}

export function computeWaveformBands(audioBuffer: AudioBuffer, buckets: number): WaveformBands {
  const bucketCount = Math.max(24, Math.min(1024, Math.floor(buckets)));
  if (!audioBuffer.length) {
    return buildEmptyWaveform(bucketCount, audioBuffer.duration);
  }

  const bands = computeBucketedBandLevels(audioBuffer, bucketCount);
  const normalized = sharedNormalize(bands);
  normalized.duration = Number.isFinite(audioBuffer.duration) ? audioBuffer.duration : 0;
  normalized.buckets = bucketCount;
  return normalized;
}
