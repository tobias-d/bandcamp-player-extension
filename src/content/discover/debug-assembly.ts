import type {
  AnalysisResult,
  KeyAnalysisResult,
  LikeViewState,
  LikesDebugSnapshot,
  NonReleaseResolverSnapshot,
  PlaylistState,
  TrackMetadata
} from '@/shared/types';
import { getDiscoverStrictPayloadMatchDebug, type DiscoverNowPlaying } from '@/content/discover/metadata';
import { buildInput } from '@/content/discover/helpers';
import { buildDiscoverDebugPanelSections, buildDiscoverPreloadStateLines } from '@/content/discover/debug-view';
import type { DebugSection } from '@/shared/debug-trace';
import { updateLikeDebugDocumentAttrs } from '@/content/debug/likes-debug-attrs';
import type { KeyAnalysisTraceEntry } from '@/content/debug/key-analysis-trace';
import type { DiscoverTransportDebugState } from '@/content/debug/debugger';
import type {
  RuntimeAudioEngineDebugSnapshot,
  RuntimeAudioOwnershipDebugState
} from '@/content/player/runtime-audio/types';
import type { ResourceDiagnosticsDebugState } from '@/content/debug/resource-diagnostics';
import {
  getLatestObservedDiscoverAudioState,
  getLatestOwnedPlaybackHostState
} from '@/content/discover/origin-bridge';
import type { PlaylistTrack } from '@/shared/types';

interface BuildDiscoverControllerDebugBodyInput {
  metadata: TrackMetadata;
  playlistState: PlaylistState;
  nowPlaying: DiscoverNowPlaying;
  analysis: AnalysisResult | null;
  preloadTracksEnabled: boolean;
  keyAnalysisEnabled: boolean;
  likeViewState: LikeViewState;
  likeNoticeText: string;
  likesDebug: LikesDebugSnapshot;
  playlistSource: string;
  runId: number;
  apiPolicyLine: string;
  apiShadowPolicyLine: string;
  hintDebug: string;
  transportDebug: DiscoverTransportDebugState;
  keyAnalysisTrace: KeyAnalysisTraceEntry[];
  jumpTrace: KeyAnalysisTraceEntry[];
  preloadTrace: KeyAnalysisTraceEntry[];
  preloadBpmBatchOpenTs?: number;
  preloadKeyBatchOpenTs?: number;
  resolverTrace: KeyAnalysisTraceEntry[];
  resolverSnapshot: NonReleaseResolverSnapshot | null;
  discoverPreloadEpochTargets: Array<{ url: string; cacheKey?: string }>;
  resolveTrackCacheKey(track: PlaylistTrack): string;
  resolvePreloadTargetKey(target: { url: string; cacheKey?: string }): string;
  playlistBpmByCacheKey: Map<string, number>;
  playlistKeyAnalysisByCacheKey: Map<string, KeyAnalysisResult>;
  playlistAnalyzingCacheKeys: Set<string>;
  playlistFailedCacheKeys: Set<string>;
  playlistAttemptCountByCacheKey: Map<string, number>;
  preloadEpochFailedCacheKeys: Set<string>;
  preloadKeyFailedCacheKeys: Set<string>;
  preloadDeferredRetryUntilByCacheKey: Map<string, number>;
  preloadDebug: {
    enabled: boolean;
    inFlight: boolean;
    queueLength: number;
    inFlightMs: number;
  };
  preloadBlockedReason: string;
  preloadKeyBlockedReason: string;
  preloadBpmBatchSettled: boolean;
  preloadKeyQueueLength: number;
  preloadKeyInFlightTargetKey: string;
  metadataDebugLastDecision: string;
  releasePrewarmDebug: string;
  runtimeAudioEngineDebug: RuntimeAudioEngineDebugSnapshot | null;
  runtimePlaybackOwned: boolean;
  runtimeOwnershipDebug: RuntimeAudioOwnershipDebugState;
  discoverPlaybackMode: 'origin' | 'detached';
  resourceDiagnostics: ResourceDiagnosticsDebugState | null;
  refreshLikeSnapshot(): void;
}

function buildBridgeDebugLines(input: {
  runtimePlaybackOwned: boolean;
  runtimeOwnershipDebug: RuntimeAudioOwnershipDebugState;
  discoverPlaybackMode: 'origin' | 'detached';
  selectedSourceUrl: string;
}): string[] {
  const latestDiscoverAudioState = getLatestObservedDiscoverAudioState();
  const latestOwnedPlaybackHostState = getLatestOwnedPlaybackHostState();

  return [
    `Bridge selected: src=${input.selectedSourceUrl || '-'}`,
    `Bridge ownership: mode=${input.discoverPlaybackMode} runtimeOwned=${input.runtimePlaybackOwned ? '1' : '0'} state=${input.runtimeOwnershipDebug.ownershipState} firstOrigin=${input.runtimeOwnershipDebug.firstOriginAvailable ? '1' : '0'}`,
    `Origin bridge audio: src=${latestDiscoverAudioState?.src || '-'} paused=${latestDiscoverAudioState?.paused ? '1' : '0'} t=${latestDiscoverAudioState ? `${latestDiscoverAudioState.currentTimeSec.toFixed(2)}/${latestDiscoverAudioState.durationSec.toFixed(2)}` : '-/-'}`,
    `Origin bridge host: status=${latestOwnedPlaybackHostState?.status || '-'} phase=${latestOwnedPlaybackHostState?.phase || '-'} detail=${latestOwnedPlaybackHostState?.detail || '-'} last=${latestOwnedPlaybackHostState?.lastCommand || '-'}`,
    `Origin bridge host: currentSrc=${latestOwnedPlaybackHostState?.currentSrc || '-'} activeSrc=${latestOwnedPlaybackHostState?.activeSrc || '-'} playing=${latestOwnedPlaybackHostState?.playing ? '1' : '0'}`,
    `Origin bridge host: tracked=${latestOwnedPlaybackHostState?.trackedAudioCount ?? 0} known=${latestOwnedPlaybackHostState?.knownAudioCount ?? 0} playingCount=${latestOwnedPlaybackHostState?.playingAudioCount ?? 0}`,
    `Origin bridge host: playingSrcs=${latestOwnedPlaybackHostState?.playingSrcs?.length ? latestOwnedPlaybackHostState.playingSrcs.join(' || ') : '-'}`,
    `Origin bridge command: ${latestOwnedPlaybackHostState?.lastCommandDetail || '-'} (${latestOwnedPlaybackHostState?.lastCommandAt ? new Date(latestOwnedPlaybackHostState.lastCommandAt).toISOString() : '-'})`,
    `Origin bridge audio event: ${latestOwnedPlaybackHostState?.lastAudioEventDetail || '-'} (${latestOwnedPlaybackHostState?.lastAudioEventAt ? new Date(latestOwnedPlaybackHostState.lastAudioEventAt).toISOString() : '-'})`
  ];
}

