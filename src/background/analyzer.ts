/**
 * Background audio analysis orchestrator.
 *
 * Responsibilities:
 * - Fetch and decode remote Bandcamp audio URLs
 * - Run BPM estimation through Essentia-based tempo analysis
 * - Compute waveform bands and stream partial progress updates
 * - Cache short-lived analysis results to reduce repeated work
 *
 * Notes:
 * - Designed for extension background context (not page context)
 * - Emits user-facing progress text through `onUpdate`
 *
 * @module background/analyzer
 */

import { decodeAudio, mixToMono } from './audio';
import { computeWaveformBands } from './waveform';
import { estimateTempo, initEssentia } from './tempo-essentia';
import type { BeatMode, WaveformBands } from '../shared/index';

const ANALYSIS_VERSION = '2026-02-16-v2.4-essentia';

export interface AnalysisResult {
  bpm?: number;
  confidence: number;
  beatMode: BeatMode;
  beatTypeAuto?: string;
  breakbeatScore?: number;
  waveform: WaveformBands | null;
  waveformStatus: string;
  note?: string;
  error?: string;
  ts: number;
}

export type UpdateCallback = (update: Partial<AnalysisResult>) => void;

const cache = new Map<string, AnalysisResult>();
const inFlight = new Map<string, Promise<AnalysisResult>>();

function safeCallUpdate(onUpdate: UpdateCallback | null | undefined, partial: Partial<AnalysisResult>): void {
  if (typeof onUpdate !== 'function') return;
  try {
    onUpdate({ ...partial, ts: Date.now() });
  } catch (_) {
    // Silently ignore callback errors
  }
}

export async function analyzeUrl(
  url: string,
  beatMode: BeatMode = 'auto',
  onUpdate: UpdateCallback | null = null
): Promise<AnalysisResult> {
  const mode: BeatMode = ['auto', 'straight', 'breakbeat'].includes(beatMode) ? beatMode : 'auto';
  const cacheKey = `${url}|${ANALYSIS_VERSION}|${mode}`;

  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < 6 * 60 * 60 * 1000) {
    safeCallUpdate(onUpdate, cached);
    return cached;
  }

  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey)!;
  }

  const p = (async (): Promise<AnalysisResult> => {
    try {
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

      safeCallUpdate(onUpdate, {
        note: 'Decoding audio…',
        confidence: 0,
      });

      const audioBuffer = await decodeAudio(arrayBuffer);

      safeCallUpdate(onUpdate, {
        note: 'Preparing audio…',
        confidence: 0,
      });

      const { mono, sr } = mixToMono(audioBuffer, { startSeconds: 8, maxSeconds: 60 });

      safeCallUpdate(onUpdate, {
        note: 'Estimating BPM with Essentia…',
        confidence: 0,
      });

      let tempo;
      try {
        await initEssentia();
        
        const essentiaResult = await estimateTempo(audioBuffer, {
          method: 'percival',
          minBpm: 70,
          maxBpm: 170,
          targetMinBpm: 70,
          targetMaxBpm: 170,
          preferFasterAmbiguous: true,
        });
        
        tempo = {
          bpm: essentiaResult.bpm,
          confidence: essentiaResult.confidence,
          beatMode: mode,
          beatTypeAuto: essentiaResult.beatTypeAuto,
          breakbeatScore: undefined
        };
        
        safeCallUpdate(onUpdate, {
          bpm: tempo.bpm,
          confidence: tempo.confidence,
          beatTypeAuto: tempo.beatTypeAuto,
          note: `BPM: ${tempo.bpm} (${tempo.confidence}% confidence)`,
        });
        
      } catch (tempoError) {
        console.error('[ANALYZER] Essentia tempo estimation failed:', tempoError);
        tempo = null;
      }

      if (!tempo?.bpm) {
        const out: AnalysisResult = {
          error: 'Could not estimate BPM with Essentia',
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

      const out: AnalysisResult = {
        bpm: tempo.bpm,
        confidence: tempo.confidence,
        beatMode: tempo.beatMode,
        beatTypeAuto: tempo.beatTypeAuto,
        breakbeatScore: tempo.breakbeatScore,
        waveform: null,
        waveformStatus: 'Computing waveform…',
        note: `BPM: ${tempo.bpm} (${tempo.confidence}% confidence) - Essentia`,
        ts: Date.now(),
      };

      cache.set(cacheKey, out);
      safeCallUpdate(onUpdate, out);

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

  inFlight.set(cacheKey, p);
  return p;
}
