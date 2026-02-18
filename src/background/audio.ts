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
 * @version 2026-02-15-typescript
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Options for mixing audio to mono
 */
interface MixToMonoOptions {
  startSeconds?: number;
  maxSeconds?: number;
}

/**
 * Result of mixing audio to mono
 */
interface MonoAudioResult {
  mono: Float32Array;
  sr: number;
}

// ============================================================================
// AUDIO DECODING
// ============================================================================

let sharedDecodeContext: AudioContext | null = null;

function getSharedDecodeContext(): AudioContext {
  if (sharedDecodeContext && sharedDecodeContext.state !== 'closed') {
    return sharedDecodeContext;
  }

  const Ctor = (self as any).AudioContext || (self as any).webkitAudioContext;
  if (!Ctor) throw new Error('AudioContext unavailable in background');
  sharedDecodeContext = new Ctor();
  return sharedDecodeContext;
}

/**
 * Decode audio from ArrayBuffer to AudioBuffer
 * Reuses a shared AudioContext to avoid repeated setup/teardown cost.
 * 
 * @param arrayBuffer - Raw audio file data
 * @returns Promise resolving to decoded audio with PCM samples
 * @throws {Error} If AudioContext is unavailable or decoding fails
 */
export async function decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
  let ctx: AudioContext = getSharedDecodeContext();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    // Recover from browser-closing/invalidating the shared context.
    sharedDecodeContext = null;
    ctx = getSharedDecodeContext();
    return await ctx.decodeAudioData(arrayBuffer);
  }
}

// ============================================================================
// AUDIO MIXING & NORMALIZATION
// ============================================================================

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
 * @param audioBuffer - Decoded audio buffer
 * @param opts - Options object
 * @param opts.startSeconds - Seconds to skip at start (default: 8)
 * @param opts.maxSeconds - Maximum duration to process (default: 160)
 * @returns Object containing mono samples and sample rate
 */
export function mixToMono(
  audioBuffer: AudioBuffer,
  opts: MixToMonoOptions = {}
): MonoAudioResult {
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
    for (let i = 0; i < len; i++) {
      mono[i] += (data[start + i] || 0) / chs;
    }
  }

  // Remove DC offset (mean value)
  let mean = 0;
  for (let i = 0; i < mono.length; i++) {
    mean += mono[i];
  }
  mean /= Math.max(1, mono.length);
  
  let maxAbs = 1e-9;
  for (let i = 0; i < mono.length; i++) {
    mono[i] -= mean;
    const a = Math.abs(mono[i]);
    if (a > maxAbs) maxAbs = a;
  }

  // Normalize to [-1, 1] range
  const g = 1 / maxAbs;
  for (let i = 0; i < mono.length; i++) {
    mono[i] *= g;
  }

  return { mono, sr };
}

// ============================================================================
// AUDIO FILTERING
// ============================================================================

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
 * @param x - Input signal
 * @param sr - Sample rate in Hz
 * @param cutoffHz - Cutoff frequency in Hz
 * @returns Filtered signal
 */
export function highPass1Pole(
  x: Float32Array,
  sr: number,
  cutoffHz: number
): Float32Array {
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
