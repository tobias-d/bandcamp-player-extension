import type { AnalysisResult, KeyAnalysisResult } from '@/shared/types';
import {
  ANALYSIS_CACHE_MAX_ENTRIES,
  ANALYSIS_CACHE_STORAGE_KEY,
  ANALYSIS_CACHE_TTL_MS,
  ANALYSIS_DECODED_AUDIO_MAX_ENTRIES,
  ANALYSIS_DECODED_AUDIO_TTL_MS,
  ANALYSIS_PERSIST_TTL_MS,
  ANALYSIS_VERSION
} from '@/shared/constants';
import { browserApi } from '@/utils/browser-api';
import { TTLCache } from '@/utils/cache';
import { createLogger } from '@/utils/debug';

const logger = createLogger('ANALYZER');

interface PersistedAnalysisCacheEntry {
  cacheKey: string;
  result: AnalysisResult;
}

interface PersistedAnalysisCachePayload {
  version: string;
  savedAt: number;
  entries: PersistedAnalysisCacheEntry[];
}

interface DecodedAudioCacheEntry {
  audioBuffer: AudioBuffer;
  completeness: 'partial' | 'full';
  resolvedUrl: string;
}

const analysisCache = new TTLCache<string, AnalysisResult>(ANALYSIS_CACHE_TTL_MS, ANALYSIS_CACHE_MAX_ENTRIES);
const keyAnalysisCache = new TTLCache<string, KeyAnalysisResult>(ANALYSIS_CACHE_TTL_MS, ANALYSIS_CACHE_MAX_ENTRIES);
const decodedAudioCache = new TTLCache<string, DecodedAudioCacheEntry>(ANALYSIS_DECODED_AUDIO_TTL_MS, ANALYSIS_DECODED_AUDIO_MAX_ENTRIES);
const analysisInFlight = new Map<string, Promise<AnalysisResult>>();
const keyAnalysisInFlight = new Map<string, Promise<KeyAnalysisResult>>();
const decodeInFlight = new Map<string, Promise<DecodedAudioCacheEntry>>();

let persistedLoadPromise: Promise<void> | null = null;
let persistFlushTimer: ReturnType<typeof setTimeout> | null = null;
let persistWriteChain: Promise<void> = Promise.resolve();
let cacheEpoch = 0;

export function getAnalysisCacheEpoch(): number {
  return cacheEpoch;
}

function getStorageArea(): chrome.storage.StorageArea | null {
  return browserApi.storage?.local || browserApi.storage?.sync || null;
}

function storageGet<T>(key: string): Promise<T | null> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    area.get(key, (result) => {
      resolve((result?.[key] as T) ?? null);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    area.set({ [key]: value }, () => resolve());
  });
}

function storageRemove(key: string): Promise<void> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    area.remove(key, () => resolve());
  });
}

function isKeyAnalysisLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.topKeys)
    && Array.isArray(record.segments)
    && Number.isFinite(record.windowsAnalyzed)
    && Number.isFinite(record.windowsTotal)
    && Number.isFinite(record.reliability)
    && record.method === 'essentia-hpcp-key';
}

