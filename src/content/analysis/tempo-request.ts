import type { AnalysisResult, BackgroundPush, WaveformBands } from '@/shared/types';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';
import { sendMessage } from '@/utils/messaging';

const logger = createLogger('ANALYZER');

interface AnalysisErrorResponse {
  error?: string;
}

interface AnalysisCancelledResponse {
  cancelled?: boolean;
}

interface AnalysisFinalResponse extends AnalysisResult, AnalysisErrorResponse, AnalysisCancelledResponse {}

export interface TempoRequestOptions {
  sourceUrl: string;
  fetchUrl?: string;
  cacheKey?: string;
  enableKeyAnalysis?: boolean;
  shouldApply(): boolean;
  onPending(statusText: string): void;
  onPartial(partial: Partial<AnalysisResult>): void;
  onFailure(statusText: string, elapsedMs: number): void;
}

function isAnalysisPartialPush(value: unknown): value is Extract<BackgroundPush, { type: 'ANALYSIS_PARTIAL' }> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === 'ANALYSIS_PARTIAL' && typeof record.url === 'string';
}

function isWaveformBands(value: unknown): value is WaveformBands {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.peaksLow)
    && Array.isArray(record.peaksMid)
    && Array.isArray(record.peaksHigh)
    && Number.isFinite(record.duration)
    && Number.isFinite(record.buckets);
}

function asErrorMessage(response: AnalysisFinalResponse): string {
  if (typeof response.error === 'string' && response.error.trim()) {
    return response.error.trim();
  }
  return 'BPM analysis failed';
}

function isRefiningStatus(status: string | undefined): boolean {
  return String(status || '').trim().toLowerCase().includes('refining');
}

function resolveAnalysisDurationMs(options: {
  analysisMs?: number;
  analysisFetchMs?: number;
  analysisDecodeMs?: number;
  analysisTempoMs?: number;
  fallbackMs?: number;
}): number | undefined {
  const directMs = Number(options.analysisMs);
  const fetchMs = Number(options.analysisFetchMs);
  const decodeMs = Number(options.analysisDecodeMs);
  const tempoMs = Number(options.analysisTempoMs);
  const fallbackMs = Number(options.fallbackMs);
  const baseMs = Number.isFinite(directMs) && directMs >= 0
    ? directMs
    : Number.isFinite(fallbackMs) && fallbackMs >= 0
      ? fallbackMs
      : undefined;

  const splitParts = [fetchMs, decodeMs, tempoMs].filter(
    (value): value is number => Number.isFinite(value) && value >= 0
  );
  if (!splitParts.length) {
    return baseMs;
  }

  const splitMs = splitParts.reduce((sum, value) => sum + value, 0);
  return baseMs !== undefined ? Math.max(baseMs, splitMs) : splitMs;
}

function copyAnalysisDebugFields(target: Partial<AnalysisResult>, source: Record<string, unknown>): void {
  if (typeof source.bpmDebugSource === 'string' && source.bpmDebugSource.trim()) {
    target.bpmDebugSource = source.bpmDebugSource.trim();
  }
  if (typeof source.bpmDebugDetail === 'string' && source.bpmDebugDetail.trim()) {
    target.bpmDebugDetail = source.bpmDebugDetail.trim();
  }
  if (typeof source.bpmDebugCacheKey === 'string' && source.bpmDebugCacheKey.trim()) {
    target.bpmDebugCacheKey = source.bpmDebugCacheKey.trim();
  }
  if (typeof source.bpmDebugCacheBpm === 'number' && Number.isFinite(source.bpmDebugCacheBpm)) {
    target.bpmDebugCacheBpm = source.bpmDebugCacheBpm;
  }
  if (typeof source.analysisServedBy === 'string' && source.analysisServedBy.trim()) {
    target.analysisServedBy = source.analysisServedBy.trim();
  }
  if (typeof source.analysisAudioCompleteness === 'string' && source.analysisAudioCompleteness.trim()) {
    target.analysisAudioCompleteness = source.analysisAudioCompleteness.trim();
  }
  if (typeof source.chromeOffscreenDebug === 'string' && source.chromeOffscreenDebug.trim()) {
    target.chromeOffscreenDebug = source.chromeOffscreenDebug.trim();
  }
  if (isWaveformBands(source.waveform)) {
    target.waveform = source.waveform;
  }
  if (typeof source.waveformStatus === 'string') {
    target.waveformStatus = source.waveformStatus;
  }
  if (typeof source.waveformMs === 'number' && Number.isFinite(source.waveformMs)) {
    target.waveformMs = source.waveformMs;
  }
  if (typeof source.waveformDebugContentKey === 'string' && source.waveformDebugContentKey.trim()) {
    target.waveformDebugContentKey = source.waveformDebugContentKey.trim();
  }
  if (typeof source.waveformDebugBackendKey === 'string' && source.waveformDebugBackendKey.trim()) {
    target.waveformDebugBackendKey = source.waveformDebugBackendKey.trim();
  }
}

