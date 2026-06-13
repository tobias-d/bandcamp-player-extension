import { getMetadataDebugSnapshot } from '@/content/metadata/extractor';
import { buildPlayerDebugSections } from '@/content/debug/debugger';
import type { DebugSection, DebugSectionsFactory } from '@/shared/debug-trace';
import type { ResultsPanelController } from '@/ui/panel';
import { PlayerState } from '@/content/player/state';
import type { SettingsController } from '@/content/settings/settings-controller';
import { buildPanelInput } from '@/content/player/state-sync';
import { detectPageContext } from '@/content/page-context';
import { getLatestOwnedPlaybackHostState, getLatestPageGlobals } from '@/content/discover/origin-bridge';
import { updateLikeDebugDocumentAttrs } from '@/content/debug/likes-debug-attrs';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';

export function buildDebugSections(state: PlayerState): DebugSection[] {
  const currentSrc = String(state.currentSrc || '').trim();
  const activeAudioSrc = String(state.activeAudio?.currentSrc || state.activeAudio?.src || '').trim();
  const bridgeAudioState = state.bridgeAudioState;
  const bridgeFresh = Boolean(bridgeAudioState && Date.now() - bridgeAudioState.ts <= 3000);
  const bridgeForCurrent = Boolean(
    bridgeAudioState?.src &&
    currentSrc &&
    sourcesShareTrackIdentity(bridgeAudioState.src, currentSrc) &&
    (
      bridgeFresh ||
      (state.runtimePlaybackOwned && bridgeAudioState.origin === 'runtime')
    )
  );
  const activeAudioStaleForCurrent = Boolean(
    state.activeAudio &&
    currentSrc &&
    activeAudioSrc &&
    !sourcesShareTrackIdentity(activeAudioSrc, currentSrc)
  );
  const preloadDebugSnapshot = state.preloadDebugSnapshot;
  const activePlaylistTrack = state.playlist.tracks[state.playlist.currentIndex] || null;
  const pageContext = detectPageContext({
    pageGlobals: getLatestPageGlobals(60_000),
    viewerFanIdHint: state.likesDebug.fanId
  });
  state.ownedPlaybackHostState = getLatestOwnedPlaybackHostState(15_000);

  return buildPlayerDebugSections({
    pageType: pageContext.pageType,
    pageMode: pageContext.mode,
    pageGroup: pageContext.group,
    pageSection: pageContext.section,
    pageOwnership: pageContext.ownership,
    pageFanId: pageContext.pageFanId,
    viewerFanId: pageContext.viewerFanId,
    pageFanSlug: pageContext.fanSlug,
    hasPlaybackStarted: state.hasPlaybackStarted,
    currentSrc: state.currentSrc,
    hasAudioElement: Boolean(state.activeAudio),
    isPlaying: Boolean(
      (state.activeAudio && !state.activeAudio.paused && !activeAudioStaleForCurrent) ||
      (bridgeForCurrent && !bridgeAudioState?.paused) ||
      (state.runtimeAudioDebug?.runtimeActive && !state.runtimeAudioDebug?.runtimePaused)
    ),
    metadata: state.metadata,
    metadataResolution: state.metadataResolution,
    analysis: state.lastAnalysis,
    metadataDebug: getMetadataDebugSnapshot(state.currentSrc),
    playlistSource: state.playlistSource,
    playlistTrackCount: state.playlist.tracks.length,
    playlistCurrentIndex: state.playlist.currentIndex,
    playlistTrackStreamUrls: state.playlist.tracks.map((track) => String(track.streamUrl || '').trim()),
    activePlaylistTrackId: String(activePlaylistTrack?.trackId || '').trim(),
    activePlaylistTrackStreamUrl: String(activePlaylistTrack?.streamUrl || '').trim(),
    resolverSnapshot: state.nonReleaseSnapshot,
    transportDebug: state.transportDebug,
    runtimeStretchCapability: state.runtimeStretchCapability,
    runtimeAudioEngineDebug: state.runtimeAudioEngineDebug,
    runtimeAudioIncidentDebug: state.runtimeAudioIncidentDebug,
    runtimeAudioDebug: state.runtimeAudioDebug,
    playheadDebug: state.playheadDebug,
    nativeSeekDebug: state.nativeSeekDebug,
    ownedPlaybackHostState: state.ownedPlaybackHostState,
    uiPerformance: state.uiPerformanceDebug,
    likesDebug: state.likesDebug,
    keyAnalysisTrace: state.keyAnalysisTrace,
    preloadTrace: preloadDebugSnapshot.trace,
    preloadStateLines: preloadDebugSnapshot.stateLines,
    preloadBpmBatchOpenTs: preloadDebugSnapshot.preloadBpmBatchOpenTs,
    preloadKeyBatchOpenTs: preloadDebugSnapshot.preloadKeyBatchOpenTs,
    likeUiLoading: Boolean(state.likeViewState.loading),
    likeUiDisabled: Boolean(state.likeViewState.disabled),
    likeUiNotice: String(state.likeViewState.notice || '').trim(),
    resourceDiagnostics: state.resourceDiagnostics
  });
}

export function scheduleRender(
  state: PlayerState,
  settings: SettingsController,
  panel: ResultsPanelController,
  pushDebug: (title: string, sectionsFactory: DebugSectionsFactory) => void
): void {
  if (state.renderScheduled) {
    return;
  }

  state.renderScheduled = true;
  window.requestAnimationFrame(() => {
    state.renderScheduled = false;
    const renderStartedAt = performance.now();
    const input = buildPanelInput(state, settings);
    updateLikeDebugDocumentAttrs(state.likesDebug, input.likeState, input.playlist);
    const panelStartedAt = performance.now();
    panel.update(input);
    const panelUpdateMs = performance.now() - panelStartedAt;
    let debugSnapshotMs = 0;
    pushDebug('Debugger', () => {
      const debugStartedAt = performance.now();
      const sections = buildDebugSections(state);
      debugSnapshotMs = performance.now() - debugStartedAt;
      return sections;
    });
    state.uiPerformanceDebug.render = {
      panelUpdateMs,
      debugSnapshotMs,
      totalRenderMs: performance.now() - renderStartedAt,
      renderCount: (state.uiPerformanceDebug.render?.renderCount || 0) + 1,
      lastRenderAt: Date.now()
    };
  });
}
