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

import { decodeAudio } from './audio';
import { computeAndCacheWaveformForUrlFromAudioBuffer } from './waveform';
import { estimateTempo, estimateTempoConfidence, initEssentia } from './tempo-essentia';
import type { BeatMode, WaveformBands } from '../shared/index';

const ANALYSIS_VERSION = '2026-02-16-v2.4-essentia';
const ANALYSIS_TTL_MS = 6 * 60 * 60 * 1000;
const PERSISTED_CACHE_STORAGE_KEY = '__BC_ANALYSIS_CACHE_V1__';
const PERSISTED_CACHE_MAX_ENTRIES = 200;
const PERSISTED_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
export interface AnalyzeOptions {
  signal?: AbortSignal | null;
  cacheIdentity?: string | null;
}

const cache = new Map<string, AnalysisResult>();
const inFlight = new Map<string, Promise<AnalysisResult>>();
let persistedLoadPromise: Promise<void> | null = null;
let persistFlushTimer: ReturnType<typeof setTimeout> | null = null;
let persistFlushInFlight = false;

interface PersistedCacheEntry {
  cacheKey: string;
  result: AnalysisResult;
}

interface PersistedCachePayload {
  version: string;
  savedAt: number;
  entries: PersistedCacheEntry[];
}

function getStorageArea(): chrome.storage.StorageArea | null {
  const runtimeApi: any = (typeof chrome !== 'undefined' ? chrome : (globalThis as any).browser);
  return runtimeApi?.storage?.local || runtimeApi?.storage?.sync || null;
}

function storageGet<T = any>(key: string): Promise<T | null> {
  const area = getStorageArea();
  if (!area) return Promise.resolve(null);

  return new Promise((resolve) => {
    area.get(key, (res) => {
      resolve((res?.[key] as T) ?? null);
    });
  });
}

function storageSet(key: string, value: any): Promise<void> {
  const area = getStorageArea();
  if (!area) return Promise.resolve();

  return new Promise((resolve) => {
    area.set({ [key]: value }, () => resolve());
  });
}

function isAbortError(error: unknown): boolean {
  const name = (error as any)?.name;
  return name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) return;
  throw new DOMException('Analysis aborted', 'AbortError');
}

function normalizeBeatMode(mode: unknown): BeatMode {
  return mode === 'auto' || mode === 'straight' || mode === 'breakbeat' ? mode : 'auto';
}

function getStableTrackCacheId(rawUrl: string): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';

  try {
    const parsed = new URL(url);
    const haystack = `${parsed.pathname}${parsed.search}`;
    const digitRuns = haystack.match(/\d{6,}/g);
    const lastId = digitRuns?.[digitRuns.length - 1];
    if (lastId) {
      return `${parsed.hostname}|id:${lastId}`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function reviveAnalysisResult(raw: any): AnalysisResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;

  return {
    bpm: Number.isFinite(raw.bpm) ? Number(raw.bpm) : undefined,
    confidence: Number.isFinite(raw.confidence) ? Number(raw.confidence) : Number.NaN,
    beatMode: normalizeBeatMode(raw.beatMode),
    beatTypeAuto: typeof raw.beatTypeAuto === 'string' ? raw.beatTypeAuto : undefined,
    breakbeatScore: Number.isFinite(raw.breakbeatScore) ? Number(raw.breakbeatScore) : undefined,
    waveform: raw.waveform && typeof raw.waveform === 'object' ? (raw.waveform as WaveformBands) : null,
    waveformStatus: typeof raw.waveformStatus === 'string' ? raw.waveformStatus : '',
    note: typeof raw.note === 'string' ? raw.note : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    ts,
  };
}

function isFresh(result: AnalysisResult, now: number): boolean {
  return (now - result.ts) < ANALYSIS_TTL_MS;
}

async function ensurePersistedCacheLoaded(): Promise<void> {
  if (persistedLoadPromise) return persistedLoadPromise;

  persistedLoadPromise = (async () => {
    try {
      const payload = await storageGet<PersistedCachePayload>(PERSISTED_CACHE_STORAGE_KEY);
      if (!payload || !Array.isArray(payload.entries)) return;

      const now = Date.now();
      for (const entry of payload.entries) {
        if (!entry || typeof entry.cacheKey !== 'string') continue;
        if (!entry.cacheKey.includes(`|${ANALYSIS_VERSION}`)) continue;
        const revived = reviveAnalysisResult(entry.result);
        if (!revived) continue;
        if ((now - revived.ts) > PERSISTED_CACHE_TTL_MS) continue;
        cache.set(entry.cacheKey, revived);
      }
    } catch (error) {
      console.warn('[ANALYZER] Failed to load persisted cache:', error);
    }
  })();

  return persistedLoadPromise;
}

function schedulePersistedCacheFlush(): void {
  if (persistFlushTimer) return;
  persistFlushTimer = setTimeout(() => {
    persistFlushTimer = null;
    void flushPersistedCache();
  }, 200);
}

async function flushPersistedCache(): Promise<void> {
  if (persistFlushInFlight) return;
  persistFlushInFlight = true;
  try {
    const now = Date.now();
    const entries = Array.from(cache.entries())
      .filter(([, result]) => Number.isFinite(result?.ts) && (now - result.ts) < PERSISTED_CACHE_TTL_MS)
      .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0))
      .slice(0, PERSISTED_CACHE_MAX_ENTRIES)
      .map(([cacheKey, result]) => ({
        cacheKey,
        result,
      }));

    const payload: PersistedCachePayload = {
      version: ANALYSIS_VERSION,
      savedAt: now,
      entries,
    };
    await storageSet(PERSISTED_CACHE_STORAGE_KEY, payload);
  } catch (error) {
    console.warn('[ANALYZER] Failed to flush persisted cache:', error);
  } finally {
    persistFlushInFlight = false;
  }
}