export function requestTempoForSource(options: TempoRequestOptions): () => void {
  const sourceUrl = String(options.sourceUrl || '').trim();
  const fetchUrl = String(options.fetchUrl || '').trim();
  if (!sourceUrl) {
    return () => {};
  }

  const startedAt = Date.now();
  let active = true;
  const runtime = browserApi.runtime;
  let settleTimeoutId: number | null = null;
  let listenerAttached = false;

  const detachListener = (): void => {
    if (!listenerAttached) {
      return;
    }
    listenerAttached = false;
    runtime?.onMessage?.removeListener(onRuntimeMessage as Parameters<typeof runtime.onMessage.addListener>[0]);
    if (settleTimeoutId !== null) {
      window.clearTimeout(settleTimeoutId);
      settleTimeoutId = null;
    }
  };

  const scheduleListenerDetach = (delayMs: number): void => {
    if (!listenerAttached) {
      return;
    }
    if (settleTimeoutId !== null) {
      window.clearTimeout(settleTimeoutId);
    }
    settleTimeoutId = window.setTimeout(() => {
      settleTimeoutId = null;
      detachListener();
    }, Math.max(0, delayMs));
  };

  const onRuntimeMessage = (raw: unknown): void => {
    if (!active || !isAnalysisPartialPush(raw)) {
      return;
    }
    if (raw.url !== sourceUrl) {
      return;
    }
    if (!options.shouldApply()) {
      detachListener();
      return;
    }

    const partial: Partial<AnalysisResult> = {
      sourceUrl,
      ts: typeof raw.ts === 'number' ? raw.ts : Date.now()
    };
    copyAnalysisDebugFields(partial, raw as Record<string, unknown>);
    if (typeof raw.bpm === 'number') {
      partial.bpm = raw.bpm;
    }
    if (typeof raw.confidence === 'number') {
      partial.confidence = raw.confidence;
    }
    if (typeof raw.tempoRawConfidence === 'number') {
      partial.tempoRawConfidence = raw.tempoRawConfidence;
    }
    if (typeof raw.tempoDecisionConfidence === 'number') {
      partial.tempoDecisionConfidence = raw.tempoDecisionConfidence;
    }
    if (raw.keyAnalysis && typeof raw.keyAnalysis === 'object') {
      partial.keyAnalysis = raw.keyAnalysis;
    }
    if (raw.beatTypeAuto === 'straight' || raw.beatTypeAuto === 'breakbeat' || raw.beatTypeAuto === 'unknown') {
      partial.beatTypeAuto = raw.beatTypeAuto;
    }
    if (typeof raw.breakbeatScore === 'number') {
      partial.breakbeatScore = raw.breakbeatScore;
    }
    if (typeof raw.tempoDebugBaseBpm === 'number') {
      partial.tempoDebugBaseBpm = raw.tempoDebugBaseBpm;
    }
    if (typeof raw.tempoDebugSummary === 'string') {
      partial.tempoDebugSummary = raw.tempoDebugSummary;
    }
    if (typeof raw.tempoDebugGate === 'string') {
      partial.tempoDebugGate = raw.tempoDebugGate;
    }
    if (Array.isArray(raw.tempoDebugCandidates)) {
      partial.tempoDebugCandidates = raw.tempoDebugCandidates
        .filter((candidate) => candidate && typeof candidate === 'object')
        .map((candidate) => {
          const entry = candidate as Record<string, unknown>;
          return {
            bpm: Number(entry.bpm) || 0,
            label: typeof entry.label === 'string' ? entry.label : '',
            score: Number(entry.score) || 0
          };
        })
        .filter((candidate) => candidate.bpm > 0 && candidate.label);
    }
    if (typeof raw.analysisStatus === 'string') {
      partial.analysisStatus = raw.analysisStatus;
    }
    if (typeof raw.resolvedAudioUrl === 'string' && raw.resolvedAudioUrl.trim()) {
      partial.resolvedAudioUrl = raw.resolvedAudioUrl.trim();
    }
    if (typeof raw.analysisMs === 'number') {
      partial.analysisMs = raw.analysisMs;
    }
    if (typeof raw.error === 'string') {
      partial.error = raw.error;
    }
    if (typeof raw.workerPoolDebug === 'string') {
      partial.workerPoolDebug = raw.workerPoolDebug;
    }
    if (typeof raw.analysisFetchMs === 'number') {
      partial.analysisFetchMs = raw.analysisFetchMs;
    }
    if (typeof raw.analysisDecodeMs === 'number') {
      partial.analysisDecodeMs = raw.analysisDecodeMs;
    }
    if (typeof raw.analysisTempoMs === 'number') {
      partial.analysisTempoMs = raw.analysisTempoMs;
    }
    const normalizedPartialMs = resolveAnalysisDurationMs({
      analysisMs: partial.analysisMs,
      analysisFetchMs: partial.analysisFetchMs,
      analysisDecodeMs: partial.analysisDecodeMs,
      analysisTempoMs: partial.analysisTempoMs
    });
    if (Number.isFinite(normalizedPartialMs)) {
      partial.analysisMs = normalizedPartialMs;
    }
    options.onPartial(partial);

    const partialStatus = String(partial.analysisStatus || '').toLowerCase();
    if (partialStatus.includes('analyzing key')) {
      logger.debug('key analysis pending', sourceUrl);
    }
    if (partial.keyAnalysis) {
      logger.info('key analysis partial ready', {
        url: sourceUrl,
        top: partial.keyAnalysis.topKeys.slice(0, 3).map((candidate) => candidate.camelot),
        windows: `${partial.keyAnalysis.windowsAnalyzed}/${partial.keyAnalysis.windowsTotal}`,
        reliability: partial.keyAnalysis.reliability
      });
    }

    if ((Number.isFinite(partial.confidence) || typeof partial.error === 'string') && !isRefiningStatus(partial.analysisStatus)) {
      scheduleListenerDetach(250);
    }
  };

  runtime?.onMessage?.addListener(onRuntimeMessage as Parameters<typeof runtime.onMessage.addListener>[0]);
  listenerAttached = true;

  options.onPending('Estimating BPM...');

  void sendMessage<AnalysisFinalResponse>({
    type: 'ANALYZE_TRACK',
    url: sourceUrl,
    fetchUrl: fetchUrl && fetchUrl !== sourceUrl ? fetchUrl : undefined,
    cacheKey: options.cacheKey
  })
    .then((response) => {
      if (!active || !options.shouldApply()) {
        detachListener();
        return;
      }

      if (response?.cancelled) {
        options.onFailure('BPM analysis cancelled', Date.now() - startedAt);
        detachListener();
        return;
      }

      if (response?.error) {
        options.onFailure(asErrorMessage(response), Date.now() - startedAt);
        detachListener();
        return;
      }

      const finalPartial: Partial<AnalysisResult> = {
        analysisStatus:
          typeof response?.analysisStatus === 'string'
            ? response.analysisStatus
            : typeof response?.bpm === 'number'
              ? `BPM: ${Math.round(response.bpm)}`
              : 'BPM unavailable',
        sourceUrl,
        ts: Date.now()
      };
      copyAnalysisDebugFields(finalPartial, response as unknown as Record<string, unknown>);
      if (typeof response?.resolvedAudioUrl === 'string' && response.resolvedAudioUrl.trim()) {
        finalPartial.resolvedAudioUrl = response.resolvedAudioUrl.trim();
      }
      if (typeof response?.bpm === 'number') {
        finalPartial.bpm = response.bpm;
      }
      if (typeof response?.confidence === 'number') {
        finalPartial.confidence = response.confidence;
      }
      if (typeof response?.tempoRawConfidence === 'number') {
        finalPartial.tempoRawConfidence = response.tempoRawConfidence;
      }
      if (typeof response?.tempoDecisionConfidence === 'number') {
        finalPartial.tempoDecisionConfidence = response.tempoDecisionConfidence;
      }
      if (response?.keyAnalysis && typeof response.keyAnalysis === 'object') {
        finalPartial.keyAnalysis = response.keyAnalysis;
      }
      if (
        response?.beatTypeAuto === 'straight'
        || response?.beatTypeAuto === 'breakbeat'
        || response?.beatTypeAuto === 'unknown'
      ) {
        finalPartial.beatTypeAuto = response.beatTypeAuto;
      }
      if (typeof response?.breakbeatScore === 'number') {
        finalPartial.breakbeatScore = response.breakbeatScore;
      }
      if (typeof response?.tempoDebugBaseBpm === 'number') {
        finalPartial.tempoDebugBaseBpm = response.tempoDebugBaseBpm;
      }
      if (typeof response?.tempoDebugSummary === 'string') {
        finalPartial.tempoDebugSummary = response.tempoDebugSummary;
      }
      if (typeof response?.tempoDebugGate === 'string') {
        finalPartial.tempoDebugGate = response.tempoDebugGate;
      }
      if (typeof response?.keyStatus === 'string') {
        finalPartial.keyStatus = response.keyStatus;
      }
      if (Array.isArray(response?.tempoDebugCandidates)) {
        finalPartial.tempoDebugCandidates = response.tempoDebugCandidates
          .filter((candidate) => candidate && typeof candidate === 'object')
          .map((candidate) => {
            const entry = candidate as Record<string, unknown>;
            return {
              bpm: Number(entry.bpm) || 0,
              label: typeof entry.label === 'string' ? entry.label : '',
              score: Number(entry.score) || 0
            };
          })
          .filter((candidate) => candidate.bpm > 0 && candidate.label);
      }
      if (typeof response?.error === 'string') {
        finalPartial.error = response.error;
      }
      if (typeof response?.workerPoolDebug === 'string') {
        finalPartial.workerPoolDebug = response.workerPoolDebug;
      }
      if (typeof response?.analysisFetchMs === 'number') {
        finalPartial.analysisFetchMs = response.analysisFetchMs;
      }
      if (typeof response?.analysisDecodeMs === 'number') {
        finalPartial.analysisDecodeMs = response.analysisDecodeMs;
      }
      if (typeof response?.analysisTempoMs === 'number') {
        finalPartial.analysisTempoMs = response.analysisTempoMs;
      }
      const normalizedFinalMs = resolveAnalysisDurationMs({
        analysisMs: response?.analysisMs,
        analysisFetchMs: finalPartial.analysisFetchMs,
        analysisDecodeMs: finalPartial.analysisDecodeMs,
        analysisTempoMs: finalPartial.analysisTempoMs,
        fallbackMs: Date.now() - startedAt
      });
      if (Number.isFinite(normalizedFinalMs)) {
        finalPartial.analysisMs = normalizedFinalMs;
      }
      options.onPartial(finalPartial);

      if (finalPartial.keyAnalysis) {
        logger.info('key analysis final ready', {
          url: sourceUrl,
          top: finalPartial.keyAnalysis.topKeys.slice(0, 3).map((candidate) => candidate.camelot),
          windows: `${finalPartial.keyAnalysis.windowsAnalyzed}/${finalPartial.keyAnalysis.windowsTotal}`,
          reliability: finalPartial.keyAnalysis.reliability
        });
      } else if (finalPartial.keyStatus === 'empty' || finalPartial.keyStatus === 'error') {
        logger.warn('key analysis unavailable', sourceUrl);
      }

      if (isRefiningStatus(finalPartial.analysisStatus)) {
        scheduleListenerDetach(12000);
      } else if (Number.isFinite(finalPartial.confidence)) {
        scheduleListenerDetach(250);
      } else {
        // Confidence can arrive as delayed ANALYSIS_PARTIAL after the main response.
        scheduleListenerDetach(8000);
      }
    })
    .catch((error) => {
      if (!active || !options.shouldApply()) {
        detachListener();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('tempo request failed', message, sourceUrl);
      options.onFailure(`BPM failed: ${message}`, Date.now() - startedAt);
      detachListener();
    });

  return () => {
    if (!active) {
      return;
    }
    active = false;
    detachListener();
    void sendMessage<{ cancelled: boolean }>({
      type: 'CANCEL_ANALYSIS',
      url: sourceUrl
    }).catch(() => undefined);
  };
}