export function buildDiscoverControllerDebugSections(input: BuildDiscoverControllerDebugBodyInput): DebugSection[] {
  input.refreshLikeSnapshot();
  const panelInput = buildInput(
    input.metadata,
    input.playlistState,
    input.nowPlaying.isPlaying,
    input.analysis,
    input.preloadTracksEnabled,
    input.keyAnalysisEnabled,
    true,
    input.nowPlaying,
    input.likeViewState,
    input.likeNoticeText
  );
  updateLikeDebugDocumentAttrs(input.likesDebug, panelInput.likeState, panelInput.playlist);
  const preloadStateLines = buildDiscoverPreloadStateLines({
    playlistState: input.playlistState,
    analysis: panelInput.analysis,
    nowPlayingSource: input.nowPlaying.streamUrl,
    preloadTracksEnabled: input.preloadTracksEnabled,
    keyAnalysisEnabled: input.keyAnalysisEnabled,
    preloadEpochTargets: input.discoverPreloadEpochTargets,
    resolveTrackCacheKey: input.resolveTrackCacheKey,
    resolvePreloadTargetKey: input.resolvePreloadTargetKey,
    bpmByCacheKey: input.playlistBpmByCacheKey,
    keyAnalysisByCacheKey: input.playlistKeyAnalysisByCacheKey,
    analyzingCacheKeys: input.playlistAnalyzingCacheKeys,
    failedCacheKeys: input.playlistFailedCacheKeys,
    attemptCountByCacheKey: input.playlistAttemptCountByCacheKey,
    preloadEpochFailedCacheKeys: input.preloadEpochFailedCacheKeys,
    preloadKeyFailedCacheKeys: input.preloadKeyFailedCacheKeys,
    deferredRetryUntilByCacheKey: input.preloadDeferredRetryUntilByCacheKey,
    preloadDebug: input.preloadDebug,
    bpmBlockedReason: input.preloadBlockedReason,
    keyBlockedReason: input.preloadKeyBlockedReason,
    bpmBatchSettled: input.preloadBpmBatchSettled,
    keyQueueLength: input.preloadKeyQueueLength,
    keyInFlightTargetKey: input.preloadKeyInFlightTargetKey
  });
  const metadataDebugLines = [
    `Metadata display: ${input.metadataDebugLastDecision}`,
    `Metadata prewarm: ${input.releasePrewarmDebug}`
  ];
  const discoverStrictMatchDebug = getDiscoverStrictPayloadMatchDebug({
    trackId: input.nowPlaying.trackId,
    streamUrl: input.nowPlaying.streamUrl,
    releaseUrl: input.nowPlaying.releaseUrl
  });

  return buildDiscoverDebugPanelSections({
    nowPlaying: input.nowPlaying,
    panelInput,
    playlistSource: input.playlistSource,
    runId: input.runId,
    apiPolicyLine: input.apiPolicyLine,
    apiShadowPolicyLine: input.apiShadowPolicyLine,
    hintDebug: input.hintDebug,
    discoverStrictMatchDebug,
    transportDebug: input.transportDebug,
    likesDebug: input.likesDebug,
    keyAnalysisTrace: input.keyAnalysisTrace,
    jumpTrace: input.jumpTrace,
    preloadTrace: input.preloadTrace,
    preloadBpmBatchOpenTs: input.preloadBpmBatchOpenTs,
    preloadKeyBatchOpenTs: input.preloadKeyBatchOpenTs,
    preloadStateLines,
    metadataDebugLines,
    bridgeDebugLines: buildBridgeDebugLines({
      runtimePlaybackOwned: input.runtimePlaybackOwned,
      runtimeOwnershipDebug: input.runtimeOwnershipDebug,
      discoverPlaybackMode: input.discoverPlaybackMode,
      selectedSourceUrl: String(input.nowPlaying.streamUrl || '').trim()
    }),
    resolverTrace: input.resolverTrace,
    resolverSnapshot: input.resolverSnapshot,
    runtimeAudioEngineDebug: input.runtimeAudioEngineDebug,
    resourceDiagnostics: input.resourceDiagnostics
  });
}
