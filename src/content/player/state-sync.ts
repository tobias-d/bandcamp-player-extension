import {
  DEFAULT_LIKE_VIEW_STATE,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import type {
  MetadataResolution,
  NonReleaseResolverSnapshot,
  PanelInput,
  PlaylistState,
  PlaylistTrack,
  TrackMetadata
} from '@/shared/types';
import { PlayerState } from '@/content/player/state';
import { resolveTrackMetadata } from '@/content/metadata/extractor';
import { resolveCachedTrackMetadata } from '@/content/metadata/extractor/api/cache';
import {
  alignPlaylistToCurrentPlayback,
  setPlaylistCurrentIndex
} from '@/content/playlist/controller';
import { applyPlaylistSort } from '@/content/playlist/sorter';
import {
  normalizeUrl,
  readTrackIdFromUrl,
  resolveNonReleaseResolverSnapshot,
  resolvePlayerPlaylistFromGlobals,
  resolveStreamContentId
} from '@/content/playlist/resolver';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { isHttpsReleasePageUrl, isReleaseContext, normalizeReleaseUrl } from '@/content/metadata/common';
import { shouldUseUnifiedNonReleaseSnapshot } from '@/content/metadata/release/non-release-snapshot-gate';
import { detectPageContext } from '@/content/page-context';
import { applyLikeStatesToPlaylist } from '@/content/likes/state';
import { recordTransportPlaylistRefresh } from '@/content/debug/debugger';
import { buildTempoAdjustUiState } from '@/shared/tempo-adjust';
import { isPlayerTempoAdjustReady } from '@/content/player/tempo-adjust';
import { resolveRuntimePlaylistPreparationUiState } from '@/content/player/runtime-audio/playlist-prep-status';

function isActivePlayback(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && !audio.paused && !audio.ended && (audio.currentSrc || audio.src));
}

const PLAYHEAD_DEBUG_TRACE_LIMIT = 12;
const PLAYHEAD_BACKWARD_JUMP_SEC = 0.5;
const PLAYHEAD_FORWARD_JUMP_SEC = 2;
const PLAYHEAD_SEEK_SETTLE_WINDOW_MS = 30000;
const PLAYHEAD_SEEK_SETTLE_FRACTION_EPSILON = 0.035;
const PLAYHEAD_SOURCE_TRANSITION_GUARD_MS = 1500;
const PLAYHEAD_SEEK_PENDING_UI_WINDOW_MS = 30000;

function pushPlayheadDebugTrace(
  state: PlayerState,
  kind: 'selected-source' | 'seek-request' | 'seek-settled' | 'jump-backward' | 'jump-forward',
  detail: string
): void {
  state.playheadDebug.trace.push({
    ts: Date.now(),
    kind,
    detail: detail || '-'
  });
  if (state.playheadDebug.trace.length > PLAYHEAD_DEBUG_TRACE_LIMIT) {
    state.playheadDebug.trace.splice(0, state.playheadDebug.trace.length - PLAYHEAD_DEBUG_TRACE_LIMIT);
  }
}

