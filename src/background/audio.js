/**
 * ============================================================================
 * AUDIO PROCESSING UTILITIES
 * ============================================================================
 * 
 * Low-level audio processing functions for decoding, mixing, and filtering.
 * These functions prepare audio data for BPM analysis and waveform generation.
 * 
 * KEY OPERATIONS:
 * - Decode compressed audio (MP3, AAC, etc.) to raw PCM samples
 * - Mix multi-channel audio to mono
 * - Remove DC offset and normalize amplitude
 * - Apply high-pass filtering
 * 
 * WHY MONO MIXING:
 * BPM detection works on rhythmic patterns, which are identical across channels.
 * Mixing to mono reduces computational load without losing tempo information.
 * 
 * WHY DC REMOVAL & NORMALIZATION:
 * - DC offset removal: Prevents analysis artifacts from recording equipment biases
 * - Normalization: Ensures consistent amplitude for reliable onset detection
 * 
 * @module background/audio
 * @version 2026-02-13
 */

/**
 * Decode audio from ArrayBuffer to AudioBuffer
 * Creates and immediately closes AudioContext to avoid resource leaks.
 * 
 * @param {ArrayBuffer} arrayBuffer - Raw audio file data
 * @returns {Promise<AudioBuffer>} Decoded audio with PCM samples
 * @throws {Error} If AudioContext is unavailable or decoding fails
 */
export async function decodeAudio(arrayBuffer) {
  const Ctor = self.AudioContext || self.webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext unavailable in background');
  const ctx = new Ctor();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } finally {
    if (typeof ctx.close === 'function') {
      try { await ctx.close(); } catch (_) {}
    }
  }
}

/**
 * Mix audio to mono, extract segment, remove DC offset, and normalize
 * 
 * PROCESSING STEPS:
 * 1. Extract time segment (default: skip 8s intro, use up to 160s)
 * 2. Mix all channels to mono by averaging
 * 3. Remove DC offset (mean value) from signal
 * 4. Normalize to range [-1, 1]
 * 
 * WHY SKIP INTRO:
 * Many tracks have intros without drums. Starting at 8s improves analysis.
 * 
 * @param {AudioBuffer} audioBuffer - Decoded audio buffer
 * @param {object} opts - Options object
 * @param {number} opts.startSeconds - Seconds to skip at start (default: 8)
 * @param {number} opts.maxSeconds - Maximum duration to process (default: 160)
 * @returns {object} {mono: Float32Array, sr: number}
 */
export function mixToMono(audioBuffer, opts = {}) {
  const { startSeconds = 8, maxSeconds = 160 } = opts;
  const sr = audioBuffer.sampleRate;
  const chs = audioBuffer.numberOfChannels;
  const start = Math.min(audioBuffer.length, Math.floor(startSeconds * sr));
  const end = Math.min(audioBuffer.length, start + Math.floor(maxSeconds * sr));
  const len = Math.max(0, end - start);
  const mono = new Float32Array(len);

  // Mix channels to mono by averaging
  for (let ch = 0; ch < chs; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) mono[i] += (data[start + i] || 0) / chs;
  }

  // Remove DC offset (mean value)
  let mean = 0;
  for (let i = 0; i < mono.length; i++) mean += mono[i];
  mean /= Math.max(1, mono.length);
  let maxAbs = 1e-9;
  for (let i = 0; i < mono.length; i++) {
    mono[i] -= mean;
    const a = Math.abs(mono[i]);
    if (a > maxAbs) maxAbs = a;
  }

  // Normalize to [-1, 1] range
  const g = 1 / maxAbs;
  for (let i = 0; i < mono.length; i++) mono[i] *= g;
  return { mono, sr };
}

/**
 * Apply 1-pole high-pass filter (removes low-frequency rumble)
 * 
 * ALGORITHM: First-order IIR filter using exponential moving average
 * TRANSFER FUNCTION: H(z) = α(1 - z^-1) / (1 - (1-α)z^-1)
 * 
 * USAGE:
 * Removes sub-bass rumble that can interfere with onset detection.
 * Typical cutoff: 30-50 Hz
 * 
 * @param {Float32Array} x - Input signal
 * @param {number} sr - Sample rate in Hz
 * @param {number} cutoffHz - Cutoff frequency in Hz
 * @returns {Float32Array} Filtered signal
 */
export function highPass1Pole(x, sr, cutoffHz) {
  const out = new Float32Array(x.length);
  if (!Number.isFinite(sr) || sr <= 0 || !Number.isFinite(cutoffHz) || cutoffHz <= 0) {
    out.set(x);
    return out;
  }

  // Calculate filter coefficient
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);
  let yPrev = 0;
  let xPrev = x[0] || 0;

  // Apply filter recursively
  for (let i = 0; i < x.length; i++) {
    const xi = x[i] || 0;
    const yi = alpha * (yPrev + xi - xPrev);
    out[i] = yi;
    yPrev = yi;
    xPrev = xi;
  }

  return out;
}