export function reviveAnalysisResult(raw: unknown): AnalysisResult | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const ts = Number(record.ts);
  if (!Number.isFinite(ts) || ts <= 0) {
    return null;
  }

  const result: AnalysisResult = {
    bpm: Number.isFinite(record.bpm) ? Number(record.bpm) : undefined,
    confidence: Number.isFinite(record.confidence) ? Number(record.confidence) : undefined,
    tempoRawConfidence: Number.isFinite(record.tempoRawConfidence) ? Number(record.tempoRawConfidence) : undefined,
    tempoDecisionConfidence: Number.isFinite(record.tempoDecisionConfidence) ? Number(record.tempoDecisionConfidence) : undefined,
    beatTypeAuto:
      record.beatTypeAuto === 'straight' || record.beatTypeAuto === 'breakbeat' || record.beatTypeAuto === 'unknown'
        ? record.beatTypeAuto
        : undefined,
    breakbeatScore: Number.isFinite(record.breakbeatScore) ? Number(record.breakbeatScore) : undefined,
    analysisStatus: typeof record.analysisStatus === 'string' ? record.analysisStatus : undefined,
    analysisMs: Number.isFinite(record.analysisMs) ? Number(record.analysisMs) : undefined,
    analysisFetchMs: Number.isFinite(record.analysisFetchMs) ? Number(record.analysisFetchMs) : undefined,
    analysisDecodeMs: Number.isFinite(record.analysisDecodeMs) ? Number(record.analysisDecodeMs) : undefined,
    analysisTempoMs: Number.isFinite(record.analysisTempoMs) ? Number(record.analysisTempoMs) : undefined,
    waveform: record.waveform && typeof record.waveform === 'object' ? (record.waveform as AnalysisResult['waveform']) : undefined,
    waveformStatus: typeof record.waveformStatus === 'string' ? record.waveformStatus : undefined,
    waveformMs: Number.isFinite(record.waveformMs) ? Number(record.waveformMs) : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    tempoDebugBaseBpm: Number.isFinite(record.tempoDebugBaseBpm) ? Number(record.tempoDebugBaseBpm) : undefined,
    tempoDebugSummary: typeof record.tempoDebugSummary === 'string' ? record.tempoDebugSummary : undefined,
    tempoDebugGate: typeof record.tempoDebugGate === 'string' ? record.tempoDebugGate : undefined,
    tempoDebugCandidates: Array.isArray(record.tempoDebugCandidates)
      ? record.tempoDebugCandidates
        .filter((candidate) => candidate && typeof candidate === 'object')
        .map((candidate) => {
          const entry = candidate as Record<string, unknown>;
          return {
            bpm: Number(entry.bpm) || 0,
            label: typeof entry.label === 'string' ? entry.label : '',
            score: Number(entry.score) || 0
          };
        })
        .filter((candidate) => candidate.bpm > 0 && candidate.label)
      : undefined,
    keyStatus:
      record.keyStatus === 'disabled'
      || record.keyStatus === 'pending-bpm'
      || record.keyStatus === 'analyzing'
      || record.keyStatus === 'ready'
      || record.keyStatus === 'empty'
      || record.keyStatus === 'error'
        ? record.keyStatus
        : undefined,
    ts
  };

  if (isKeyAnalysisLike(record.keyAnalysis)) {
    result.keyAnalysis = record.keyAnalysis as KeyAnalysisResult;
  }

  return result;
}

async function writePersistedSnapshot(): Promise<void> {
  const flushEpoch = cacheEpoch;
  const now = Date.now();
  const entries = analysisCache.entries()
    .filter(([, entry]) => now - entry.ts <= ANALYSIS_PERSIST_TTL_MS)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, ANALYSIS_CACHE_MAX_ENTRIES)
    .map(([cacheKey, entry]) => ({
      cacheKey,
      result: (() => {
        const { sourceUrl: _sourceUrl, resolvedAudioUrl: _resolvedAudioUrl, ...persisted } = entry.value;
        return persisted;
      })()
    }));

  const payload: PersistedAnalysisCachePayload = {
    version: ANALYSIS_VERSION,
    savedAt: now,
    entries
  };

  if (flushEpoch !== cacheEpoch) {
    return;
  }

  await storageSet(ANALYSIS_CACHE_STORAGE_KEY, payload);
}

// Serialize writes so a debounced flush and an awaited durable flush can never
// interleave and clobber each other. Each queued write rebuilds the snapshot at
// execution time, so it always persists the latest in-memory state.
function enqueuePersistedWrite(): Promise<void> {
  persistWriteChain = persistWriteChain
    .catch(() => undefined)
    .then(() => writePersistedSnapshot())
    .catch((error) => {
      logger.warn('analysis cache flush failed', error);
    });
  return persistWriteChain;
}

function schedulePersistedCacheFlush(): void {
  if (persistFlushTimer) {
    return;
  }

  persistFlushTimer = setTimeout(() => {
    persistFlushTimer = null;
    void enqueuePersistedWrite();
  }, 200);
}