function updatePlayheadDebug(
  state: PlayerState,
  input: {
    selectedSource: 'audio' | 'bridge';
    selectedReason: string;
    selectedCurrentSec: number;
    selectedDurationSec: number;
    selectedFraction: number;
    audioSrc: string;
    audioPaused: boolean;
    audioCurrentSec: number;
    audioDurationSec: number;
    bridgeSrc: string;
    bridgeOrigin: 'runtime' | 'origin-audio' | 'bridge-observer' | '-';
    bridgePaused: boolean;
    bridgeCurrentSec: number;
    bridgeDurationSec: number;
  }
): void {
  const now = Date.now();
  const pendingSeekAgeMs = state.pendingSeekAtMs > 0 ? Math.max(0, now - state.pendingSeekAtMs) : null;
  const pendingSeekFraction = state.pendingSeekFraction;
  const seekPending =
    pendingSeekFraction !== null &&
    pendingSeekAgeMs !== null &&
    pendingSeekAgeMs <= PLAYHEAD_SEEK_SETTLE_WINDOW_MS;
  const seekSettled =
    seekPending &&
    Math.abs(input.selectedFraction - pendingSeekFraction) <= PLAYHEAD_SEEK_SETTLE_FRACTION_EPSILON;
  const currentSrc = String(state.currentSrc || '').trim();
  const sourceChanged =
    currentSrc !== state.playheadDebug.lastObservedSrc ||
    input.selectedSource !== state.playheadDebug.lastObservedSelectedSource;
  const jumpLockTrackId = String(state.playlistJumpLockTrackId || '').trim();
  const jumpLockActive = state.playlistJumpLockUntil > now && Boolean(jumpLockTrackId);
  const sourceTransitionGuardActive = state.playheadTransitionGuardUntilMs > now;
  const selectionResetInProgress =
    jumpLockActive &&
    input.selectedSource === 'audio' &&
    input.selectedCurrentSec <= 1 &&
    state.playheadDebug.lastObservedCurrentSec >= 1;
  const selectionResumeInProgress =
    jumpLockActive &&
    input.selectedSource === 'audio' &&
    state.playheadDebug.lastObservedCurrentSec <= 1 &&
    input.selectedCurrentSec >= 1;
  const sourceTransitionAudioResetExpected =
    sourceChanged &&
    sourceTransitionGuardActive &&
    input.selectedSource === 'audio' &&
    input.selectedReason === 'audio-only' &&
    !seekPending;
  const observedSelectedCurrentSec = sourceTransitionAudioResetExpected ? 0 : input.selectedCurrentSec;
  const observedSelectedDurationSec = sourceTransitionAudioResetExpected ? 0 : input.selectedDurationSec;
  const observedAudioCurrentSec = sourceTransitionAudioResetExpected ? 0 : input.audioCurrentSec;
  const observedAudioDurationSec = sourceTransitionAudioResetExpected ? 0 : input.audioDurationSec;
  const observedSelectedFraction =
    observedSelectedDurationSec > 0
      ? observedSelectedCurrentSec / observedSelectedDurationSec
      : 0;
  const suppressSelectionTransitionJump =
    selectionResetInProgress ||
    selectionResumeInProgress ||
    (sourceTransitionGuardActive && input.selectedSource === 'audio');
  const suppressBridgePlayheadJump =
    input.selectedSource === 'bridge' &&
    (
      input.selectedReason === 'bridge-runtime-owned' ||
      input.selectedReason === 'bridge-current-audio-stale'
    );
  const deltaSec = observedSelectedCurrentSec - state.playheadDebug.lastObservedCurrentSec;

  if (sourceChanged) {
    pushPlayheadDebugTrace(
      state,
      'selected-source',
      `selected=${input.selectedSource} reason=${input.selectedReason} current=${observedSelectedCurrentSec.toFixed(2)}/${observedSelectedDurationSec.toFixed(2)} src=${currentSrc || '-'} bridgeOrigin=${input.bridgeOrigin}`
    );
  } else if (!seekPending && !suppressSelectionTransitionJump && !suppressBridgePlayheadJump) {
    if (deltaSec <= -PLAYHEAD_BACKWARD_JUMP_SEC) {
      pushPlayheadDebugTrace(
        state,
        'jump-backward',
        `delta=${deltaSec.toFixed(2)} current=${observedSelectedCurrentSec.toFixed(2)}/${observedSelectedDurationSec.toFixed(2)} selected=${input.selectedSource} reason=${input.selectedReason}`
      );
    } else if (deltaSec >= PLAYHEAD_FORWARD_JUMP_SEC) {
      pushPlayheadDebugTrace(
        state,
        'jump-forward',
        `delta=${deltaSec.toFixed(2)} current=${observedSelectedCurrentSec.toFixed(2)}/${observedSelectedDurationSec.toFixed(2)} selected=${input.selectedSource} reason=${input.selectedReason}`
      );
    }
  }

  if (seekSettled) {
    pushPlayheadDebugTrace(
      state,
      'seek-settled',
      `target=${pendingSeekFraction.toFixed(3)} actual=${observedSelectedFraction.toFixed(3)} selected=${input.selectedSource} ageMs=${pendingSeekAgeMs}`
    );
    state.pendingSeekFraction = null;
    state.pendingSeekAtMs = 0;
    state.seekWaitOverlayActive = false;
  } else if (
    pendingSeekFraction !== null &&
    pendingSeekAgeMs !== null &&
    pendingSeekAgeMs > PLAYHEAD_SEEK_SETTLE_WINDOW_MS
  ) {
    // The observed position never reached the committed target within the settle
    // window (e.g. the seek was dropped). Release the hold so the playhead
    // resumes tracking the live source deterministically instead of freezing.
    state.pendingSeekFraction = null;
    state.pendingSeekAtMs = 0;
    state.seekWaitOverlayActive = false;
  }

  state.playheadDebug.selectedSource = input.selectedSource;
  state.playheadDebug.selectedReason = input.selectedReason;
  state.playheadDebug.selectedCurrentSec = observedSelectedCurrentSec;
  state.playheadDebug.selectedDurationSec = observedSelectedDurationSec;
  state.playheadDebug.selectedFraction = observedSelectedFraction;
  state.playheadDebug.audioSrc = input.audioSrc;
  state.playheadDebug.audioPaused = input.audioPaused;
  state.playheadDebug.audioCurrentSec = observedAudioCurrentSec;
  state.playheadDebug.audioDurationSec = observedAudioDurationSec;
  state.playheadDebug.bridgeSrc = input.bridgeSrc;
  state.playheadDebug.bridgeOrigin = input.bridgeOrigin;
  state.playheadDebug.bridgePaused = input.bridgePaused;
  state.playheadDebug.bridgeCurrentSec = input.bridgeCurrentSec;
  state.playheadDebug.bridgeDurationSec = input.bridgeDurationSec;
  state.playheadDebug.pendingSeekFraction = state.pendingSeekFraction;
  state.playheadDebug.pendingSeekAgeMs = state.pendingSeekAtMs > 0 ? Math.max(0, now - state.pendingSeekAtMs) : null;
  state.playheadDebug.lastUpdateTs = now;
  state.playheadDebug.lastObservedSrc = currentSrc;
  state.playheadDebug.lastObservedSelectedSource = input.selectedSource;
  state.playheadDebug.lastObservedCurrentSec = observedSelectedCurrentSec;
}

function findPlaylistTrackIndexBySource(tracks: PlaylistTrack[], currentSrc: string): number {
  if (!currentSrc || !tracks.length) {
    return -1;
  }

  const trackId = readTrackIdFromUrl(currentSrc);
  if (trackId) {
    const byTrackId = tracks.findIndex((track) => track.trackId === trackId);
    if (byTrackId >= 0) {
      return byTrackId;
    }
  }

  const normalizedSrc = normalizeUrl(currentSrc);
  if (normalizedSrc) {
    const byStreamUrl = tracks.findIndex((track) => normalizeUrl(track.streamUrl || '') === normalizedSrc);
    if (byStreamUrl >= 0) {
      return byStreamUrl;
    }
  }

  const streamContentId = resolveStreamContentId(currentSrc);
  if (streamContentId) {
    return tracks.findIndex((track) => resolveStreamContentId(track.streamUrl || '') === streamContentId);
  }

  return -1;
}

function trackIdentity(track: PlaylistTrack): string {
  const trackId = String(track.trackId || '').trim();
  if (trackId) {
    return `id:${trackId}`;
  }

  const streamUrl = String(track.streamUrl || '').trim();
  if (streamUrl) {
    const streamContentId = resolveStreamContentId(streamUrl);
    if (streamContentId) {
      return `stream-content:${streamContentId}`;
    }
    const normalized = normalizeUrl(streamUrl);
    if (normalized) {
      return `stream-url:${normalized}`;
    }
  }

  return `fallback:${track.index}:${track.title.trim().toLowerCase()}`;
}

