import type { AnalysisResult, KeyAnalysisResult } from '@/shared/types';

export interface KeyTraceDebugInfo {
  source?: string;
  detail?: string;
  timingMs?: number;
  decodeMs?: number;
  preprocessMs?: number;
  computeMs?: number;
}

function formatTopKeys(keyAnalysis?: KeyAnalysisResult): string {
  if (!keyAnalysis) {
    return '-';
  }

  return keyAnalysis.topKeys
    .slice(0, 3)
    .map((candidate) => candidate.camelot)
    .filter(Boolean)
    .join(',') || '-';
}

export function isRefiningAnalysisStatus(status: string | undefined): boolean {
  return String(status || '').trim().toLowerCase().includes('refining');
}

export function isSettledBpmAnalysisStatus(status: string | undefined): boolean {
  const value = String(status || '').trim();
  if (!/^BPM:/i.test(value)) {
    return false;
  }
  return !isRefiningAnalysisStatus(value);
}

export function buildBpmDebugFields(
  source: string,
  cacheKey: string | undefined,
  detail: string,
  bpmByCacheKey: ReadonlyMap<string, number>,
  normalizeKey: (cacheKey: string) => string,
  bpmOverride?: number
): Pick<AnalysisResult, 'bpmDebugSource' | 'bpmDebugDetail' | 'bpmDebugCacheKey' | 'bpmDebugCacheBpm'> {
  const normalizedKey = cacheKey ? normalizeKey(cacheKey) : '';
  const cachedBpm = normalizedKey ? bpmByCacheKey.get(normalizedKey) : undefined;
  const resolvedBpm = Number.isFinite(bpmOverride) ? Number(bpmOverride) : cachedBpm;
  return {
    bpmDebugSource: source,
    bpmDebugDetail: detail,
    bpmDebugCacheKey: normalizedKey || undefined,
    bpmDebugCacheBpm: Number.isFinite(resolvedBpm) ? Number(resolvedBpm) : undefined
  };
}

export function formatKeyTraceDebug(debug?: KeyTraceDebugInfo): string {
  return [
    `totalMs=${Math.round(Number(debug?.timingMs || 0)) || '-'}`,
    `decodeMs=${Math.round(Number(debug?.decodeMs || 0)) || '-'}`,
    `preprocessMs=${Math.round(Number(debug?.preprocessMs || 0)) || '-'}`,
    `computeMs=${Math.round(Number(debug?.computeMs || 0)) || '-'}`,
    `source=${debug?.source || '-'}`,
    `detail=${debug?.detail || '-'}`
  ].join(' ');
}

export function formatKeyReadySummary(keyAnalysis?: KeyAnalysisResult): string {
  if (!keyAnalysis) {
    return 'top=- windows=- rel=-';
  }

  return [
    `top=${formatTopKeys(keyAnalysis)}`,
    `windows=${keyAnalysis.windowsAnalyzed}/${keyAnalysis.windowsTotal}`,
    `rel=${keyAnalysis.reliability.toFixed(3)}`
  ].join(' ');
}

export function formatPlaylistKeySummary(keyAnalysis?: KeyAnalysisResult): string {
  if (!keyAnalysis) {
    return 'top=- rel=- win=- method=-';
  }

  return [
    `top=${formatTopKeys(keyAnalysis)}`,
    `rel=${Number.isFinite(keyAnalysis.reliability) ? keyAnalysis.reliability.toFixed(3) : '-'}`,
    `win=${Number.isFinite(keyAnalysis.windowsAnalyzed) && Number.isFinite(keyAnalysis.windowsTotal) ? `${keyAnalysis.windowsAnalyzed}/${keyAnalysis.windowsTotal}` : '-'}`,
    `method=${keyAnalysis.method || '-'}`
  ].join(' ');
}
