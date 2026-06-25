import type { PanelHandlers, PlaylistTrack } from '@/shared/types';
import type { AudioBridge } from '@/content/player/audio-bridge';
import type { SettingsController } from '@/content/settings/settings-controller';
import { PlayerState } from '@/content/player/state';
import {
  findDirectionalPlayableIndex,
  isTrackPlayable
} from '@/content/playlist/track-navigation';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import { togglePlaylistSort } from '@/content/playlist/sorter';
import { createLogger } from '@/utils/debug';
import { openBackgroundTab } from '@/content/open-background-tab';
import {
  applyPlayerTempoAdjust,
  isPlayerTempoAdjustReady,
  setPlayerTempoAdjustMasterTempo,
  setPlayerTempoAdjustOffset
} from '@/content/player/tempo-adjust';

const logger = createLogger('UI');
const USER_SELECTION_JUMP_LOCK_MS = 8000;

interface CreatePlayerPanelHandlersInput {
  state: PlayerState;
  getBridge(): AudioBridge | null;
  render(): void;
  applyPlaylistCurrentIndex(nextIndex: number, reason?: string): void;
  requestPlaylistApiRefresh(): void;
  recordUiAction(action: string, detail: string): void;
  recordGuard(action: string, detail: string): void;
  recordSelection(action: string, detail: string): void;
  settings: SettingsController;
  onPreloadQueueSync?(): void;
  onToggleAlbumLike?(): void;
  onToggleTrackLike?(index: number): void;
  onTempoAdjustIntent?(): void;
  onClosePanel?(): void;
}

interface AdvancePlayerPlaylistDirectionInput {
  state: PlayerState;
  direction: 1 | -1;
  actionName: string;
  getBridge(): AudioBridge | null;
  render(): void;
  applyPlaylistCurrentIndex(nextIndex: number, reason?: string): void;
  applyPlaylistCurrentIndexReason?: string;
  requestPlaylistApiRefresh(): void;
  recordUiAction(action: string, detail: string): void;
  recordSelection(action: string, detail: string): void;
}

export { findDirectionalPlayableIndex };

export function armPlaylistJumpLock(state: PlayerState, target: PlaylistTrack): void {
  const trackId = String(target.trackId || readTrackIdFromUrl(target.streamUrl || '') || '').trim();
  if (!trackId) {
    state.playlistJumpLockTrackId = '';
    state.playlistJumpLockUntil = 0;
    return;
  }
  state.playlistJumpLockTrackId = trackId;
  state.playlistJumpLockUntil = Date.now() + USER_SELECTION_JUMP_LOCK_MS;
}

function deriveSyntheticStreamUrl(currentSrc: string, targetTrackId: string): string {
  const trackId = String(targetTrackId || '').trim();
  const source = String(currentSrc || '').trim();
  if (!trackId) {
    return '';
  }

  if (source) {
    try {
      const parsed = new URL(source);
      parsed.searchParams.set('track_id', trackId);
      parsed.searchParams.delete('trackid');
      return parsed.toString();
    } catch {
      // Fall through to canonical template.
    }
  }

  return `https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=${encodeURIComponent(trackId)}`;
}

function formatTrackForJumpDebug(
  state: PlayerState,
  track: PlaylistTrack | null | undefined,
  index: number
): string {
  if (!track) {
    return `idx=${index}:none`;
  }
  const trackId = String(track.trackId || readTrackIdFromUrl(track.streamUrl || '') || '').trim() || '-';
  const likeState = state.likeViewState.trackStates[index] || 'unknown';
  return `idx=${index}:id=${trackId}:like=${likeState}:current=${track.isCurrent ? '1' : '0'}`;
}

function buildSelectionDebugContext(state: PlayerState, target: PlaylistTrack, nextIndex: number): string {
  const currentIndex = Number.isInteger(state.playlist.currentIndex) ? state.playlist.currentIndex : -1;
  const currentTrack = currentIndex >= 0 ? state.playlist.tracks[currentIndex] || null : null;
  const jumpLockActive =
    state.playlistJumpLockUntil > Date.now() && Boolean(String(state.playlistJumpLockTrackId || '').trim());
  return [
    `playlistSource=${state.playlistSource || '-'}`,
    `albumLike=${state.likeViewState.albumState}`,
    `active=${formatTrackForJumpDebug(state, currentTrack, currentIndex)}`,
    `target=${formatTrackForJumpDebug(state, target, nextIndex)}`,
    `lock=${jumpLockActive ? state.playlistJumpLockTrackId || '-' : '-'}`
  ].join(' ');
}