function normalizeAlbumPageUrl(value: string | undefined | null): string {
  const normalized = normalizeReleaseUrl(String(value || '').trim());
  if (!normalized || !normalized.includes('/album/')) {
    return '';
  }
  return isHttpsReleasePageUrl(normalized) ? normalized : '';
}

function playlistsEquivalentByTrackIdentity(previousTracks: PlaylistTrack[], nextTracks: PlaylistTrack[]): boolean {
  if (previousTracks.length !== nextTracks.length) {
    return false;
  }

  for (let index = 0; index < previousTracks.length; index += 1) {
    if (trackIdentity(previousTracks[index]) !== trackIdentity(nextTracks[index])) {
      return false;
    }
  }

  return true;
}

function isUnresolvedPlaylistResult(source: string, playlist: PlaylistState): boolean {
  const normalizedSource = String(source || '').trim();
  if (!playlist.tracks.length) {
    return true;
  }
  if (!normalizedSource) {
    return true;
  }
  return normalizedSource.startsWith('none') || normalizedSource.includes('(stale-track)');
}


function hydrateMetadataResolutionFromPlaylistTrack(
  resolution: MetadataResolution,
  playlist: PlaylistState,
  playlistSourceHint = ''
): MetadataResolution {
  const activeTrack = playlist.tracks[playlist.currentIndex] || null;
  if (!activeTrack) {
    return resolution;
  }

  const sourceTrackId = String(activeTrack.trackId || '').trim();
  const resolvedTrackId = sourceTrackId || String(resolution.matchedTrackId || '').trim();
  const sourceStreamUrl = String(activeTrack.streamUrl || '').trim();
  const resolvedStreamUrl = sourceStreamUrl || String(resolution.matchedStreamUrl || '').trim();
  const sourcePrefix =
    String(activeTrack.identitySource || '').trim() ||
    (String(playlistSourceHint || '').startsWith('TralbumAPI') ? 'TralbumAPI' : '');
  if (sourcePrefix !== 'TralbumAPI') {
    return resolution;
  }

  const cached = resolvedTrackId ? resolveCachedTrackMetadata(resolvedTrackId) : null;
  const title = String(activeTrack.title || cached?.title?.value || '').trim();
  const artist = String(activeTrack.artistName || cached?.artist?.value || '').trim();
  const album = String(activeTrack.albumTitle || cached?.album?.value || '').trim();
  const releaseDate = activeTrack.releaseDate ?? resolution.metadata.releaseDate ?? cached?.releaseDate;
  if (!title && !artist && !album) {
    return resolution;
  }

  const titleFromTrack = Boolean(String(activeTrack.title || '').trim());
  const artistFromTrack = Boolean(String(activeTrack.artistName || '').trim());
  const albumFromTrack = Boolean(String(activeTrack.albumTitle || '').trim());
  const resolvedTitle = String(resolution.metadata.trackTitle || '').trim();
  const resolvedArtist = String(resolution.metadata.artistName || '').trim();
  const resolvedAlbum = String(resolution.metadata.albumTitle || '').trim();
  const titleSource = titleFromTrack
    ? `${sourcePrefix}.track.title`
    : title && title === resolvedTitle && resolution.metadata.sources.title !== 'default'
      ? String(resolution.metadata.sources.title || '').trim()
      : String(cached?.title?.source || '').trim();
  const artistSource = artistFromTrack
    ? `${sourcePrefix}.track.artist`
    : artist && artist === resolvedArtist && resolution.metadata.sources.artist !== 'default'
      ? String(resolution.metadata.sources.artist || '').trim()
      : String(cached?.artist?.source || '').trim();
  const albumSource = albumFromTrack
    ? `${sourcePrefix}.track.album`
    : album && album === resolvedAlbum && resolution.metadata.sources.album !== 'default'
      ? String(resolution.metadata.sources.album || '').trim()
      : String(cached?.album?.source || '').trim();

  const nextMetadata: TrackMetadata = {
    ...resolution.metadata,
    ...(releaseDate ? { releaseDate } : {}),
    trackTitle: title || resolution.metadata.trackTitle,
    artistName: artist || resolution.metadata.artistName,
    albumTitle: album || resolution.metadata.albumTitle,
    combined: `${artist || resolution.metadata.artistName} — ${title || resolution.metadata.trackTitle}`,
    confidence:
      title && artist && album
        ? 'high'
        : resolution.metadata.confidence,
    sources: {
      title: title ? (titleSource || resolution.metadata.sources.title) : resolution.metadata.sources.title,
      artist: artist ? (artistSource || resolution.metadata.sources.artist) : resolution.metadata.sources.artist,
      album: album ? (albumSource || resolution.metadata.sources.album) : resolution.metadata.sources.album
    }
  };

  return {
    ...resolution,
    metadata: nextMetadata,
    matchedTrackId: resolvedTrackId,
    matchedStreamUrl: resolvedStreamUrl
  };
}

function applyResolvedMetadata(state: PlayerState, resolution: MetadataResolution): void {
  state.metadata = resolution.metadata;
  state.metadataResolution = resolution;
}