function safeCallUpdate(onUpdate: UpdateCallback | null | undefined, partial: Partial<AnalysisResult>): void {
  if (typeof onUpdate !== 'function') return;
  try {
    onUpdate({ ...partial, ts: Date.now() });
  } catch (_) {
    // Silently ignore callback errors
  }
}

function scheduleWaveformComputation(
  params: {
    url: string;
    audioBuffer: AudioBuffer;
    cacheKey: string;
    out: AnalysisResult;
    signal?: AbortSignal | null;
    onUpdate?: UpdateCallback | null;
  }
): void {
  const { url, audioBuffer, cacheKey, out, signal, onUpdate } = params;

  setTimeout(() => {
    if (signal?.aborted) return;
    computeAndCacheWaveformForUrlFromAudioBuffer(url, audioBuffer)
      .then((wf: WaveformBands) => {
        if (signal?.aborted) return;
        out.waveform = wf;
        out.waveformStatus = '';
        out.ts = Date.now();
        cache.set(cacheKey, out);
        schedulePersistedCacheFlush();
        safeCallUpdate(onUpdate, { waveform: wf, waveformStatus: '', note: out.note });
      })
      .catch((e: any) => {
        if (signal?.aborted) return;
        console.error('[ANALYZER] Waveform generation failed:', e);
        out.waveform = null;
        out.waveformStatus = `Waveform failed: ${e?.message || String(e)}`;
        out.ts = Date.now();
        cache.set(cacheKey, out);
        schedulePersistedCacheFlush();
        safeCallUpdate(onUpdate, { waveformStatus: out.waveformStatus });
      });
  }, 0);
}