function isRecommendationsLikeContext(state: PlayerState): boolean {
  return String(state.likesDebug.contextFamily || '').trim().toLowerCase() === 'recommendations';
}

function describeSelectionContext(state: PlayerState): string {
  if (state.forceUnifiedNonReleaseSnapshot) {
    return 'unified-non-release';
  }
  if (state.originDetachedFromPage) {
    return 'origin-detached';
  }
  if (isRecommendationsLikeContext(state)) {
    return 'recommendations';
  }
  return 'standard';
}

function handlePlaylistSelection(params: {
  state: PlayerState;
  target: PlaylistTrack;
  nextIndex: number;
  getBridge(): AudioBridge | null;
  render(): void;
  applyPlaylistCurrentIndex(nextIndex: number, reason?: string): void;
  requestPlaylistApiRefresh(): void;
  recordSelection(action: string, detail: string): void;
}): void {
  const {
    state,
    target,
    nextIndex,
    getBridge,
    render,
    applyPlaylistCurrentIndex,
    requestPlaylistApiRefresh,
    recordSelection
  } = params;

  const currentSrc = state.activeAudio?.currentSrc || state.activeAudio?.src || state.currentSrc;
  const syntheticStreamUrl = !target.streamUrl
    ? deriveSyntheticStreamUrl(currentSrc, String(target.trackId || '').trim())
    : '';
  const preferredStreamUrl = String(target.streamUrl || syntheticStreamUrl || '').trim();
  const selectionDebugContext = buildSelectionDebugContext(state, target, nextIndex);
  const context = describeSelectionContext(state);
  state.playlistSelectionRunId += 1;
  armPlaylistJumpLock(state, target);

  if (preferredStreamUrl) {
    recordSelection(
      'runtime-playlist-load-track',
      `trackId=${target.trackId || '-'} stream=${target.streamUrl ? '1' : 'synthetic'} context=${context} ${selectionDebugContext}`
    );
    const loaded = Boolean(getBridge()?.loadTrack(preferredStreamUrl, { detached: true }));
    if (!loaded) {
      recordSelection(
        'runtime-playlist-load-blocked',
        `trackId=${target.trackId || '-'} stream=${target.streamUrl ? '1' : 'synthetic'} context=${context} ${selectionDebugContext}`
      );
    }
    applyPlaylistCurrentIndex(nextIndex);
    render();
    return;
  }

  recordSelection(
    'runtime-playlist-unroutable',
    `trackId=${target.trackId || '-'} stream=0 context=${context} ${selectionDebugContext}`
  );
  requestPlaylistApiRefresh();
  render();
}

export function advancePlayerPlaylistDirection(input: AdvancePlayerPlaylistDirectionInput): boolean {
  const {
    state,
    direction,
    actionName,
    getBridge,
    render,
    applyPlaylistCurrentIndex,
    applyPlaylistCurrentIndexReason,
    requestPlaylistApiRefresh,
    recordUiAction,
    recordSelection
  } = input;

  const tracks = state.playlist.tracks;
  if (tracks.length <= 1) {
    return false;
  }

  const nextIndex = findDirectionalPlayableIndex(tracks, state.playlist.currentIndex, direction);
  if (nextIndex < 0) {
    recordUiAction(`${actionName}-skip`, 'no-playable-target');
    render();
    return true;
  }

  const target = tracks[nextIndex];
  if (!target) {
    render();
    return true;
  }

  recordUiAction(actionName, `from=${state.playlist.currentIndex} to=${nextIndex}`);
  handlePlaylistSelection({
    state,
    target,
    nextIndex,
    getBridge,
    render,
    applyPlaylistCurrentIndex: (resolvedNextIndex, reason) => {
      applyPlaylistCurrentIndex(resolvedNextIndex, reason || applyPlaylistCurrentIndexReason);
    },
    requestPlaylistApiRefresh,
    recordSelection
  });
  return true;
}

