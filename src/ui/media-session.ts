import type { PanelHandlers, PanelInput } from '@/shared/types';
import { isExtensionContextValid, onExtensionContextInvalidated } from '@/utils/extension-context';

// Browser media sessions follow playback. Manifest commands reserve keys even
// with no playing tab, so they must never be used for hardware media controls.
const ACTIONS = ['pause', 'previoustrack', 'nexttrack'] as const;

export function createPanelMediaSessionController(
  handlers: PanelHandlers
): { sync(input: PanelInput): void; destroy(): void } {
  const mediaSession = navigator.mediaSession;
  const registeredActions = new Set<MediaSessionAction>();
  let active = false;
  let destroyed = false;
  let generation = 0;
  let pauseRequested = false;

  const release = (): void => {
    if (!active || !mediaSession) {
      return;
    }
    active = false;
    generation += 1;
    registeredActions.forEach((action) => {
      mediaSession.setActionHandler(action, null);
    });
    registeredActions.clear();
    mediaSession.playbackState = 'none';
    mediaSession.metadata = null;
  };

  const dispatch = (action: typeof ACTIONS[number], registeredGeneration: number): void => {
    // A queued browser callback can arrive after playback has stopped or after
    // the extension has been reloaded. It must not start or select a track.
    if (destroyed || !active || registeredGeneration !== generation) {
      return;
    }
    if (!isExtensionContextValid() || !handlers.isPlaybackActive()) {
      release();
      return;
    }
    if (action === 'pause') {
      pauseRequested = true;
      release();
      handlers.onTogglePlayPause();
    } else if (action === 'previoustrack') {
      handlers.onPrevTrack();
    } else {
      handlers.onNextTrack();
    }
  };

  const unsubscribe = onExtensionContextInvalidated(release);
  const onPageHide = (): void => release();
  window.addEventListener('pagehide', onPageHide);

  return {
    sync(input) {
      if (destroyed || !mediaSession) {
        return;
      }
      if (!input.isPlaying || !handlers.isPlaybackActive() || !isExtensionContextValid()) {
        pauseRequested = false;
        release();
        return;
      }
      // Runtime pause is asynchronous. Do not reclaim controls from a playing
      // snapshot until the requested pause has actually been observed.
      if (pauseRequested) {
        return;
      }
      if (!active) {
        active = true;
        const registeredGeneration = generation;
        ACTIONS.forEach((action) => {
          try {
            mediaSession.setActionHandler(action, () => dispatch(action, registeredGeneration));
            registeredActions.add(action);
          } catch (error) {
            // An unsupported action is an explicit API capability gap, not a
            // reason to reserve the key through extension commands instead.
            if (!(error instanceof DOMException) || error.name !== 'NotSupportedError') {
              throw error;
            }
          }
        });
      }
      mediaSession.playbackState = 'playing';
      if (typeof MediaMetadata === 'function') {
        mediaSession.metadata = new MediaMetadata({
          title: String(input.metadata?.trackTitle || input.metadata?.combined || 'Bandcamp Deck'),
          artist: String(input.metadata?.artistName || ''),
          album: String(input.metadata?.albumTitle || '')
        });
      }
    },
    destroy() {
      destroyed = true;
      release();
      unsubscribe();
      window.removeEventListener('pagehide', onPageHide);
    }
  };
}
