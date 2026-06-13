import type {
  AnalysisResult,
  AnalyzeBpmPrototypeMessage,
  AnalyzeBpmPrototypeResponse,
  AnalyzeKeyDebugMessage,
  AnalyzeKeyDebugResponse,
  ContentMessage,
  WaveformBands
} from '@/shared/types';
import { requestChromeAnalysisHost } from '@/targets/chrome/background/offscreen-manager';
import {
  buildAnalysisCacheKey,
  getCachedAnalysis,
  resolveAnalysisCacheIdentity,
  setCachedAnalysis
} from '@/background/cache';

interface AnalysisErrorResponse {
  error: string;
  ts: number;
}

interface AnalysisCancelledResponse {
  cancelled: boolean;
  ts: number;
}

type AnalyzeTrackResponse = AnalysisResult | AnalysisErrorResponse | AnalysisCancelledResponse;
type AnalyzeKeyResponse =
  | ({
      keyAnalysis: AnalysisResult['keyAnalysis'];
      keyStatus: AnalysisResult['keyStatus'];
      ts: number;
      keyDebugSource?: string;
      keyDebugDetail?: string;
      keyDebugCacheKey?: string;
      keyDebugTimingMs?: number;
      keyDebugDecodeMs?: number;
      keyDebugPreprocessMs?: number;
      keyDebugComputeMs?: number;
    } & AnalysisErrorResponse)
  | AnalysisErrorResponse
  | AnalysisCancelledResponse;

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The offscreen host is pure compute and forgets everything when Chrome reclaims
// the document, so persistence lives here in the service worker — the same
// chrome.storage-backed store Firefox uses. Only a successful analysis (a finite
// BPM, no error, not cancelled) is worth keeping; failures and cancellations stay
// out of the cache so they don't poison future loads.
function isSuccessfulAnalysis(result: AnalyzeTrackResponse): result is AnalysisResult {
  if (!result || typeof result !== 'object') {
    return false;
  }
  if ('cancelled' in result && (result as AnalysisCancelledResponse).cancelled) {
    return false;
  }
  if ('error' in result && (result as AnalysisErrorResponse).error) {
    return false;
  }
  return Number.isFinite((result as AnalysisResult).bpm);
}

async function analyzeTrackPersisted(payload: {
  url?: string;
  fetchUrl?: string;
  cacheKey?: string;
  enableKeyAnalysis?: boolean;
}): Promise<AnalyzeTrackResponse> {
  const url = String(payload.url || '').trim();
  if (!url) {
    return { error: 'ANALYZE_TRACK requires a url', ts: Date.now() };
  }

  const cacheIdentity = resolveAnalysisCacheIdentity(url, payload.cacheKey);
  const cacheKey = buildAnalysisCacheKey(cacheIdentity);

  const cached = await getCachedAnalysis(cacheKey);
  if (cached) {
    return { ...cached, sourceUrl: url, analysisServedBy: 'background-cache' };
  }

  try {
    const response = await requestChromeAnalysisHost<AnalyzeTrackResponse>('ANALYZE_TRACK', {
      url: payload.url,
      fetchUrl: payload.fetchUrl,
      cacheKey: payload.cacheKey,
      enableKeyAnalysis: payload.enableKeyAnalysis
    });
    if (!response.ok) {
      return { error: response.error, ts: Date.now() };
    }
    const result = response.result;
    if (isSuccessfulAnalysis(result)) {
      // Durable so the entry survives the service worker suspending right after
      // the response is sent (see flushPersistedCacheNow in background/cache).
      await setCachedAnalysis(cacheKey, result, { durable: true });
    }
    return result;
  } catch (error) {
    return { error: asErrorMessage(error), ts: Date.now() };
  }
}

export async function handleAnalyzeTrack(
  msg: Extract<ContentMessage, { type: 'ANALYZE_TRACK' }>
): Promise<AnalyzeTrackResponse> {
  return analyzeTrackPersisted(msg);
}

export async function handleAnalyzeTrackSilent(
  msg: Extract<ContentMessage, { type: 'ANALYZE_TRACK_SILENT' }>
): Promise<AnalyzeTrackResponse> {
  return analyzeTrackPersisted(msg);
}

export async function handleCancelAnalysis(
  msg: Extract<ContentMessage, { type: 'CANCEL_ANALYSIS' }>
): Promise<AnalysisCancelledResponse> {
  try {
    const response = await requestChromeAnalysisHost<AnalysisCancelledResponse>('CANCEL_ANALYSIS', {
      url: msg.url,
      cacheKey: msg.cacheKey
    });
    return response.ok ? response.result : { cancelled: false, ts: Date.now() };
  } catch {
    return { cancelled: false, ts: Date.now() };
  }
}

export async function handleAnalyzeKey(
  msg: Extract<ContentMessage, { type: 'ANALYZE_KEY' }>
): Promise<AnalyzeKeyResponse> {
  try {
    const response = await requestChromeAnalysisHost<AnalyzeKeyResponse>('ANALYZE_KEY', {
      url: msg.url,
      bpm: msg.bpm,
      cacheKey: msg.cacheKey
    });
    return response.ok ? response.result : { error: response.error, ts: Date.now() };
  } catch (error) {
    return { error: asErrorMessage(error), ts: Date.now() };
  }
}

export async function handleCancelKeyAnalysis(
  _msg: Extract<ContentMessage, { type: 'CANCEL_KEY_ANALYSIS' }>
): Promise<AnalysisCancelledResponse> {
  return { cancelled: false, ts: Date.now() };
}

export async function handleGetWaveform(
  msg: Extract<ContentMessage, { type: 'GET_WAVEFORM' }>
): Promise<WaveformBands> {
  const response = await requestChromeAnalysisHost<WaveformBands>('GET_WAVEFORM', {
    url: msg.url,
    fetchUrl: msg.fetchUrl,
    cacheKey: msg.cacheKey
  });
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.result;
}

export async function handleAnalyzeKeyDebug(
  _msg: AnalyzeKeyDebugMessage
): Promise<AnalyzeKeyDebugResponse> {
  return {
    type: 'ANALYZE_KEY_DEBUG_RESPONSE',
    debug: null,
    error: 'chrome-analysis-key-debug-not-yet-wired'
  };
}

export async function handleAnalyzeBpmPrototype(
  _msg: AnalyzeBpmPrototypeMessage
): Promise<AnalyzeBpmPrototypeResponse> {
  return {
    type: 'ANALYZE_BPM_PROTOTYPE_RESPONSE',
    analysis: null,
    prototype: null,
    simulated: null,
    error: 'chrome-analysis-bpm-prototype-not-yet-wired'
  };
}
