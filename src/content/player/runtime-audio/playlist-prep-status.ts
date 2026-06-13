import type { RuntimeAudioEngineDebugSnapshot } from '@/content/player/runtime-audio/types';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { RUNTIME_PREDECODE_DEFAULT_TRACKS } from '@/shared/runtime-predecode-policy';
import type {
  PlaylistState,
  PlaylistTrack,
  RuntimePlaylistPreparationUiState
} from '@/shared/types';

function isPlayablePrepTarget(track: PlaylistTrack | undefined): track is PlaylistTrack {
  if (!track || track.playable === false) {
    return false;
  }
  return Boolean(String(track.streamUrl || '').trim() || String(track.trackId || '').trim() || String(track.cacheKey || '').trim());
}

function buildRuntimePrepTargets(playlist: PlaylistState, windowTracks: number): PlaylistTrack[] {
  const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  if (!tracks.length) {
    return [];
  }
  const startIndex = Number.isInteger(playlist.currentIndex)
    ? Math.max(0, Math.min(tracks.length - 1, playlist.currentIndex))
    : 0;
  const windowSize = Math.min(tracks.length, Math.max(0, windowTracks));
  const targets: PlaylistTrack[] = [];
  for (let offset = 0; offset < windowSize; offset += 1) {
    const index = (startIndex + offset) % tracks.length;
    const track = tracks[index];
    if (isPlayablePrepTarget(track)) {
      targets.push(track);
    }
  }
  return targets;
}

function runtimeEntryMatchesTrack(
  entry: RuntimeAudioEngineDebugSnapshot['entries'][number],
  track: PlaylistTrack
): boolean {
  const trackCacheKey = String(track.cacheKey || '').trim();
  const entryCacheKey = String(entry.cacheKey || '').trim();
  if (trackCacheKey && entryCacheKey && trackCacheKey === entryCacheKey) {
    return true;
  }

  const streamUrl = String(track.streamUrl || '').trim();
  if (streamUrl && sourcesShareTrackIdentity(streamUrl, entry.url)) {
    return true;
  }

  const trackId = String(track.trackId || '').trim();
  return Boolean(trackId && entry.url.includes(`track_id=${encodeURIComponent(trackId)}`));
}

export function resolveRuntimePlaylistPreparationUiState(
  playlist: PlaylistState,
  runtimeAudioEngineDebug: RuntimeAudioEngineDebugSnapshot | null | undefined
): RuntimePlaylistPreparationUiState {
  const windowTracks = Math.max(
    0,
    Number(runtimeAudioEngineDebug?.predecodeWindowTracks) ||
      Number(runtimeAudioEngineDebug?.maxPrepared) ||
      RUNTIME_PREDECODE_DEFAULT_TRACKS
  );
  const targets = buildRuntimePrepTargets(playlist, windowTracks);
  const entries = runtimeAudioEngineDebug?.entries || [];
  const prepared = targets.filter((track) => entries.some((entry) => runtimeEntryMatchesTrack(entry, track))).length;
  const total = targets.length;
  const active = Math.max(0, Number(runtimeAudioEngineDebug?.activePrepareCount) || 0);
  const capacity = Math.max(0, Number(runtimeAudioEngineDebug?.maxPrepared) || 0);
  const hasFailure = Boolean(runtimeAudioEngineDebug?.prepareFailureCount || runtimeAudioEngineDebug?.lastPrepareFailure);
  const incomplete = total > 0 && prepared < total;
  const status: RuntimePlaylistPreparationUiState['status'] =
    // Full capacity can include old entries being replaced for this playlist.
    incomplete && active > 0
      ? 'preparing'
      : (incomplete && hasFailure ? 'error' : 'idle');

  return {
    status,
    prepared,
    total,
    active,
    capacity,
    detail: status === 'error'
      ? String(runtimeAudioEngineDebug?.lastPrepareFailure || 'prepare-failed')
      : `${prepared}/${total} prepared`
  };
}