export async function analyzeUrl(
  url: string,
  beatMode: BeatMode = 'auto',
  onUpdate: UpdateCallback | null = null,
  options: AnalyzeOptions = {}
): Promise<AnalysisResult> {
  await ensurePersistedCacheLoaded();

  const signal = options?.signal || null;
  const mode: BeatMode = ['auto', 'straight', 'breakbeat'].includes(beatMode) ? beatMode : 'auto';
  const explicitCacheId = typeof options?.cacheIdentity === 'string' ? options.cacheIdentity.trim() : '';
  const stableTrackId = getStableTrackCacheId(url);
  const cacheIdentity = explicitCacheId || stableTrackId || url;
  const cacheKey = `${cacheIdentity}|${ANALYSIS_VERSION}`;
  const now = Date.now();

  const cached = cache.get(cacheKey);
  if (cached && isFresh(cached, now)) {
    const adjusted = { ...cached, beatMode: mode };
    safeCallUpdate(onUpdate, adjusted);
    return adjusted;
  }

  const canUseSharedInFlight = !signal;
  if (canUseSharedInFlight && inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey)!;
  }

  const p = (async (): Promise<AnalysisResult> => {
    try {
      throwIfAborted(signal);
      safeCallUpdate(onUpdate, {
        note: 'Fetching audio…',
        confidence: 0,
        beatMode: mode,
        waveform: null,
        waveformStatus: 'Pending',
        ts: Date.now(),
      });

      const res = await fetch(url, signal ? { signal } : undefined);
      if (!res.ok) {
        throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      throwIfAborted(signal);

      safeCallUpdate(onUpdate, {
        note: 'Decoding audio…',
        confidence: 0,
      });

      const audioBuffer = await decodeAudio(arrayBuffer);
      throwIfAborted(signal);

      safeCallUpdate(onUpdate, {
        note: 'Preparing audio…',
        confidence: 0,
      });

      safeCallUpdate(onUpdate, {
        note: 'Estimating BPM with Essentia…',
        confidence: 0,
      });

      let tempo;
      try {
        throwIfAborted(signal);
        await initEssentia();
        
        const essentiaResult = await estimateTempo(audioBuffer, {
          method: 'percival',
          minBpm: 70,
          maxBpm: 170,
          targetMinBpm: 70,
          targetMaxBpm: 170,
          preferFasterAmbiguous: true,
          includeConfidence: false,
        });
        
        tempo = {
          bpm: essentiaResult.bpm,
          beatMode: mode,
          beatTypeAuto: essentiaResult.beatTypeAuto,
          breakbeatScore: undefined
        };
        throwIfAborted(signal);
        
        safeCallUpdate(onUpdate, {
          bpm: tempo.bpm,
          confidence: Number.NaN,
          beatTypeAuto: tempo.beatTypeAuto,
          note: `BPM: ${tempo.bpm}`,
        });
        
      } catch (tempoError) {
        if (isAbortError(tempoError)) {
          throw tempoError;
        }
        console.error('[ANALYZER] Essentia tempo estimation failed:', tempoError);
        tempo = null;
      }

      if (!tempo?.bpm) {
        const out: AnalysisResult = {
          error: 'Could not estimate BPM with Essentia',
          beatMode: mode,
          confidence: 0,
          waveform: null,
          waveformStatus: 'Computing waveform…',
          note: 'BPM unavailable',
          ts: Date.now(),
        };
        cache.set(cacheKey, out);
        schedulePersistedCacheFlush();
        safeCallUpdate(onUpdate, out);
        scheduleWaveformComputation({ url, audioBuffer, cacheKey, out, signal, onUpdate });

        return out;
      }

      const out: AnalysisResult = {
        bpm: tempo.bpm,
        confidence: Number.NaN,
        beatMode: tempo.beatMode,
        beatTypeAuto: tempo.beatTypeAuto,
        breakbeatScore: tempo.breakbeatScore,
        waveform: null,
        waveformStatus: 'Computing waveform…',
        note: `BPM: ${tempo.bpm} - Essentia`,
        ts: Date.now(),
      };

      cache.set(cacheKey, out);
      schedulePersistedCacheFlush();
      safeCallUpdate(onUpdate, out);

      setTimeout(() => {
        if (signal?.aborted) return;
        estimateTempoConfidence(audioBuffer, { minBpm: 70, maxBpm: 170 })
          .then((confidence: number) => {
            if (signal?.aborted) return;
            out.confidence = confidence;
            out.ts = Date.now();
            cache.set(cacheKey, out);
            schedulePersistedCacheFlush();
            safeCallUpdate(onUpdate, {
              confidence,
              note: `BPM: ${tempo.bpm} (${confidence}% confidence)`,
            });
          })
          .catch((e: any) => {
            console.error('[ANALYZER] Confidence estimation failed:', e);
          });
      }, 0);

      scheduleWaveformComputation({ url, audioBuffer, cacheKey, out, signal, onUpdate });

      return out;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
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
      schedulePersistedCacheFlush();
      safeCallUpdate(onUpdate, errorResult);
      return errorResult;
    }
  })().finally(() => {
    if (canUseSharedInFlight) inFlight.delete(cacheKey);
  });

  if (canUseSharedInFlight) {
    inFlight.set(cacheKey, p);
  }
  return p;
}
