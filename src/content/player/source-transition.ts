import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import {
  playlistContainsSourceTrack,
  sourcesShareTrackIdentity
} from '@/content/playlist/track-identity';
import type { PlaylistTrack } from '@/shared/types';

export type SourceTransitionKind =
  | 'no-change'
  | 'origin-switch'
  | 'playlist-track-switch'
  | 'source-switch';

export interface SourceTransitionInput {
  previousSource: string;
  candidateSrc: string;
  origin: string;
  now: number;
  playlistTracks: PlaylistTrack[];
  playlistJumpLockUntil: number;
  playlistJumpLockTrackId: string;
  activeAudioPlaying: boolean;
  bridgeAudioPlaying: boolean;
  pauseSourceGuardUntil: number;
  forceUnifiedNonReleaseSnapshot: boolean;
  candidateIsPageRelease: boolean;
}

export interface SourceTransitionClassification {
  previousSource: string;
  candidateSrc: string;
  candidateTrackId: string;
  previousTrackId: string;
  sameTrackIdentityAsCurrent: boolean;
  sourceIdentityChanged: boolean;
  sourceOutsideCurrentPlaylist: boolean;
  jumpLockActive: boolean;
  sourceMatchesJumpLock: boolean;
  recentUserSelectionMatchesCandidate: boolean;
  playbackPausedOrIdle: boolean;
  sourceChanged: boolean;
  shouldIgnoreJumpLockRebound: boolean;
  shouldIgnorePausedSourceFlipFinal: boolean;
  shouldIgnorePauseStaleSwitchFinal: boolean;
  isOriginSwitch: boolean;
  isPlaylistTrackSwitch: boolean;
  transitionKind: SourceTransitionKind;
}

export function classifySourceTransition(
  input: SourceTransitionInput
): SourceTransitionClassification {
  const previousSource = String(input.previousSource || '').trim();
  const candidateSrc = String(input.candidateSrc || '').trim();
  const sameTrackIdentityAsCurrent = sourcesShareTrackIdentity(previousSource, candidateSrc);
  const candidateTrackId = readTrackIdFromUrl(candidateSrc);
  const previousTrackId = readTrackIdFromUrl(previousSource);
  const sourceIdentityChanged = Boolean(previousSource && candidateSrc && !sameTrackIdentityAsCurrent);
  const sourceOutsideCurrentPlaylist = Boolean(
    sourceIdentityChanged &&
    (
      input.playlistTracks.length === 0 ||
      (
        playlistContainsSourceTrack(input.playlistTracks, previousSource) &&
        !playlistContainsSourceTrack(input.playlistTracks, candidateSrc)
      )
    )
  );
  const jumpLockActive = input.playlistJumpLockUntil > input.now && Boolean(input.playlistJumpLockTrackId);
  const sourceMatchesJumpLock = Boolean(
    jumpLockActive &&
    candidateTrackId &&
    input.playlistJumpLockTrackId &&
    candidateTrackId === input.playlistJumpLockTrackId
  );
  const playbackPausedOrIdle = !input.activeAudioPlaying && !input.bridgeAudioPlaying;
  const sourceChanged = sourceIdentityChanged;
  const shouldIgnoreJumpLockRebound = Boolean(
    sourceChanged &&
    !sourceOutsideCurrentPlaylist &&
    jumpLockActive &&
    !sourceMatchesJumpLock &&
    previousTrackId &&
    input.playlistJumpLockTrackId &&
    previousTrackId === input.playlistJumpLockTrackId &&
    input.origin === 'source-changed'
  );
  const authoritativeSourceEvent =
    input.origin === 'source-changed' || input.origin === 'audio-changed';
  const shouldIgnorePausedSourceFlip =
    !authoritativeSourceEvent && sourceChanged && playbackPausedOrIdle && !sourceMatchesJumpLock;
  const shouldIgnorePauseStaleSwitch =
    !authoritativeSourceEvent &&
    sourceOutsideCurrentPlaylist &&
    !sourceMatchesJumpLock &&
    (input.now <= input.pauseSourceGuardUntil || playbackPausedOrIdle);
  const forceDetachCandidate =
    input.forceUnifiedNonReleaseSnapshot &&
    candidateSrc &&
    !input.candidateIsPageRelease;
  const shouldIgnorePausedSourceFlipFinal = !forceDetachCandidate && shouldIgnorePausedSourceFlip;
  const shouldIgnorePauseStaleSwitchFinal = !forceDetachCandidate && shouldIgnorePauseStaleSwitch;
  const isOriginSwitch = sourceChanged && sourceOutsideCurrentPlaylist && !sourceMatchesJumpLock;
  const isPlaylistTrackSwitch = sourceChanged && !sourceOutsideCurrentPlaylist;
  const transitionKind = !sourceChanged
    ? 'no-change'
    : isOriginSwitch
      ? 'origin-switch'
      : isPlaylistTrackSwitch
        ? 'playlist-track-switch'
        : 'source-switch';

  return {
    previousSource,
    candidateSrc,
    candidateTrackId,
    previousTrackId,
    sameTrackIdentityAsCurrent,
    sourceIdentityChanged,
    sourceOutsideCurrentPlaylist,
    jumpLockActive,
    sourceMatchesJumpLock,
    recentUserSelectionMatchesCandidate: sourceMatchesJumpLock,
    playbackPausedOrIdle,
    sourceChanged,
    shouldIgnoreJumpLockRebound,
    shouldIgnorePausedSourceFlipFinal,
    shouldIgnorePauseStaleSwitchFinal,
    isOriginSwitch,
    isPlaylistTrackSwitch,
    transitionKind
  };
}
