import { getRootPlaylistProbeStatus } from '@/content/metadata/extractor';
import { PlayerState } from '@/content/player/state';

interface CreatePlaylistProbeInput {
  state: PlayerState;
  enabled: boolean;
  refreshPlaylistCacheOnly(): void;
  requestRender(): void;
}

export interface PlaylistProbeController {
  sync(version?: number): void;
  start(version: number): void;
  finish(version: number): void;
  cancel(): void;
}

export function createPlaylistProbeController(input: CreatePlaylistProbeInput): PlaylistProbeController {
  const { state, enabled, refreshPlaylistCacheOnly, requestRender } = input;
  let watchId: number | null = null;
  let probeVersion = -1;

  const cancel = (): void => {
    if (watchId === null) {
      return;
    }

    window.clearTimeout(watchId);
    watchId = null;
  };

  const sync = (version = state.sourceVersion): void => {
    if (!enabled || version !== probeVersion || version !== state.sourceVersion) {
      return;
    }

    const probe = getRootPlaylistProbeStatus(state.currentSrc);
    // The probe stays "pending" while it hunts for a larger root playlist (e.g. a
    // linked parent album). That must not mark the player as loading once we already
    // have resolved tracks to show — otherwise a never-resolving/foreign album link
    // leaves the header stuck on "Loading...". Loading is only true when empty.
    state.playlist = {
      ...state.playlist,
      loading: probe.pending && state.playlist.tracks.length === 0
    };

    if (!probe.pending) {
      cancel();
      return;
    }

    cancel();
    watchId = window.setTimeout(() => {
      watchId = null;
      if (version !== state.sourceVersion || version !== probeVersion) {
        return;
      }

      // Cache-only tick: reflect async probe progress without creating extra request pressure.
      refreshPlaylistCacheOnly();
      sync(version);
      requestRender();
    }, Math.max(220, probe.nextCheckMs));
  };

  return {
    sync,

    start(version: number): void {
      if (!enabled) {
        return;
      }

      cancel();
      probeVersion = version;
      sync(version);
    },

    finish(version: number): void {
      if (!enabled || version !== probeVersion) {
        return;
      }

      cancel();
      sync(version);
    },

    cancel
  };
}