export function applyCurrentPlaylistTrackMetadata(
  state: PlayerState,
  onAlign: (detail: string) => void
): boolean {
  const currentSrc = String(state.currentSrc || '').trim();
  if (!currentSrc || !state.playlist.tracks.length) {
    return false;
  }

  const nextIndex = findPlaylistTrackIndexBySource(state.playlist.tracks, currentSrc);
  if (nextIndex < 0) {
    return false;
  }

  const alignResult = setPlaylistCurrentIndex(state.playlist, nextIndex);
  if (alignResult.changed) {
    state.playlist = alignResult.playlist;
    onAlign(`${alignResult.previousIndex} -> ${alignResult.nextIndex} (playlist-metadata)`);
  }

  const activeTrack = state.playlist.tracks[state.playlist.currentIndex] || null;
  if (!activeTrack) {
    return false;
  }

  const sourcePrefix =
    String(activeTrack.identitySource || '').trim() ||
    (String(state.playlistSource || '').startsWith('TralbumAPI') ? 'TralbumAPI' : '');
  if (sourcePrefix !== 'TralbumAPI') {
    return false;
  }

  const sourceTrackId = String(readTrackIdFromUrl(currentSrc) || '').trim();
  const trackId = String(activeTrack.trackId || '').trim();
  const streamUrl = String(activeTrack.streamUrl || '').trim();
  const cached = (trackId || sourceTrackId) ? resolveCachedTrackMetadata(trackId || sourceTrackId) : null;
  const hasPlaylistMetadata = Boolean(
    String(activeTrack.title || cached?.title?.value || '').trim() ||
    String(activeTrack.artistName || cached?.artist?.value || '').trim() ||
    String(activeTrack.albumTitle || cached?.album?.value || '').trim()
  );
  if (!hasPlaylistMetadata) {
    return false;
  }

  const sourceContentId = resolveStreamContentId(currentSrc);
  const trackContentId = resolveStreamContentId(streamUrl);
  const matchedByTrackId = Boolean(sourceTrackId && trackId && sourceTrackId === trackId);
  const matchedByStream =
    Boolean(normalizeUrl(currentSrc) && normalizeUrl(streamUrl) && normalizeUrl(currentSrc) === normalizeUrl(streamUrl)) ||
    Boolean(sourceContentId && trackContentId && sourceContentId === trackContentId);
  const selectedTrackReason: MetadataResolution['selectedTrackReason'] = matchedByTrackId
    ? 'trackId'
    : matchedByStream
      ? 'streamUrl'
      : 'none';
  const baseResolution: MetadataResolution = {
    metadata: { ...DEFAULT_TRACK_METADATA },
    sourceUrl: currentSrc,
    matchedTrackId: trackId || sourceTrackId,
    matchedStreamUrl: streamUrl || currentSrc,
    selectedTrackIndex: state.playlist.currentIndex,
    selectedTrackReason
  };
  const resolution = hydrateMetadataResolutionFromPlaylistTrack(
    baseResolution,
    state.playlist,
    state.playlistSource
  );
  if (!isMetadataResolutionAlignedWithSource(resolution, currentSrc)) {
    return false;
  }

  applyResolvedMetadata(state, resolution);
  return true;
}

export function isMetadataResolutionAlignedWithSource(
  resolution: MetadataResolution,
  currentSrc: string
): boolean {
  const src = String(currentSrc || "").trim();
  if (!src) {
    return true;
  }

  const sourceTrackId = readTrackIdFromUrl(src);
  const matchedTrackId = String(resolution.matchedTrackId || "").trim();
  if (sourceTrackId && matchedTrackId && sourceTrackId !== matchedTrackId) {
    return false;
  }

  const sourceContentId = resolveStreamContentId(src);
  const matchedStreamUrl = String(resolution.matchedStreamUrl || "").trim();
  const matchedContentId = resolveStreamContentId(matchedStreamUrl);
  if (sourceContentId && matchedContentId && sourceContentId !== matchedContentId) {
    return false;
  }

  return true;
}

function isNonReleasePlayerContext(): boolean {
  return !isReleaseContext();
}

function useUnifiedNonReleaseSnapshotForPlayer(state: PlayerState): boolean {
  if (state.forceUnifiedNonReleaseSnapshot) {
    return true;
  }
  const pageContext = detectPageContext();
  return shouldUseUnifiedNonReleaseSnapshot({
    context: 'player',
    pageType: pageContext.pageType
  });
}

function canReuseNonReleaseSnapshot(
  state: PlayerState,
  allowApiFetch: boolean
): state is PlayerState & { nonReleaseSnapshot: NonReleaseResolverSnapshot } {
  if (!state.nonReleaseSnapshot) {
    return false;
  }
  if (state.nonReleaseSnapshotVersion !== state.sourceVersion) {
    return false;
  }
  const currentSrc = String(state.currentSrc || '').trim();
  if (state.nonReleaseSnapshot.currentSrc !== currentSrc) {
    return false;
  }
  if (allowApiFetch && !state.nonReleaseSnapshot.source.allowApiFetch) {
    return false;
  }
  if (
    state.nonReleaseSnapshot.source.tralbumSource === 'none' ||
    state.nonReleaseSnapshot.source.staleTrack ||
    state.nonReleaseSnapshot.playlist.tracks.length === 0
  ) {
    return false;
  }
  if (
    state.nonReleaseSnapshot.playlist.sortKey !== state.playlist.sortKey ||
    state.nonReleaseSnapshot.playlist.sortAsc !== state.playlist.sortAsc ||
    state.nonReleaseSnapshot.playlist.expanded !== state.playlist.expanded
  ) {
    return false;
  }
  return true;
}

function resolveOrReuseNonReleaseSnapshot(
  state: PlayerState,
  allowApiFetch: boolean
): NonReleaseResolverSnapshot {
  if (canReuseNonReleaseSnapshot(state, allowApiFetch)) {
    return state.nonReleaseSnapshot;
  }

  const snapshot = resolveNonReleaseResolverSnapshot({
    context: 'player',
    previous: state.playlist,
    currentSrc: state.currentSrc,
    allowApiFetch
  });
  state.nonReleaseSnapshot = snapshot;
  state.nonReleaseSnapshotVersion = state.sourceVersion;
  return snapshot;
}

