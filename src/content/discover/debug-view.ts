import type {
  KeyAnalysisResult,
  LikesDebugSnapshot,
  NonReleaseResolverSnapshot,
  PanelInput,
  PlaylistState,
  PlaylistTrack
} from '@/shared/types';
import { formatPlaylistKeySummary } from '@/content/analysis/debug-helpers';
import { buildPlaylistAnalysisProgressLines } from '@/content/playlist/analysis-progress-debug';
import type { DiscoverNowPlaying } from '@/content/discover/metadata';
import { buildDiscoverDebugSections, type DiscoverTransportDebugState } from '@/content/debug/debugger';
import type { DebugSection } from '@/shared/debug-trace';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import type { KeyAnalysisTraceEntry } from '@/content/debug/key-analysis-trace';
import type { RuntimeAudioEngineDebugSnapshot } from '@/content/player/runtime-audio/types';
import type { ResourceDiagnosticsDebugState } from '@/content/debug/resource-diagnostics';

interface BuildDiscoverDebugViewInput {
  nowPlaying: DiscoverNowPlaying;
  panelInput: PanelInput;
  playlistSource: string;
  runId: number;
  apiPolicyLine: string;
  apiShadowPolicyLine: string;
  hintDebug: string;
  discoverStrictMatchDebug?: string;
  transportDebug: DiscoverTransportDebugState;
  likesDebug: LikesDebugSnapshot;
  keyAnalysisTrace?: KeyAnalysisTraceEntry[];
  jumpTrace?: KeyAnalysisTraceEntry[];
  preloadTrace?: KeyAnalysisTraceEntry[];
  preloadBpmBatchOpenTs?: number;
  preloadKeyBatchOpenTs?: number;
  preloadStateLines?: string[];
  resolverTrace?: KeyAnalysisTraceEntry[];
  resolverSnapshot?: NonReleaseResolverSnapshot | null;
  metadataDebugLines?: string[];
  bridgeDebugLines?: string[];
  runtimeAudioEngineDebug?: RuntimeAudioEngineDebugSnapshot | null;
  resourceDiagnostics?: ResourceDiagnosticsDebugState | null;
}

interface BuildDiscoverPreloadStateLinesInput {
  playlistState: PlaylistState;
  analysis: PanelInput['analysis'];
  nowPlayingSource: string;
  preloadTracksEnabled: boolean;
  keyAnalysisEnabled: boolean;
  preloadEpochTargets: Array<{ url: string; cacheKey?: string }>;
  resolveTrackCacheKey(track: PlaylistTrack): string;
  resolvePreloadTargetKey(target: { url: string; cacheKey?: string }): string;
  bpmByCacheKey: Map<string, number>;
  keyAnalysisByCacheKey: Map<string, KeyAnalysisResult>;
  analyzingCacheKeys: Set<string>;
  failedCacheKeys: Set<string>;
  attemptCountByCacheKey: Map<string, number>;
  preloadEpochFailedCacheKeys: Set<string>;
  preloadKeyFailedCacheKeys: Set<string>;
  deferredRetryUntilByCacheKey: Map<string, number>;
  preloadDebug: {
    enabled: boolean;
    inFlight: boolean;
    queueLength: number;
    inFlightMs: number;
  };
  bpmBlockedReason: string;
  keyBlockedReason: string;
  bpmBatchSettled: boolean;
  keyQueueLength: number;
  keyInFlightTargetKey: string;
}