export function createPlayerPanelHandlers(input: CreatePlayerPanelHandlersInput): PanelHandlers {
  const {
    state,
    getBridge,
    render,
    applyPlaylistCurrentIndex,
    requestPlaylistApiRefresh,
    recordUiAction,
    recordGuard,
    recordSelection,
    settings,
    onPreloadQueueSync,
    onToggleAlbumLike,
    onToggleTrackLike,
    onClosePanel
  } = input;
  const applyTempoAdjust = (): number => applyPlayerTempoAdjust(state, getBridge());
  const canAdjustTempo = (): boolean => isPlayerTempoAdjustReady(state);

  return {
    onTogglePlayPause() {
      if (!state.hasPlaybackStarted) {
        recordGuard('toggle-play-pause-blocked-gate', 'playback-gate-closed');
        render();
        return;
      }

      recordUiAction('toggle-play-pause', `playing=${Boolean(state.activeAudio && !state.activeAudio.paused)}`);
      getBridge()?.togglePlayPause();
    },

    onSetVolume(volume) {
      const clamped = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      recordUiAction('set-volume', `volume=${clamped.toFixed(3)}`);
      getBridge()?.setVolume(clamped);
    },

    onSeekToFraction(fraction) {
      if (!state.hasPlaybackStarted) {
        recordGuard('seek-blocked-gate', `fraction=${Number(fraction).toFixed(3)}`);
        render();
        return;
      }

      const safeFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, Number(fraction))) : 0;
      const audio = state.activeAudio;
      const durationCandidate = Number.isFinite(audio?.duration)
        ? Number(audio?.duration || 0)
        : (
          Number.isFinite(state.bridgeAudioState?.durationSec)
            ? Number(state.bridgeAudioState?.durationSec || 0)
            : Number(state.playheadDebug.selectedDurationSec || 0)
        );
      let bufferedAheadSec: number | null = null;
      if (audio && Number.isFinite(audio.currentTime) && audio.buffered.length > 0) {
        const currentTime = Number(audio.currentTime || 0);
        for (let index = 0; index < audio.buffered.length; index += 1) {
          const start = audio.buffered.start(index);
          const end = audio.buffered.end(index);
          if (currentTime >= start && currentTime <= end) {
            bufferedAheadSec = Math.max(0, end - currentTime);
            break;
          }
        }
      }
      state.pendingSeekFraction = safeFraction;
      state.pendingSeekAtMs = Date.now();
      state.seekWaitOverlayActive = false;
      state.playheadDebug.pendingSeekFraction = safeFraction;
      state.playheadDebug.pendingSeekAgeMs = 0;
      state.nativeSeekDebug.requestAt = state.pendingSeekAtMs;
      state.nativeSeekDebug.requestFraction = safeFraction;
      state.nativeSeekDebug.requestTargetTimeSec =
        durationCandidate > 0 ? safeFraction * durationCandidate : null;
      state.nativeSeekDebug.requestSelectedSource = state.playheadDebug.selectedSource;
      state.nativeSeekDebug.requestRuntimeOwned = state.runtimePlaybackOwned;
      state.nativeSeekDebug.requestSrc = String(audio?.currentSrc || audio?.src || state.currentSrc || '').trim();
      state.nativeSeekDebug.requestPaused = Boolean(audio?.paused ?? !state.hasPlaybackStarted);
      state.nativeSeekDebug.requestReadyState = audio ? Number(audio.readyState) : null;
      state.nativeSeekDebug.requestNetworkState = audio ? Number(audio.networkState) : null;
      state.nativeSeekDebug.requestBufferedAheadSec = bufferedAheadSec;
      state.nativeSeekDebug.dispatchMode = '-';
      state.nativeSeekDebug.runtimeDispatchAt = 0;
      state.nativeSeekDebug.runtimeDispatchDetail = '-';
      state.nativeSeekDebug.nativeDispatchAt = 0;
      state.nativeSeekDebug.nativeDispatchDetail = '-';
      state.nativeSeekDebug.lastEvent = 'request';
      state.nativeSeekDebug.lastEventDetail =
        `fraction=${safeFraction.toFixed(3)} target=${durationCandidate > 0 ? (safeFraction * durationCandidate).toFixed(2) : '-'} selected=${state.playheadDebug.selectedSource} runtimeOwned=${state.runtimePlaybackOwned ? '1' : '0'}`;
      state.nativeSeekDebug.lastEventAt = state.pendingSeekAtMs;
      state.nativeSeekDebug.seekingAt = 0;
      state.nativeSeekDebug.seekedAt = 0;
      state.nativeSeekDebug.firstTimeupdateAt = 0;
      state.nativeSeekDebug.eventCurrentTimeSec = Number.isFinite(audio?.currentTime)
        ? Number(audio?.currentTime || 0)
        : null;
      state.nativeSeekDebug.eventDurationSec = durationCandidate > 0 ? durationCandidate : null;
      state.nativeSeekDebug.eventReadyState = audio ? Number(audio.readyState) : null;
      state.nativeSeekDebug.eventNetworkState = audio ? Number(audio.networkState) : null;
      state.nativeSeekDebug.eventBufferedAheadSec = bufferedAheadSec;
      state.playheadDebug.trace.push({
        ts: state.pendingSeekAtMs,
        kind: 'seek-request',
        detail: `fraction=${safeFraction.toFixed(3)}`
      });
      if (state.playheadDebug.trace.length > 12) {
        state.playheadDebug.trace.splice(0, state.playheadDebug.trace.length - 12);
      }

      recordUiAction('seek', `fraction=${safeFraction.toFixed(3)}`);
      getBridge()?.seekToFraction(safeFraction);

      // The playhead now holds at the committed target (state.pendingSeekFraction,
      // set above) until the authoritative playback position actually reaches it
      // — see buildPanelInput. Render once so the held target shows immediately
      // without waiting for the next STATE round-trip. Do NOT also write the
      // target into bridgeAudioState here: that made selectedFraction report the
      // target before the engine had seeked, tripping the settle check in ~1ms,
      // after which a stale STATE round-trip snapped the playhead back to the old
      // position (the new->old->new jump).
      render();
    },

    onPrevTrack() {
      if (!state.hasPlaybackStarted) {
        recordGuard('prev-track-blocked-gate', 'playback-gate-closed');
        render();
        return;
      }

      if (advancePlayerPlaylistDirection({
        state,
        direction: -1,
        actionName: 'prev-track',
        getBridge,
        render,
        applyPlaylistCurrentIndex,
        requestPlaylistApiRefresh,
        recordUiAction,
        recordSelection
      })) {
        return;
      }

      recordUiAction('prev-track-skip', 'playlist<=1');
      getBridge()?.skipTrack(-1);
    },

    onNextTrack() {
      if (!state.hasPlaybackStarted) {
        recordGuard('next-track-blocked-gate', 'playback-gate-closed');
        render();
        return;
      }

      if (advancePlayerPlaylistDirection({
        state,
        direction: 1,
        actionName: 'next-track',
        getBridge,
        render,
        applyPlaylistCurrentIndex,
        requestPlaylistApiRefresh,
        recordUiAction,
        recordSelection
      })) {
        return;
      }

      recordUiAction('next-track-skip', 'playlist<=1');
      getBridge()?.skipTrack(1);
    },

    onSelectPlaylistTrack(index) {
      if (!state.hasPlaybackStarted) {
        recordSelection('select-blocked-gate', `index=${index}`);
        render();
        return;
      }

      const target = state.playlist.tracks[index];
      if (!target) {
        recordSelection('select-invalid-index', `index=${index}`);
        render();
        return;
      }
      if (!isTrackPlayable(target)) {
        recordSelection('select-unplayable', `index=${index} trackId=${target.trackId || '-'}`);
        render();
        return;
      }
      if (index === state.playlist.currentIndex) {
        const observedSrc = String(state.activeAudio?.currentSrc || state.activeAudio?.src || state.currentSrc || '').trim();
        const observedTrackId = String(readTrackIdFromUrl(observedSrc) || '').trim();
        const targetTrackId = String(target.trackId || '').trim();
        const targetStreamUrl = String(target.streamUrl || '').trim();
        const sameTrackById = Boolean(targetTrackId && observedTrackId && targetTrackId === observedTrackId);
        const sameTrackBySource = Boolean(targetStreamUrl && observedSrc && targetStreamUrl === observedSrc);
        const alreadyPlayingCurrentTrack = Boolean(state.activeAudio && !state.activeAudio.paused && !state.activeAudio.ended);
        if (alreadyPlayingCurrentTrack && (sameTrackById || sameTrackBySource)) {
          recordSelection(
            'select-noop-current',
            `index=${index} trackId=${targetTrackId || '-'} srcMatch=${sameTrackBySource ? '1' : '0'}`
          );
          render();
          return;
        }
      }

      recordUiAction('select-playlist-track', `index=${index} from=${state.playlist.currentIndex}`);
      handlePlaylistSelection({
        state,
        target,
        nextIndex: index,
        getBridge,
        render,
        applyPlaylistCurrentIndex,
        requestPlaylistApiRefresh,
        recordSelection
      });
    },

    onTogglePlaylist() {
      recordUiAction('toggle-playlist', `expanded=${!state.playlist.expanded}`);
      render();
    },

    onTogglePlaylistSort(key) {
      state.playlist = togglePlaylistSort(state.playlist, key);
      recordUiAction('toggle-playlist-sort', `key=${key} asc=${state.playlist.sortAsc ? '1' : '0'}`);
      onPreloadQueueSync?.();
      render();
    },

    onToggleAlbumLike() {
      recordUiAction('toggle-album-like', `index=${state.playlist.currentIndex}`);
      onToggleAlbumLike?.();
      render();
    },

    onToggleTrackLike(index) {
      const safeIndex = Number.isInteger(index) ? index : state.playlist.currentIndex;
      recordUiAction('toggle-track-like', `index=${safeIndex}`);
      onToggleTrackLike?.(safeIndex);
      render();
    },

    onTogglePreloadTracks(enabled) {
      settings.setPreloadTracksEnabled(Boolean(enabled));
      recordUiAction('toggle-preload-tracks', `enabled=${settings.preloadTracksEnabled ? '1' : '0'}`);
      render();
    },

    onToggleKeyAnalysis(enabled) {
      settings.setKeyAnalysisEnabled(Boolean(enabled));
      recordUiAction('toggle-key-analysis', `enabled=${settings.keyAnalysisEnabled ? '1' : '0'}`);
      render();
    },

    onToggleListeningMode(enabled) {
      // Reset a BPM sort before entering listening mode so the now-hidden BPM column can't leave
      // the playlist stuck in a sort the user can no longer change.
      if (enabled && state.playlist.sortKey === 'bpm') {
        state.playlist = togglePlaylistSort(state.playlist, 'index');
      }
      settings.setListeningModeEnabled(Boolean(enabled));
      recordUiAction('toggle-listening-mode', `enabled=${settings.listeningModeEnabled ? '1' : '0'}`);
      render();
    },

    onToggleAutoPlay(enabled) {
      settings.setAutoPlayEnabled(Boolean(enabled));
      recordUiAction('toggle-auto-play', `enabled=${settings.autoPlayEnabled ? '1' : '0'}`);
      render();
    },

    onTogglePerformanceMode(enabled) {
      // Chrome-only opt-in higher predecode tier. Applies on next reload (the engine reads its
      // policy once at construction), so this only persists the setting and re-renders the toggle.
      settings.setPerformanceModeEnabled(Boolean(enabled));
      recordUiAction('toggle-performance-mode', `enabled=${settings.performanceModeEnabled ? '1' : '0'}`);
      render();
    },

    onKeyboardShortcutsChanged(shortcuts) {
      settings.setKeyboardShortcuts(shortcuts);
      recordUiAction('keyboard-shortcuts-changed', 'settings');
      render();
    },

    onOpenBackgroundTab(url) {
      const targetUrl = String(url || '').trim();
      recordUiAction('open-background-tab', targetUrl || '-');
      void openBackgroundTab(targetUrl);
    },

    onSetTempoAdjustOffsetBpm(offsetBpm) {
      if (!canAdjustTempo()) {
        recordGuard('tempo-adjust-offset-blocked', 'tempo-adjust-unavailable');
        render();
        return;
      }
      const changed = setPlayerTempoAdjustOffset(state, offsetBpm);
      const rate = applyTempoAdjust();
      recordUiAction(
        'tempo-adjust-offset',
        `offset=${state.tempoAdjustOffsetBpm} rate=${rate.toFixed(4)} changed=${changed ? '1' : '0'}`
      );
      if (changed && !state.runtimePlaybackOwned) {
        input.onTempoAdjustIntent?.();
      }
      render();
    },

    onSetTempoAdjustMasterTempoEnabled(enabled) {
      const changed = setPlayerTempoAdjustMasterTempo(state, enabled);
      const rate = applyTempoAdjust();
      recordUiAction(
        'tempo-adjust-master-tempo',
        `enabled=${state.tempoAdjustMasterTempoEnabled ? '1' : '0'} rate=${rate.toFixed(4)} changed=${changed ? '1' : '0'}`
      );
      render();
    },

    onClosePanel() {
      onClosePanel?.();
      logger.info('Panel closed by user');
    }
  };
}