function stabilizePlaylistDuringResolverTransition(params: {
  state: PlayerState;
  previousPlaylist: PlaylistState;
  previousSource: string;
  previousIndex: number;
  candidatePlaylist: PlaylistState;
  candidateSource: string;
  allowApiFetch: boolean;
  now: number;
  onAlign: (detail: string) => void;
}): { playlist: PlaylistState; source: string } {
  const {
    state,
    previousPlaylist,
    previousSource,
    previousIndex,
    candidatePlaylist,
    candidateSource,
    allowApiFetch,
    now,
    onAlign
  } = params;

  let nextPlaylist = candidatePlaylist;
  let nextSource = candidateSource;

  if (!state.currentSrc) {
    return { playlist: nextPlaylist, source: nextSource };
  }

  const prevMatchIndex = findPlaylistTrackIndexBySource(previousPlaylist.tracks, state.currentSrc);
  const nextMatchIndex = findPlaylistTrackIndexBySource(candidatePlaylist.tracks, state.currentSrc);
  const lockTrackId = state.playlistJumpLockTrackId;
  const lockActive = state.playlistJumpLockUntil > now && Boolean(lockTrackId);
  const currentTrackId = readTrackIdFromUrl(state.currentSrc);
  const nextUnresolved = isUnresolvedPlaylistResult(candidateSource, candidatePlaylist);
  const lockPending = lockActive && currentTrackId !== lockTrackId;
  const lockMatchesCurrentTrack = lockActive && currentTrackId === lockTrackId;
  const prevHasLockedTrack = lockTrackId
    ? previousPlaylist.tracks.some((track) => track.trackId === lockTrackId)
    : false;
  const nextHasLockedTrack = lockTrackId
    ? candidatePlaylist.tracks.some((track) => track.trackId === lockTrackId)
    : false;
  const nextShrank = candidatePlaylist.tracks.length < previousPlaylist.tracks.length;
  const recommendationsJumpLock = state.forceUnifiedNonReleaseSnapshot && lockActive;

  if (recommendationsJumpLock && previousPlaylist.tracks.length > 0) {
    nextPlaylist = previousPlaylist;
    nextSource = previousSource;
    onAlign(`${previousIndex} kept (recommendations-jump-lock, track=${lockTrackId || '-'})`);
  }

  const shouldHoldDuringTransition =
    previousPlaylist.tracks.length > 0 &&
    (
      (prevMatchIndex >= 0 && nextMatchIndex < 0) ||
      (lockMatchesCurrentTrack && nextUnresolved && prevMatchIndex < 0)
    );
  let heldByTransition = false;
  if (shouldHoldDuringTransition) {
    nextPlaylist = previousPlaylist;
    nextSource = previousSource;
    const holdIndex = prevMatchIndex >= 0 ? prevMatchIndex : previousIndex;
    const holdTrack = currentTrackId || '-';
    onAlign(
      `${holdIndex} kept (transition-hold unresolved source=${candidateSource}, track=${holdTrack})`
    );
    heldByTransition = true;
  }

  if (
    allowApiFetch === false &&
    previousPlaylist.tracks.length > 1 &&
    candidatePlaylist.tracks.length === 1 &&
    prevMatchIndex >= 0 &&
    nextMatchIndex >= 0
  ) {
    nextPlaylist = previousPlaylist;
    nextSource = previousSource;
    onAlign(`${prevMatchIndex} kept (shrink-guard ${previousPlaylist.tracks.length}->1, src=${state.currentSrc})`);
  }

  if (!heldByTransition && lockMatchesCurrentTrack && prevHasLockedTrack && (!nextHasLockedTrack || nextShrank)) {
    nextPlaylist = previousPlaylist;
    nextSource = previousSource;
    onAlign(
      `${prevMatchIndex} kept (jump-lock track=${lockTrackId}, tracks ${previousPlaylist.tracks.length}->${candidatePlaylist.tracks.length})`
    );
  }

  if (lockPending && previousPlaylist.tracks.length > 0) {
    nextPlaylist = previousPlaylist;
    nextSource = previousSource;
  }

  return { playlist: nextPlaylist, source: nextSource };
}

function applyNonReleaseSnapshot(
  state: PlayerState,
  onAlign: (detail: string) => void,
  snapshot: NonReleaseResolverSnapshot,
  allowApiFetch: boolean
): void {
  const now = Date.now();
  const prevSource = state.playlistSource;
  const prevTracks = state.playlist.tracks.length;
  const prevIndex = state.playlist.currentIndex;
  const previousPlaylist = state.playlist;
  const stabilized = stabilizePlaylistDuringResolverTransition({
    state,
    previousPlaylist,
    previousSource: prevSource,
    previousIndex: prevIndex,
    candidatePlaylist: snapshot.playlist,
    candidateSource: snapshot.playlistSource,
    allowApiFetch,
    now,
    onAlign
  });
  const nextPlaylist = stabilized.playlist;
  const nextSource = stabilized.source;
  if (snapshot.flags.metadataAlignedWithSource) {
    applyResolvedMetadata(
      state,
      hydrateMetadataResolutionFromPlaylistTrack(snapshot.metadataResolution, nextPlaylist, nextSource)
    );
  }

  state.playlist = applyPlaylistSort(nextPlaylist);
  if (!state.originDetachedFromPage) {
    applyPlaylistAlignment(state, onAlign);
  }
  state.playlistSource = nextSource;

  if (
    prevSource !== state.playlistSource ||
    prevTracks !== state.playlist.tracks.length ||
    prevIndex !== state.playlist.currentIndex
  ) {
    recordTransportPlaylistRefresh(
      state.transportDebug,
      `${prevSource} -> ${state.playlistSource}, tracks ${prevTracks} -> ${state.playlist.tracks.length}, current ${prevIndex} -> ${state.playlist.currentIndex}, allowApi=${allowApiFetch ? '1' : '0'}`
    );
  }
}