export function buildDiscoverPreloadStateLines(input: BuildDiscoverPreloadStateLinesInput): string[] {
  const {
    playlistState,
    analysis,
    nowPlayingSource,
    preloadTracksEnabled,
    keyAnalysisEnabled,
    preloadEpochTargets,
    resolveTrackCacheKey,
    resolvePreloadTargetKey,
    bpmByCacheKey,
    keyAnalysisByCacheKey,
    analyzingCacheKeys,
    failedCacheKeys,
    attemptCountByCacheKey,
    preloadEpochFailedCacheKeys,
    preloadKeyFailedCacheKeys,
    deferredRetryUntilByCacheKey,
    preloadDebug,
    bpmBlockedReason,
    keyBlockedReason,
    bpmBatchSettled,
    keyQueueLength,
    keyInFlightTargetKey
  } = input;

  const lines: string[] = [];
  const currentTrack = playlistState.tracks[playlistState.currentIndex] || null;
  const currentTrackKey = currentTrack ? resolveTrackCacheKey(currentTrack) : '';
  const currentTrackBpm = currentTrackKey ? bpmByCacheKey.get(currentTrackKey) : undefined;
  const currentTrackKeyAnalysis = currentTrackKey ? keyAnalysisByCacheKey.get(currentTrackKey) : undefined;
  lines.push(
    `settings: preloadEnabled=${preloadTracksEnabled ? '1' : '0'} keyAnalysisEnabled=${keyAnalysisEnabled ? '1' : '0'}`
  );
  lines.push(
    `gate: bpmBlocked=${bpmBlockedReason || '-'} keyBlocked=${keyBlockedReason || '-'} bpmBatchSettled=${bpmBatchSettled ? '1' : '0'}`
  );
  lines.push(
    `preloader: enabled=${preloadDebug.enabled ? '1' : '0'} inFlight=${preloadDebug.inFlight ? '1' : '0'} queue=${preloadDebug.queueLength} inFlightMs=${preloadDebug.inFlightMs} keyQueue=${keyQueueLength} keyInFlight=${keyInFlightTargetKey || '-'}`
  );
  lines.push(
    `cache: bpm=${bpmByCacheKey.size}, key=${keyAnalysisByCacheKey.size}, analyzing=${analyzingCacheKeys.size}, failed=${failedCacheKeys.size}, attempted=${attemptCountByCacheKey.size}`
  );
  lines.push(...buildPlaylistAnalysisProgressLines({
    tracks: playlistState.tracks,
    preloadEnabled: preloadTracksEnabled,
    keyAnalysisEnabled,
    bpmByCacheKey,
    keyAnalysisByCacheKey,
    bpmAnalyzingCacheKeys: analyzingCacheKeys,
    bpmFailedCacheKeys: failedCacheKeys,
    keyFailedCacheKeys: preloadKeyFailedCacheKeys,
    bpmInFlight: preloadDebug.inFlight,
    bpmQueueLength: preloadDebug.queueLength,
    keyInFlightCount: keyInFlightTargetKey ? 1 : 0,
    keyQueueLength,
    bpmBlockedReason,
    keyBlockedReason,
    resolveTrackCacheKey
  }));
  lines.push(
    `current: index=${playlistState.currentIndex} key=${currentTrackKey || '-'} bpm=${Number.isFinite(currentTrackBpm) ? Math.round(Number(currentTrackBpm)) : '-'} ${formatPlaylistKeySummary(currentTrackKeyAnalysis)} hasBpm=${currentTrackKey && bpmByCacheKey.has(currentTrackKey) ? '1' : '0'} hasKey=${currentTrackKey && keyAnalysisByCacheKey.has(currentTrackKey) ? '1' : '0'} analyzing=${currentTrackKey && analyzingCacheKeys.has(currentTrackKey) ? '1' : '0'} failed=${currentTrackKey && failedCacheKeys.has(currentTrackKey) ? '1' : '0'}`
  );

  for (let index = 0; index < playlistState.tracks.length; index += 1) {
    const track = playlistState.tracks[index];
    if (!track) {
      continue;
    }
    const key = resolveTrackCacheKey(track);
    const bpm = key ? bpmByCacheKey.get(key) : undefined;
    const keyAnalysis = key ? keyAnalysisByCacheKey.get(key) : undefined;
    const attempts = key ? (attemptCountByCacheKey.get(key) || 0) : 0;
    const analyzing = Boolean(key && analyzingCacheKeys.has(key));
    const failed = Boolean(key && failedCacheKeys.has(key));
    const keyFailed = Boolean(key && preloadKeyFailedCacheKeys.has(key));
    lines.push(
      `track[${index}] key=${key || '-'} bpm=${Number.isFinite(bpm) ? Math.round(Number(bpm)) : '-'} ${formatPlaylistKeySummary(keyAnalysis)} hasBpm=${key && bpmByCacheKey.has(key) ? '1' : '0'} hasKey=${key && keyAnalysisByCacheKey.has(key) ? '1' : '0'} analyzing=${analyzing ? '1' : '0'} failed=${failed ? '1' : '0'} preloadKeyFailed=${keyFailed ? '1' : '0'} attempts=${attempts}`
    );
  }

  const renderedRows = Array.from(document.querySelectorAll<HTMLElement>('.bc-pl-track'));
  if (!renderedRows.length) {
    lines.push('dom: rows=0');
  } else {
    const anomalousRows: string[] = [];
    renderedRows.slice(0, 12).forEach((row, index) => {
      const bpmCell = row.querySelector<HTMLElement>('.bc-pl-bpm');
      const bpmText = (bpmCell?.textContent || '').replace(/\s+/g, ' ').trim() || '-';
      const loading = bpmCell?.classList.contains('is-loading') ? '1' : '0';
      const failed = bpmCell?.classList.contains('is-failed') ? '1' : '0';
      const track = playlistState.tracks[index];
      const key = track ? resolveTrackCacheKey(track) : '';
      const bpm = key ? bpmByCacheKey.get(key) : undefined;
      const expectedText = Number.isFinite(bpm) ? String(Math.round(Number(bpm))) : '-';
      if (loading === '1' || failed === '1' || bpmText !== expectedText) {
        anomalousRows.push(
          `domRow[${index}] bpmText=${bpmText} expected=${expectedText} loading=${loading} failed=${failed}`
        );
      }
    });
    lines.push(`dom: rows=${renderedRows.length}, anomalies=${anomalousRows.length}`);
    lines.push(...anomalousRows);
  }

  const mainBpmValue = document.querySelector<HTMLElement>('.bc-bpm-main-value-text');
  const mainBpmLoadingIcon = document.querySelector<HTMLElement>('.bc-bpm-main-loading-icon');
  const mainBpmValueWrap = mainBpmValue?.closest<HTMLElement>('.bc-transport-meta-value');
  const mainConfidenceDot = document.querySelector<HTMLElement>('.bc-bpm-label-wrap .bc-bpm-confidence-dot');
  lines.push(
    `panelDom: bpmText=${(mainBpmValue?.textContent || '').replace(/\s+/g, ' ').trim() || '-'} valueVisible=${mainBpmValue?.style.visibility || '-'} loadingClass=${mainBpmValueWrap?.classList.contains('is-loading') ? '1' : '0'} loadingIcon=${mainBpmLoadingIcon?.style.visibility || '-'} confidence=${mainConfidenceDot?.getAttribute('aria-label') || mainConfidenceDot?.getAttribute('title') || '-'}`
  );
  lines.push(
    `panelSync: analysisBpm=${Number.isFinite(analysis?.bpm) ? Math.round(Number(analysis?.bpm)) : '-'} conf=${Number.isFinite(analysis?.confidence) ? Math.round(Number(analysis?.confidence)) : '-'} tdc=${Number.isFinite(analysis?.tempoDecisionConfidence) ? Math.round(Number(analysis?.tempoDecisionConfidence)) : '-'} rowBpm=${Number.isFinite(currentTrackBpm) ? Math.round(Number(currentTrackBpm)) : '-'} analysisSource=${String(analysis?.sourceUrl || '').trim() || '-'} nowPlayingSource=${String(nowPlayingSource || '').trim() || '-'} sourceMatch=${String(analysis?.sourceUrl || '').trim() === String(nowPlayingSource || '').trim() ? '1' : '0'} status=${analysis?.analysisStatus || '-'}`
  );

  if (!preloadEpochTargets.length) {
    lines.push('epochTargets: none');
  } else {
    const unresolvedTargets: string[] = [];
    preloadEpochTargets.forEach((target, index) => {
      const key = resolvePreloadTargetKey(target);
      const bpm = key ? bpmByCacheKey.get(key) : undefined;
      const attempts = key ? (attemptCountByCacheKey.get(key) || 0) : 0;
      const deferredUntil = key ? (deferredRetryUntilByCacheKey.get(key) || 0) : 0;
      const deferredInMs = deferredUntil > Date.now() ? deferredUntil - Date.now() : 0;
      const reason = !key
        ? 'missing-key'
        : Number.isFinite(bpm)
          ? 'cached-bpm'
          : preloadEpochFailedCacheKeys.has(key)
            ? 'epoch-failed'
            : deferredInMs > 0
              ? `deferred:${Math.round(deferredInMs)}ms`
              : analyzingCacheKeys.has(key)
                ? 'analyzing'
                : failedCacheKeys.has(key)
                  ? 'failed'
                  : 'runnable';
      if (reason !== 'cached-bpm') {
        unresolvedTargets.push(
          `epochTarget[${index}] key=${key || '-'} bpm=${Number.isFinite(bpm) ? Math.round(Number(bpm)) : '-'} attempts=${attempts} state=${reason} url=${target.url}`
        );
      }
    });
    lines.push(`epochTargets: ${preloadEpochTargets.length}, unresolved=${unresolvedTargets.length}`);
    lines.push(...unresolvedTargets.slice(0, 12));
  }

  return lines;
}

