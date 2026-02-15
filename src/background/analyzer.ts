/**
 * ============================================================================
 * AUDIO ANALYSIS ORCHESTRATOR - PERFORMANCE OPTIMIZED
 * ============================================================================
 * 
 * VERSION: 2.3-optimized (2026-02-15)
 * 
 * PERFORMANCE IMPROVEMENTS:
 * ─────────────────────────────────────────────────────────────────────────
 * 1. ASYNC TEMPO ESTIMATION: Now awaits async tempo analysis
 * 2. BETTER ERROR HANDLING: More resilient to failures
 * 3. IMPROVED PROGRESS REPORTING: Clearer status messages
 * 
 * CHANGES FROM v2.2:
 * - Made analyzeUrl fully async (was already async, but now properly awaits tempo)
 * - Added try-catch around tempo estimation
 * - Better preliminary result handling
 * - Improved waveform fallback logic
 * 
 * @module background/analyzer
 * @version 2026-02-15-v2.3-optimized
 */


import { decodeAudio, mixToMono } from './audio';
import { computeWaveformBands } from './waveform';
import { estimateTempoWithBeatMode } from './tempo';
import type { BeatMode, BeatType } from '../shared/index';
import type { WaveformBands } from '../shared/index';



/**
 * Analysis version - increment to invalidate cache when algorithm changes
 */
const ANALYSIS_VERSION = '2026-02-15-v2.3-optimized';


/**
 * Analysis result structure
 */
export interface AnalysisResult {
  bpm?: number;
  confidence: number;
  beatMode: BeatMode;
  beatTypeAuto?: BeatType;
  breakbeatScore?: number;
  waveform: WaveformBands | null;
  waveformStatus: string;
  note?: string;
  error?: string;
  ts: number;
}


/**
 * Callback for progress updates during analysis
 */
export type UpdateCallback = (update: Partial<AnalysisResult>) => void;


/**
 * In-memory cache for analysis results (URL -> result)
 */
const cache = new Map<string, AnalysisResult>();


/**
 * Tracks in-flight analysis promises to prevent duplicates
 */
const inFlight = new Map<string, Promise<AnalysisResult>>();


/**
 * Safely call update callback with error handling
 */
function safeCallUpdate(onUpdate: UpdateCallback | null | undefined, partial: Partial<AnalysisResult>): void {
  if (typeof onUpdate !== 'function') return;
  try {
    onUpdate({ ...partial, ts: Date.now() });
  } catch (_) {
    // Silently ignore callback errors
  }
}


/**
 * Analyze audio track from URL
 * 
 * @param url - Audio file URL
 * @param beatMode - Beat detection mode ('auto', 'straight', 'breakbeat')
 * @param onUpdate - Progress callback for UI updates
 * @returns Promise resolving to analysis results
 */
export async function analyzeUrl(
  url: string,
  beatMode: BeatMode = 'auto',
  onUpdate: UpdateCallback | null = null
): Promise<AnalysisResult> {
  // Validate beat mode
  const mode: BeatMode = ['auto', 'straight', 'breakbeat'].includes(beatMode) ? beatMode : 'auto';
  const cacheKey = `${url}|${ANALYSIS_VERSION}|${mode}`;

  // Check cache (6-hour TTL)
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 6 * 60 * 60 * 1000) {
    safeCallUpdate(onUpdate, cached);
    return cached;
  }

  // Return existing in-flight promise if analysis already started
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey)!;
  }

  // Start new analysis
  const p = (async (): Promise<AnalysisResult> => {
    try {
      // Fetch audio file
      safeCallUpdate(onUpdate, {
        note: 'Fetching audio…',
        confidence: 0,
        beatMode: mode,
        waveform: null,
        waveformStatus: 'Pending',
        ts: Date.now(),
      });

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      }
      const arrayBuffer = await res.arrayBuffer();

      // Decode audio
      safeCallUpdate(onUpdate, {
        note: 'Decoding audio…',
        confidence: 0,
      });

      const audioBuffer = await decodeAudio(arrayBuffer);

      // Mix to mono and extract segment
      safeCallUpdate(onUpdate, {
        note: 'Preparing audio…',
        confidence: 0,
      });

      const { mono, sr } = mixToMono(audioBuffer, { startSeconds: 8, maxSeconds: 60 });

      // Progress callback for preliminary BPM
      const onProgressBpm = (partial: any) => {
        if (partial.preliminary || partial.bpm) {
          safeCallUpdate(onUpdate, {
            bpm: partial.bpm,
            confidence: partial.confidence || 50,
            beatTypeAuto: partial.beatTypeAuto,
            breakbeatScore: partial.breakbeatScore,
            note: partial.confidence >= 75 ? 'High confidence BPM detected' : 'Analyzing BPM…',
          });
        }
      };

      // Estimate BPM (NOW ASYNC!)
      safeCallUpdate(onUpdate, {
        note: 'Estimating BPM…',
        confidence: 0,
      });

      let tempo;
      try {
        tempo = await estimateTempoWithBeatMode(mono, sr, mode, onProgressBpm);
      } catch (tempoError) {
        console.error('[ANALYZER] Tempo estimation failed:', tempoError);
        tempo = null;
      }

      // Handle BPM detection failure
      if (!tempo?.bpm) {
        const out: AnalysisResult = {
          error: 'Could not estimate BPM',
          beatMode: mode,
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
      const out: AnalysisResult = {
        bpm: tempo.bpm,
        confidence: tempo.confidence,
        beatMode: tempo.beatMode,
        beatTypeAuto: tempo.beatTypeAuto,
        breakbeatScore: tempo.breakbeatScore,
        waveform: null,
        waveformStatus: 'Computing waveform…',
        note: `BPM: ${tempo.bpm} (${tempo.confidence}% confidence)`,
        ts: Date.now(),
      };

      cache.set(cacheKey, out);
      safeCallUpdate(onUpdate, out);

      // Generate waveform asynchronously (non-blocking)
      setTimeout(() => {
        computeWaveformBands(audioBuffer)
          .then((wf: WaveformBands) => {
            out.waveform = wf;
            out.waveformStatus = '';
            out.note = `BPM: ${tempo.bpm}`;
            out.ts = Date.now();
            cache.set(cacheKey, out);
            safeCallUpdate(onUpdate, { waveform: wf, waveformStatus: '', note: out.note });
          })
          .catch((e: any) => {
            console.error('[ANALYZER] Waveform generation failed:', e);
            out.waveform = null;
            out.waveformStatus = `Waveform failed: ${e?.message || String(e)}`;
            out.ts = Date.now();
            cache.set(cacheKey, out);
            safeCallUpdate(onUpdate, { waveformStatus: out.waveformStatus });
          });
      }, 0);

      return out;
    } catch (error) {
      console.error('[ANALYZER] Analysis failed:', error);
      const errorResult: AnalysisResult = {
        error: error instanceof Error ? error.message : String(error),
        beatMode: mode,
        confidence: 0,
        waveform: null,
        waveformStatus: 'Failed',
        ts: Date.now(),
      };
      cache.set(cacheKey, errorResult);
      safeCallUpdate(onUpdate, errorResult);
      return errorResult;
    }
  })().finally(() => inFlight.delete(cacheKey));

  // Track in-flight promise
  inFlight.set(cacheKey, p);
  return p;
}