export function buildPanelInput(
  state: PlayerState,
  settingsSnapshot: {
    preloadTracksEnabled: boolean;
    keyAnalysisEnabled: boolean;
    listeningModeEnabled: boolean;
    autoPlayEnabled: boolean;
    performanceModeEnabled: boolean;
    keyboardShortcuts?: PanelInput['keyboardShortcuts'];
  }
): PanelInput {
  const audio = state.detachedPlaybackActive ? null : state.activeAudio;
  const fallback = state.bridgeAudioState;
  const currentSrc = String(state.currentSrc || '').trim();
  const audioSrc = String(audio?.currentSrc || audio?.src || '').trim();
  const fallbackSrc = String(fallback?.src || '').trim();
  const fallbackFresh = Boolean(fallback && Date.now() - fallback.ts <= 3000);
  const fallbackMatchesCurrent = Boolean(
    fallbackSrc &&
    currentSrc &&
    sourcesShareTrackIdentity(fallbackSrc, currentSrc)
  );
  const fallbackForCurrent = Boolean(
    fallbackMatchesCurrent &&
    (
      fallbackFresh ||
      (state.runtimePlaybackOwned && fallback?.origin === 'runtime')
    )
  );
  const audioMatchesCurrent = Boolean(
    audioSrc &&
    currentSrc &&
    sourcesShareTrackIdentity(audioSrc, currentSrc)
  );
  const audioStaleForCurrent = Boolean(audio && currentSrc && audioSrc && !audioMatchesCurrent);
  const preferBridgePlaybackState = Boolean(
    fallbackForCurrent &&
    (
      state.runtimePlaybackOwned ||
      // If the DOM audio is stale for the current track, the bridge snapshot is
      // the only trustworthy playhead source. When the DOM audio is merely
      // paused, keep using it so an older observer snapshot cannot pull the
      // waveform backward right after a pause or seek.
      audioStaleForCurrent
    )
  );
  const selectedSource: 'audio' | 'bridge' = preferBridgePlaybackState ? 'bridge' : 'audio';
  const selectedReason = preferBridgePlaybackState
    ? (
      state.runtimePlaybackOwned
        ? 'bridge-runtime-owned'
        : (audioStaleForCurrent ? 'bridge-current-audio-stale' : 'bridge-current-audio-paused')
    )
    : (fallbackForCurrent ? 'audio-preferred-over-bridge' : 'audio-only');
  const fallbackDurationSec = Number.isFinite(fallback?.durationSec) ? Number(fallback?.durationSec || 0) : 0;
  const fallbackBaseCurrentSec = Number.isFinite(fallback?.currentTimeSec) ? Number(fallback?.currentTimeSec || 0) : 0;
  const fallbackElapsedSec =
    fallbackForCurrent && fallback && !fallback.paused
      ? Math.max(0, (Date.now() - fallback.ts) / 1000)
      : 0;
  const fallbackCurrentSecRaw = fallbackBaseCurrentSec + fallbackElapsedSec;
  const fallbackCurrentSec =
    fallbackDurationSec > 0
      ? Math.min(fallbackDurationSec, fallbackCurrentSecRaw)
      : fallbackCurrentSecRaw;
  const duration = preferBridgePlaybackState
    ? (
      state.runtimePlaybackOwned
        ? (fallbackDurationSec || audio?.duration || 0)
        : (audioStaleForCurrent ? fallbackDurationSec : (fallbackDurationSec || audio?.duration || 0))
    )
    : (audioStaleForCurrent ? fallbackDurationSec : (audio?.duration || fallbackDurationSec || 0));
  const current = preferBridgePlaybackState
    ? (
      state.runtimePlaybackOwned
        ? fallbackCurrentSec
        : (audioStaleForCurrent ? fallbackCurrentSec : (fallbackCurrentSec || audio?.currentTime || 0))
    )
    : (audioStaleForCurrent ? 0 : (audio?.currentTime || fallbackCurrentSec || 0));
  const volumeRaw = preferBridgePlaybackState
    ? (fallback?.volume ?? audio?.volume ?? 1)
    : (audio?.volume ?? fallback?.volume ?? 1);
  const muted = preferBridgePlaybackState
    ? Boolean(fallback?.muted ?? audio?.muted ?? false)
    : Boolean(audio?.muted ?? fallback?.muted ?? false);
  const volume = Number.isFinite(volumeRaw) ? Math.max(0, Math.min(1, Number(volumeRaw))) : 1;
  const isPlayingFromAudio = Boolean(audio && !audio.paused && !audio.ended);
  const isPlayingFromBridge = Boolean(fallbackForCurrent && !fallback?.paused && fallbackSrc);
  const selectedFraction = duration > 0 ? current / duration : 0;
  const seekPendingAgeMs = state.pendingSeekAtMs > 0 ? Math.max(0, Date.now() - state.pendingSeekAtMs) : null;
  if (seekPendingAgeMs !== null && seekPendingAgeMs > PLAYHEAD_SEEK_PENDING_UI_WINDOW_MS) {
    state.seekWaitOverlayActive = false;
  }
  const pendingSeekFraction =
    state.pendingSeekFraction !== null && Number.isFinite(state.pendingSeekFraction)
      ? Math.max(0, Math.min(1, state.pendingSeekFraction))
      : null;
  const seekPending = Boolean(
    state.seekWaitOverlayActive &&
    !state.runtimePlaybackOwned &&
    pendingSeekFraction !== null &&
    seekPendingAgeMs !== null &&
    seekPendingAgeMs <= PLAYHEAD_SEEK_PENDING_UI_WINDOW_MS
  );

  updatePlayheadDebug(state, {
    selectedSource,
    selectedReason,
    selectedCurrentSec: current,
    selectedDurationSec: duration,
    selectedFraction,
    audioSrc,
    audioPaused: Boolean(audio?.paused ?? true),
    audioCurrentSec: Number.isFinite(audio?.currentTime) ? Number(audio?.currentTime || 0) : 0,
    audioDurationSec: Number.isFinite(audio?.duration) ? Number(audio?.duration || 0) : 0,
    bridgeSrc: fallbackSrc,
    bridgeOrigin: fallback?.origin || '-',
    bridgePaused: Boolean(fallback?.paused ?? true),
    bridgeCurrentSec: fallbackCurrentSec,
    bridgeDurationSec: fallbackDurationSec
  });

  // Single deterministic playhead rule: from the moment a seek is committed
  // until the authoritative playback position actually reaches the target, the
  // displayed playhead (and the numeric clock) hold at that target. The hold is
  // released by updatePlayheadDebug above — on position-settle, on settle-window
  // expiry, or on a track change (setCurrentSource). updatePlayheadDebug still
  // receives the raw observed position, so settle detection is unaffected.
  const seekHoldFraction =
    state.pendingSeekFraction !== null && Number.isFinite(state.pendingSeekFraction)
      ? Math.max(0, Math.min(1, state.pendingSeekFraction))
      : null;
  const renderedFraction = seekHoldFraction !== null ? seekHoldFraction : selectedFraction;
  const renderedCurrentSec =
    seekHoldFraction !== null && duration > 0 ? seekHoldFraction * duration : current;

  const likeState = state.likeViewState || DEFAULT_LIKE_VIEW_STATE;
  const playlistWithLikes = {
    ...state.playlist,
    tracks: applyLikeStatesToPlaylist(state.playlist.tracks, likeState)
  };
  // Suppress the album-open URL only on the album's own release page — there's
  // no point linking to the page you're already on. Idle hiding is decided once
  // in the panel, so there is no source/playback gate here.
  const isAlbumReleasePage = detectPageContext().pageType === 'album';
  const releasePageUrl = isAlbumReleasePage
    ? ''
    : normalizeAlbumPageUrl(playlistWithLikes.releasePageUrl);

  return {
    metadata: state.metadata,
    isPlaying: isPlayingFromAudio || isPlayingFromBridge,
    playheadFraction: renderedFraction,
    currentTimeSec: renderedCurrentSec,
    durationSec: duration,
    volume,
    muted,
    analysis: state.lastAnalysis,
    playlist: playlistWithLikes,
    releasePageUrl,
    likeState,
    preloadTracks: settingsSnapshot.preloadTracksEnabled,
    keyAnalysisEnabled: settingsSnapshot.keyAnalysisEnabled,
    listeningModeEnabled: settingsSnapshot.listeningModeEnabled,
    autoPlayEnabled: settingsSnapshot.autoPlayEnabled,
    performanceModeEnabled: settingsSnapshot.performanceModeEnabled,
    keyboardShortcuts: settingsSnapshot.keyboardShortcuts,
    tempoScale: state.tempoScale,
    tempoAdjust: buildTempoAdjustUiState(
      {
        offsetBpm: state.tempoAdjustOffsetBpm,
        masterTempoEnabled: state.tempoAdjustMasterTempoEnabled
      },
      state.lastAnalysis,
      playlistWithLikes,
      {
        controlsEnabled: isPlayerTempoAdjustReady(state)
      }
    ),
    likeNotice: state.likeNoticeText,
    waveformSeekMode: state.runtimePlaybackOwned ? 'continuous' : 'commit-on-release',
    seekPending,
    seekPendingFraction: seekPending ? pendingSeekFraction : null,
    runtimePlaylistPreparation: settingsSnapshot.preloadTracksEnabled
      ? resolveRuntimePlaylistPreparationUiState(playlistWithLikes, state.runtimeAudioEngineDebug)
      : undefined,
    runtimePlaylistSelectionPending: state.runtimePlaylistSelectionPending,
    uiPerformance: state.uiPerformanceDebug
  };
}

