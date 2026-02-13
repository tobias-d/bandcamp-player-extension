/**
 * ============================================================================
 * AUDIO ANALYSIS ORCHESTRATOR
 * ============================================================================
 * 
 * High-level coordinator for complete track analysis.
 * Orchestrates BPM detection and waveform generation with caching.
 * 
 * WORKFLOW:
 * 1. Check cache for previous results
 * 2. Fetch audio file from URL
 * 3. Decode audio to PCM samples
 * 4. Mix to mono and prepare for analysis
 * 5. Estimate BPM with selected beat mode
 * 6. Generate waveform asynchronously (non-blocking)
 * 7. Send progressive updates to UI via callback
 * 8. Cache results for 6 hours
 * 
 * CACHING STRATEGY:
 * - Cache key includes URL, version, and beat mode
 * - 6-hour TTL balances memory usage vs re-analysis cost
 * - In-flight tracking prevents duplicate concurrent analysis
 * 
 * PROGRESSIVE UPDATES:
 * - Sends preliminary BPM during analysis
 * - Sends final BPM immediately when ready
 * - Generates waveform asynchronously to avoid blocking
 * 
 * @module background/analyzer
 * @version 2026-02-13-truly-forced-v1
 */

import { decodeAudio, mixToMono } from './audio.js';
import { computeWaveformBands } from './waveform.js';
import { estimateTempoWithBeatMode } from './tempo.js';

/**
 * Analysis version - increment to invalidate cache when algorithm changes
 */
const ANALYSIS_VERSION = '2026-02-13-truly-forced-v1';

/**
 * In-memory cache for analysis results (URL -> result)
 */
const cache = new Map();

/**
 * Tracks in-flight analysis promises to prevent duplicates
 */
const inFlight = new Map();

/**
 * Safely call update callback with error handling
 * 
 * @param {function} onUpdate - Callback function
 * @param {object} partial - Partial update data
 */
function safeCallUpdate(onUpdate, partial) {
  if (typeof onUpdate !== 'function') return;
  try {
    onUpdate({ ...partial, ts: Date.now() });
  } catch (_) {}
}

/**
 * Analyze audio track from URL
 * 
 * ANALYSIS PIPELINE:
 * 1. Fetch audio file
 * 2. Decode to PCM samples
 * 3. Mix to mono (8-128 seconds)
 * 4. Estimate BPM with beat classification
 * 5. Generate 3-band waveform (async)
 * 
 * BEAT MODES:
 * - 'auto': Automatically choose straight vs breakbeat
 * - 'straight': Four-on-the-floor (house, techno)
 * - 'breakbeat': Syncopated beats (drum & bass, jungle)
 * 
 * @param {string} url - Audio file URL
 * @param {string} beatMode - Beat detection mode ('auto', 'straight', 'breakbeat')
 * @param {function} onUpdate - Progress callback for UI updates
 * @returns {Promise<object>} Analysis result with BPM, confidence, waveform
 * 
 * @example
 * const result = await analyzeUrl(
 *   'https://example.com/track.mp3',
 *   'auto',
 *   (update) => console.log('Progress:', update)
 * );
 * console.log('BPM:', result.bpm, 'Confidence:', result.confidence);
 */
export async function analyzeUrl(url, beatMode = 'auto', onUpdate = null) {
  // Validate beat mode
  const mode = ['auto', 'straight', 'breakbeat'].includes(beatMode) ? beatMode : 'auto';
  const cacheKey = `${url}|${ANALYSIS_VERSION}|${mode}`;

  // Check cache (6-hour TTL)
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 6 * 60 * 60 * 1000) {
    safeCallUpdate(onUpdate, cached);
    return cached;
  }

  // Return existing in-flight promise if analysis already started
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  // Start new analysis
  const p = (async () => {
    // Fetch audio file
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();

    // Decode audio
    const audioBuffer = await decodeAudio(arrayBuffer);

    // Mix to mono and extract segment (8-128 seconds)
    const { mono, sr } = mixToMono(audioBuffer, { startSeconds: 8, maxSeconds: 120 });

    // Progress callback for preliminary BPM
    const onProgressBpm = (partial) => {
      if (partial.preliminary) {
        safeCallUpdate(onUpdate, {
          bpm: partial.bpm,
          confidence: partial.confidence,
          note: 'Preliminary BPM (validating…)',
        });
      }
    };

    // Estimate BPM
    const tempo = estimateTempoWithBeatMode(mono, sr, mode, onProgressBpm);

    // Handle BPM detection failure
    if (!tempo?.bpm) {
      const out = {
        error: 'Could not estimate BPM',
        beatMode: mode,
        bpm: null,
        confidence: 0,
        waveform: null,
        waveformStatus: 'Waveform deferred',
        ts: Date.now(),
      };
      cache.set(cacheKey, out);
      safeCallUpdate(onUpdate, out);
      return out;
    }

    // BPM detected - prepare result
    const out = {
      bpm: tempo.bpm,
      confidence: tempo.confidence,
      beatMode: tempo.beatMode,
      beatTypeAuto: tempo.beatTypeAuto,
      breakbeatScore: tempo.breakbeatScore,
      waveform: null,
      waveformStatus: 'Computing waveform…',
      note: 'BPM ready; waveform pending.',
      ts: Date.now(),
    };
    cache.set(cacheKey, out);
    safeCallUpdate(onUpdate, out);

    // Generate waveform asynchronously (non-blocking)
    setTimeout(() => {
      computeWaveformBands(audioBuffer)
        .then((wf) => {
          out.waveform = wf;
          out.waveformStatus = '';
          out.note = '';
          out.ts = Date.now();
          cache.set(cacheKey, out);
          safeCallUpdate(onUpdate, { waveform: wf, waveformStatus: '', note: out.note });
        })
        .catch((e) => {
          out.waveform = null;
          out.waveformStatus = `Waveform failed: ${e?.message || String(e)}`;
          out.ts = Date.now();
          cache.set(cacheKey, out);
          safeCallUpdate(onUpdate, { waveformStatus: out.waveformStatus });
        });
    }, 0);

    return out;
  })().finally(() => inFlight.delete(cacheKey));

  // Track in-flight promise
  inFlight.set(cacheKey, p);
  return p;
}