// Chrome MV3 service workers can be torn down ~30s after going idle, before a
// debounced flush fires. The Chrome analysis path awaits this so the entry is
// durable on disk before the handler returns and the worker is allowed to
// suspend. Firefox's persistent background keeps using the debounced path.
export async function flushPersistedCacheNow(): Promise<void> {
  if (persistFlushTimer) {
    clearTimeout(persistFlushTimer);
    persistFlushTimer = null;
  }
  await enqueuePersistedWrite();
}

async function ensurePersistedCacheLoaded(): Promise<void> {
  if (persistedLoadPromise) {
    return persistedLoadPromise;
  }

  persistedLoadPromise = (async () => {
    const loadEpoch = cacheEpoch;
    try {
      const payload = await storageGet<PersistedAnalysisCachePayload>(ANALYSIS_CACHE_STORAGE_KEY);
      if (!payload || !Array.isArray(payload.entries)) {
        return;
      }
      if (loadEpoch !== cacheEpoch) {
        return;
      }

      const now = Date.now();
      for (const entry of payload.entries) {
        if (loadEpoch !== cacheEpoch) {
          return;
        }
        if (!entry || typeof entry.cacheKey !== 'string') {
          continue;
        }
        if (!entry.cacheKey.includes(`|${ANALYSIS_VERSION}`)) {
          continue;
        }

        const revived = reviveAnalysisResult(entry.result);
        if (!revived) {
          continue;
        }
        if (now - revived.ts > ANALYSIS_PERSIST_TTL_MS) {
          continue;
        }
        analysisCache.set(entry.cacheKey, revived);
      }
    } catch (error) {
      logger.warn('analysis cache load failed', error);
    }
  })();

  return persistedLoadPromise;
}