export function ensurePlaybackGateStarted(state: PlayerState): void {
  if (state.hasPlaybackStarted) {
    return;
  }

  if (isActivePlayback(state.activeAudio)) {
    state.hasPlaybackStarted = true;
  }
}

export function setCurrentSource(
  state: PlayerState,
  src: string,
  options: { clearNonReleaseSnapshot?: boolean } = {}
): void {
  if (src === state.currentSrc) {
    return;
  }

  // A real track change invalidates any in-flight seek hold: the committed
  // target belonged to the previous track. Release it so the playhead tracks
  // the new source from the start instead of holding a stale fraction.
  state.pendingSeekFraction = null;
  state.pendingSeekAtMs = 0;
  state.seekWaitOverlayActive = false;

  const shouldClearNonReleaseSnapshot = options.clearNonReleaseSnapshot !== false;
  state.playheadTransitionGuardUntilMs = src
    ? Date.now() + PLAYHEAD_SOURCE_TRANSITION_GUARD_MS
    : 0;
  state.currentSrc = src;
  state.sourceVersion += 1;
  if (shouldClearNonReleaseSnapshot) {
    state.nonReleaseSnapshot = null;
    state.nonReleaseSnapshotVersion = -1;
  }
}

export function refreshNonReleaseSnapshot(
  state: PlayerState,
  onAlign: (detail: string) => void,
  expectedSourceVersion?: number,
  allowApiFetch = true
): void {
  const now = Date.now();
  if (state.playlistJumpLockUntil > 0 && state.playlistJumpLockUntil <= now) {
    state.playlistJumpLockUntil = 0;
    state.playlistJumpLockTrackId = '';
  }

  if (typeof expectedSourceVersion === 'number' && expectedSourceVersion !== state.sourceVersion) {
    return;
  }

  if (!state.hasPlaybackStarted) {
    const prevSource = state.playlistSource;
    const prevTracks = state.playlist.tracks.length;
    state.metadata = { ...DEFAULT_TRACK_METADATA };
    state.metadataResolution = null;
    state.nonReleaseSnapshot = null;
    state.nonReleaseSnapshotVersion = -1;
    state.playlist = {
      ...DEFAULT_PLAYLIST_STATE,
      expanded: state.playlist.expanded,
      tracks: []
    };
    state.playlistSource = 'waiting-for-origin-play';

    if (prevSource !== state.playlistSource || prevTracks !== 0) {
      recordTransportPlaylistRefresh(
        state.transportDebug,
        `${prevSource} -> ${state.playlistSource}, tracks ${prevTracks} -> 0, allowApi=${allowApiFetch ? '1' : '0'}`
      );
    }
    return;
  }

  const snapshot = resolveOrReuseNonReleaseSnapshot(state, allowApiFetch);
  applyNonReleaseSnapshot(state, onAlign, snapshot, allowApiFetch);
}

