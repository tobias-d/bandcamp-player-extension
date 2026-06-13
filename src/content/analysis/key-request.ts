import type { KeyAnalysisResult, KeyAnalysisStatus } from '@/shared/types';
import { createLogger } from '@/utils/debug';
import { sendMessage } from '@/utils/messaging';

const logger = createLogger('ANALYZER');

interface KeyAnalysisErrorResponse {
  error?: string;
}

interface KeyAnalysisCancelledResponse {
  cancelled?: boolean;
}

interface KeyAnalysisSuccessResponse {
  keyAnalysis: KeyAnalysisResult;
  keyStatus: KeyAnalysisStatus;
  keyDebugSource?: string;
  keyDebugDetail?: string;
  keyDebugCacheKey?: string;
  keyDebugTimingMs?: number;
  keyDebugDecodeMs?: number;
  keyDebugPreprocessMs?: number;
  keyDebugComputeMs?: number;
  ts: number;
}

type KeyAnalysisResponse = KeyAnalysisSuccessResponse | KeyAnalysisErrorResponse | KeyAnalysisCancelledResponse;

function isCancelledResponse(response: KeyAnalysisResponse): response is KeyAnalysisCancelledResponse & { cancelled: true } {
  return 'cancelled' in response && response.cancelled === true;
}

function isErrorResponse(response: KeyAnalysisResponse): response is KeyAnalysisErrorResponse & { error: string } {
  return 'error' in response && typeof response.error === 'string' && response.error.trim().length > 0;
}

function isSuccessResponse(response: KeyAnalysisResponse): response is KeyAnalysisSuccessResponse {
  return 'keyAnalysis' in response && typeof response.keyStatus === 'string';
}

export interface KeyRequestOptions {
  sourceUrl: string;
  bpm: number;
  cacheKey?: string;
  shouldApply(): boolean;
  onPending(): void;
  onSuccess(
    result: KeyAnalysisResult,
    status: KeyAnalysisStatus,
    elapsedMs: number,
    debug?: {
      source?: string;
      detail?: string;
      cacheKey?: string;
      timingMs?: number;
      decodeMs?: number;
      preprocessMs?: number;
      computeMs?: number;
    }
  ): void;
  onFailure(statusText: string, elapsedMs: number): void;
  onDropped?(reason: string, elapsedMs: number): void;
}

export function requestKeyForSource(options: KeyRequestOptions): () => void {
  const sourceUrl = String(options.sourceUrl || '').trim();
  const bpm = Number(options.bpm);
  if (!sourceUrl || !Number.isFinite(bpm) || bpm <= 0) {
    return () => {};
  }

  const startedAt = Date.now();
  let active = true;

  options.onPending();

  void sendMessage<KeyAnalysisResponse>({
    type: 'ANALYZE_KEY',
    url: sourceUrl,
    bpm,
    cacheKey: options.cacheKey
  })
    .then((response) => {
      if (!active) {
        options.onDropped?.('inactive', Date.now() - startedAt);
        return;
      }
      if (!options.shouldApply()) {
        options.onDropped?.('shouldApply=false', Date.now() - startedAt);
        return;
      }

      if (isCancelledResponse(response)) {
        options.onFailure('Key analysis cancelled', Date.now() - startedAt);
        return;
      }

      if (isErrorResponse(response)) {
        options.onFailure(response.error.trim(), Date.now() - startedAt);
        return;
      }

      if (isSuccessResponse(response) && response.keyAnalysis) {
        options.onSuccess(response.keyAnalysis, response.keyStatus, Date.now() - startedAt, {
          source: response.keyDebugSource,
          detail: response.keyDebugDetail,
          cacheKey: response.keyDebugCacheKey,
          timingMs: response.keyDebugTimingMs,
          decodeMs: response.keyDebugDecodeMs,
          preprocessMs: response.keyDebugPreprocessMs,
          computeMs: response.keyDebugComputeMs
        });
        return;
      }

      options.onFailure('Key analysis failed', Date.now() - startedAt);
    })
    .catch((error) => {
      if (!active) {
        options.onDropped?.('inactive', Date.now() - startedAt);
        return;
      }
      if (!options.shouldApply()) {
        options.onDropped?.('shouldApply=false', Date.now() - startedAt);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('key request failed', message, sourceUrl);
      options.onFailure(`Key failed: ${message}`, Date.now() - startedAt);
    });

  return () => {
    if (!active) {
      return;
    }
    active = false;
    void sendMessage<{ cancelled: boolean }>({
      type: 'CANCEL_KEY_ANALYSIS',
      url: sourceUrl
    }).catch(() => undefined);
  };
}