export function getStableTrackCacheId(rawUrl: string): string {
  const url = String(rawUrl || '').trim();
  if (!url) {
    return '';
  }

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

export function resolveAnalysisCacheIdentity(url: string, explicitCacheKey?: string): string {
  const explicit = String(explicitCacheKey || '').trim();
  if (explicit) {
    return explicit;
  }
  const stableTrack = getStableTrackCacheId(url);
  return stableTrack || String(url || '').trim();
}

export function buildAnalysisCacheKey(cacheIdentity: string): string {
  return `${cacheIdentity}|${ANALYSIS_VERSION}`;
}

export async function getCachedAnalysis(cacheKey: string): Promise<AnalysisResult | null> {
  await ensurePersistedCacheLoaded();
  return analysisCache.get(cacheKey) ?? null;
}

export async function setCachedAnalysis(
  cacheKey: string,
  result: AnalysisResult,
  options?: { durable?: boolean }
): Promise<void> {
  await ensurePersistedCacheLoaded();
  analysisCache.set(cacheKey, result);
  if (options?.durable) {
    await flushPersistedCacheNow();
  } else {
    schedulePersistedCacheFlush();
  }
}

export async function clearAllAnalysisCaches(): Promise<void> {
  cacheEpoch += 1;
  if (persistFlushTimer) {
    clearTimeout(persistFlushTimer);
    persistFlushTimer = null;
  }

  analysisCache.clear();
  keyAnalysisCache.clear();
  decodedAudioCache.clear();
  analysisInFlight.clear();
  keyAnalysisInFlight.clear();
  decodeInFlight.clear();
  persistedLoadPromise = null;

  await storageRemove(ANALYSIS_CACHE_STORAGE_KEY);
}

export function getInFlightAnalysis(cacheKey: string): Promise<AnalysisResult> | null {
  return analysisInFlight.get(cacheKey) ?? null;
}

export function setInFlightAnalysis(cacheKey: string, promise: Promise<AnalysisResult>): void {
  analysisInFlight.set(cacheKey, promise);
}

export function clearInFlightAnalysis(cacheKey: string): void {
  analysisInFlight.delete(cacheKey);
}

export function getInFlightKeyAnalysis(cacheKey: string): Promise<KeyAnalysisResult> | null {
  return keyAnalysisInFlight.get(cacheKey) ?? null;
}

export function setInFlightKeyAnalysis(cacheKey: string, promise: Promise<KeyAnalysisResult>): void {
  keyAnalysisInFlight.set(cacheKey, promise);
}

export function clearInFlightKeyAnalysis(cacheKey: string): void {
  keyAnalysisInFlight.delete(cacheKey);
}

export function getCachedKeyAnalysis(cacheKey: string): KeyAnalysisResult | null {
  return keyAnalysisCache.get(cacheKey) ?? null;
}

export function setCachedKeyAnalysis(cacheKey: string, result: KeyAnalysisResult): void {
  keyAnalysisCache.set(cacheKey, result);
}

export function setDecodedAudio(
  cacheIdentity: string,
  audioBuffer: AudioBuffer,
  completeness: 'partial' | 'full' = 'full',
  resolvedUrl = ''
): void {
  decodedAudioCache.set(cacheIdentity, {
    audioBuffer,
    completeness,
    resolvedUrl: String(resolvedUrl || '').trim()
  });
}

export function getCachedDecodedAudio(
  cacheIdentity: string
): { audioBuffer: AudioBuffer; completeness: 'partial' | 'full'; resolvedUrl: string } | null {
  const cached = decodedAudioCache.get(cacheIdentity);
  if (!cached) {
    return null;
  }
  return {
    audioBuffer: cached.audioBuffer,
    completeness: cached.completeness,
    resolvedUrl: typeof cached.resolvedUrl === 'string' ? cached.resolvedUrl : ''
  };
}

export function getDecodedAudioState(
  cacheIdentity: string
): 'cached-full' | 'cached-partial' | 'in-flight' | 'missing' {
  const cached = decodedAudioCache.get(cacheIdentity);
  if (cached) {
    return cached.completeness === 'full' ? 'cached-full' : 'cached-partial';
  }
  if (decodeInFlight.has(cacheIdentity)) {
    return 'in-flight';
  }
  return 'missing';
}

export function getDecodedAudioInFlightCount(): number {
  return decodeInFlight.size;
}

export interface AnalysisCacheStats {
  analysisEntries: number;
  keyEntries: number;
  decodedEntries: number;
  decodedBytes: number;
  analysisInFlight: number;
  keyInFlight: number;
  decodeInFlight: number;
}

// Resource-diagnostics snapshot of the analysis caches. Counts and byte totals only — no keys,
// URLs, paths, or identity — so it is safe to surface in the debug panel and its exports.
export function getAnalysisCacheStats(): AnalysisCacheStats {
  let decodedBytes = 0;
  for (const [, entry] of decodedAudioCache.entries()) {
    const buffer = entry.value.audioBuffer;
    decodedBytes += buffer.length * buffer.numberOfChannels * 4;
  }
  return {
    analysisEntries: analysisCache.entries().length,
    keyEntries: keyAnalysisCache.entries().length,
    decodedEntries: decodedAudioCache.entries().length,
    decodedBytes,
    analysisInFlight: analysisInFlight.size,
    keyInFlight: keyAnalysisInFlight.size,
    decodeInFlight: decodeInFlight.size
  };
}

export async function getOrCreateDecodedAudio(
  cacheIdentity: string,
  factory: () => Promise<DecodedAudioCacheEntry>,
  options?: { requireFull?: boolean; inFlightKey?: string }
): Promise<DecodedAudioCacheEntry> {
  const requireFull = Boolean(options?.requireFull);
  const dedupeKey = String(options?.inFlightKey || '').trim() || cacheIdentity;
  const cached = decodedAudioCache.get(cacheIdentity);
  if (cached && (!requireFull || cached.completeness === 'full')) {
    return cached;
  }

  const inFlight = decodeInFlight.get(dedupeKey);
  if (inFlight) {
    const resolved = await inFlight;
    if (!requireFull || resolved.completeness === 'full') {
      return resolved;
    }
  }

  const promise = factory()
    .then((entry) => {
      const existing = decodedAudioCache.get(cacheIdentity);
      if (!existing || entry.completeness === 'full' || existing.completeness !== 'full') {
        decodedAudioCache.set(cacheIdentity, entry);
      }
      return decodedAudioCache.get(cacheIdentity) ?? entry;
    })
    .finally(() => {
      decodeInFlight.delete(dedupeKey);
    });

  decodeInFlight.set(dedupeKey, promise);
  return promise;
}