function refreshNonReleaseMetadata(
  state: PlayerState,
  expectedSourceVersion?: number,
  allowApiFetch = true
): void {
  if (typeof expectedSourceVersion === 'number' && expectedSourceVersion !== state.sourceVersion) {
    return;
  }

  if (!state.hasPlaybackStarted) {
    state.metadata = { ...DEFAULT_TRACK_METADATA };
    state.metadataResolution = null;
    state.nonReleaseSnapshot = null;
    state.nonReleaseSnapshotVersion = -1;
    return;
  }

  const snapshot = resolveOrReuseNonReleaseSnapshot(state, allowApiFetch);
  if (!snapshot.flags.metadataAlignedWithSource) {
    return;
  }
  applyResolvedMetadata(
    state,
    hydrateMetadataResolutionFromPlaylistTrack(snapshot.metadataResolution, state.playlist, state.playlistSource)
  );
}

export function refreshMetadata(state: PlayerState, expectedSourceVersion?: number, allowApiFetch = true): void {
  if ((isNonReleasePlayerContext() || state.forceUnifiedNonReleaseSnapshot) && useUnifiedNonReleaseSnapshotForPlayer(state)) {
    refreshNonReleaseMetadata(state, expectedSourceVersion, allowApiFetch);
    return;
  }

  state.nonReleaseSnapshot = null;
  state.nonReleaseSnapshotVersion = -1;
  if (!state.hasPlaybackStarted) {
    state.metadata = { ...DEFAULT_TRACK_METADATA };
    state.metadataResolution = null;
    return;
  }

  const resolution = resolveTrackMetadata({ currentSrc: state.currentSrc, allowApiFetch });
  if (typeof expectedSourceVersion === 'number' && expectedSourceVersion !== state.sourceVersion) {
    return;
  }

  if (!isMetadataResolutionAlignedWithSource(resolution, state.currentSrc)) {
    return;
  }

  applyResolvedMetadata(state, resolution);
}

export function applyPlaylistAlignment(
  state: PlayerState,
  onAlign: (detail: string) => void
): void {
  const result = alignPlaylistToCurrentPlayback(state.playlist, state.currentSrc, state.metadataResolution);
  if (!result.changed) {
    return;
  }

  const lockTrackId = String(state.playlistJumpLockTrackId || '').trim();
  const lockActive = state.playlistJumpLockUntil > Date.now() && Boolean(lockTrackId);
  const currentTrackId = String(readTrackIdFromUrl(state.currentSrc) || '').trim();
  const lockPending = Boolean(lockActive && currentTrackId && currentTrackId !== lockTrackId);
  if (lockPending && result.reason === 'trackId') {
    const nextTrackId = String(state.playlist.tracks[result.nextIndex]?.trackId || '').trim();
    if (nextTrackId && nextTrackId !== lockTrackId) {
      return;
    }
  }

  state.playlist = result.playlist;
  onAlign(`${result.previousIndex} -> ${result.nextIndex} (${result.reason})`);
}

export function applyPlaylistCurrentIndex(
  state: PlayerState,
  nextIndex: number,
  onAlign: (detail: string) => void,
  reason = 'ui-selection'
): void {
  const result = setPlaylistCurrentIndex(state.playlist, nextIndex);
  if (!result.changed) {
    return;
  }

  state.playlist = result.playlist;
  onAlign(`${result.previousIndex} -> ${result.nextIndex} (${reason})`);
}

export function refreshPlaylist(
  state: PlayerState,
  onAlign: (detail: string) => void,
  allowApiFetch = true
): void {
  if ((isNonReleasePlayerContext() || state.forceUnifiedNonReleaseSnapshot) && useUnifiedNonReleaseSnapshotForPlayer(state)) {
    refreshNonReleaseSnapshot(state, onAlign, undefined, allowApiFetch);
    return;
  }

  state.nonReleaseSnapshot = null;
  state.nonReleaseSnapshotVersion = -1;
  const now = Date.now();
  if (state.playlistJumpLockUntil > 0 && state.playlistJumpLockUntil <= now) {
    state.playlistJumpLockUntil = 0;
    state.playlistJumpLockTrackId = '';
  }

  if (!state.hasPlaybackStarted) {
    const prevSource = state.playlistSource;
    const prevTracks = state.playlist.tracks.length;
    state.playlist = {
      ...DEFAULT_PLAYLIST_STATE,
      expanded: state.playlist.expanded,
      tracks: []
    };
    state.playlistSource = 'waiting-for-origin-play';

    if (prevSource !== state.playlistSource || prevTracks !== 0) {
      recordTransportPlaylistRefresh(
        state.transportDebug,
        `${prevSource} -> ${state.playlistSource}, tracks ${prevTracks} -> 0, allowApi=${allowApiFetch ? '1' : '0'}`
      );
    }

    return;
  }

  const prevSource = state.playlistSource;
  const prevTracks = state.playlist.tracks.length;
  const prevIndex = state.playlist.currentIndex;
  const previousPlaylist = state.playlist;
  const { playlist, source } = resolvePlayerPlaylistFromGlobals(
    state.currentSrc,
    previousPlaylist,
    state.metadataResolution,
    allowApiFetch
  );

  const stabilized = stabilizePlaylistDuringResolverTransition({
    state,
    previousPlaylist,
    previousSource: prevSource,
    previousIndex: prevIndex,
    candidatePlaylist: playlist,
    candidateSource: source,
    allowApiFetch,
    now,
    onAlign
  });
  const nextPlaylist = stabilized.playlist;
  const nextSource = stabilized.source;

  state.playlist = applyPlaylistSort(nextPlaylist);
  if (!state.originDetachedFromPage) {
    applyPlaylistAlignment(state, onAlign);
  }
  state.playlistSource = nextSource;

  if (
    prevSource !== state.playlistSource ||
    prevTracks !== state.playlist.tracks.length ||
    prevIndex !== state.playlist.currentIndex
  ) {
    recordTransportPlaylistRefresh(
      state.transportDebug,
      `${prevSource} -> ${state.playlistSource}, tracks ${prevTracks} -> ${state.playlist.tracks.length}, current ${prevIndex} -> ${state.playlist.currentIndex}, allowApi=${allowApiFetch ? '1' : '0'}`
    );
  }
}