export function buildDiscoverDebugPanelSections(input: BuildDiscoverDebugViewInput): DebugSection[] {
  const {
    nowPlaying,
    panelInput,
    playlistSource,
    runId,
    apiPolicyLine,
    apiShadowPolicyLine,
    hintDebug,
    transportDebug,
    likesDebug
  } = input;

  return buildDiscoverDebugSections({
    nowPlaying: {
      streamUrl: nowPlaying.streamUrl,
      releaseUrl: nowPlaying.releaseUrl,
      isPlaying: nowPlaying.isPlaying,
      trackId: readTrackIdFromUrl(nowPlaying.streamUrl),
      identity: nowPlaying.identity || null,
      sources: nowPlaying.sources
    },
    panelInput,
    playlistSource,
    runId,
    apiPolicyLine,
    apiShadowPolicyLine,
    hintDebug,
    discoverStrictMatchDebug: input.discoverStrictMatchDebug || '-',
    transportDebug,
    likesDebug,
    keyAnalysisTrace: input.keyAnalysisTrace || [],
    jumpTrace: input.jumpTrace || [],
    preloadTrace: input.preloadTrace || [],
    preloadBpmBatchOpenTs: input.preloadBpmBatchOpenTs,
    preloadKeyBatchOpenTs: input.preloadKeyBatchOpenTs,
    preloadStateLines: input.preloadStateLines || [],
    resolverTrace: input.resolverTrace || [],
    resolverSnapshot: input.resolverSnapshot ?? null,
    metadataDebugLines: input.metadataDebugLines || [],
    bridgeDebugLines: input.bridgeDebugLines || [],
    runtimeAudioEngineDebug: input.runtimeAudioEngineDebug ?? null,
    resourceDiagnostics: input.resourceDiagnostics ?? null
  });
}
