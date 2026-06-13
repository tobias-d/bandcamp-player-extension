import { createLogger } from '@/utils/debug';
import { sendDiscoverAudioCommand } from '@/content/discover/origin-bridge';
import {
  TEMPO_ADJUST_DEFAULT_MASTER_TEMPO,
  TEMPO_ADJUST_MAX_PLAYBACK_RATE,
  TEMPO_ADJUST_MIN_PLAYBACK_RATE
} from '@/shared/tempo-adjust';

const logger = createLogger('AUDIO');
const NATIVE_TRANSITION_RESTORE_FALLBACK_MS = 260;
const NATIVE_TRANSITION_RESTORE_AFTER_EVENT_MS = 35;
const NATIVE_TRANSITION_RESTORE_RAMP_MS = 70;
const NATIVE_TRANSITION_RESTORE_STEPS = 5;
const NATIVE_SEEK_DISPATCH_DELAY_MS = 24;

interface NativeTransitionRestoreState {
  previousMuted: boolean;
  previousVolume: number;
  timerIds: number[];
  cleanup?: () => void;
}

export interface AudioBridgeCallbacks {
  onAudioChanged(audio: HTMLAudioElement | null): void;
  onAudioStateChanged(audio: HTMLAudioElement | null, eventType?: string): void;
  onSourceChanged(src: string): void;
}

export interface AudioBridge {
  ensureActiveAudio(): HTMLAudioElement | null;
  getActiveAudio(): HTMLAudioElement | null;
  togglePlayPause(): void;
  setVolume(volume: number, options?: { transient?: boolean }): void;
  setMuted(muted: boolean, options?: { transient?: boolean }): void;
  applyTempoAdjust(playbackRate: number, masterTempoEnabled: boolean): void;
  prepareNativeTransition(reason: string): void;
  prepareRuntimeTakeover(): void;
  pause(): void;
  loadTrack(streamUrl: string, options?: { detached?: boolean }): boolean;
  seekToFraction(fraction: number): void;
  skipTrack(direction: 1 | -1): void;
  destroy(): void;
}

function isPlaying(audio: HTMLAudioElement): boolean {
  return !audio.paused && !audio.ended && Boolean(audio.currentSrc || audio.src);
}

function hasSource(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && (audio.currentSrc || audio.src));
}

type PitchCapableAudioElement = HTMLAudioElement & {
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

function clampPlaybackRate(playbackRate: number): number {
  if (!Number.isFinite(playbackRate)) {
    return 1;
  }
  return Math.min(TEMPO_ADJUST_MAX_PLAYBACK_RATE, Math.max(TEMPO_ADJUST_MIN_PLAYBACK_RATE, playbackRate));
}

function setAudioPreservesPitch(audio: HTMLAudioElement, enabled: boolean): void {
  const pitchAudio = audio as PitchCapableAudioElement;
  audio.preservesPitch = enabled;
  pitchAudio.mozPreservesPitch = enabled;
  pitchAudio.webkitPreservesPitch = enabled;
}

function readTrackIdFromSource(rawSrc: string): string {
  const src = String(rawSrc || '').trim();
  if (!src) {
    return '';
  }
  try {
    const parsed = new URL(src, window.location.href);
    const fromParam = parsed.searchParams.get('track_id') || parsed.searchParams.get('trackid') || '';
    if (fromParam) {
      return fromParam.trim();
    }
  } catch {
    // Ignore URL parse errors and continue with regex fallback.
  }

  const match =
    src.match(/[?&]track_id=(\d+)/i) ||
    src.match(/[?&]trackid=(\d+)/i) ||
    src.match(/\/track\/(\d+)\b/i);
  return match?.[1] ? String(match[1]).trim() : '';
}

function isInterruptedNativePlay(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { name?: unknown; message?: unknown };
  if (err.name !== 'AbortError') {
    return false;
  }
  const message = typeof err.message === 'string' ? err.message : '';
  return message.includes('play() request was interrupted');
}

export function createAudioBridge(callbacks: AudioBridgeCallbacks): AudioBridge {
  let activeAudio: HTMLAudioElement | null = null;
  let detachedAudio: HTMLAudioElement | null = null;
  let lastSource = '';
  let lastScanSignature = '';
  let desiredPlaybackRate = 1;
  let desiredMasterTempoEnabled = TEMPO_ADJUST_DEFAULT_MASTER_TEMPO;
  let bridgeDetachedSrc = '';
  const nativeTransitionRestoreStates = new WeakMap<HTMLAudioElement, NativeTransitionRestoreState>();

  const bound = new WeakSet<HTMLAudioElement>();
  const observer = new MutationObserver((mutations) => {
    const audioTouched = mutations.some((mutation) => {
      const touchedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
      return touchedNodes.some((node) => {
        if (node instanceof HTMLAudioElement) {
          return true;
        }
        return node instanceof Element && Boolean(node.querySelector('audio'));
      });
    });
    if (!audioTouched) {
      return;
    }
    ensureActiveAudio();
  });

  function buildScanSignature(audio: HTMLAudioElement | null): string {
    if (!audio) {
      return 'none';
    }
    const src = audio.currentSrc || audio.src || '-';
    const paused = audio.paused ? '1' : '0';
    const ended = audio.ended ? '1' : '0';
    const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration * 10) / 10 : '-';
    return `${src}|p=${paused}|e=${ended}|d=${duration}`;
  }

  function pauseAudio(audio: HTMLAudioElement | null): void {
    if (!audio || audio.paused || audio.ended) {
      return;
    }
    try {
      audio.pause();
    } catch {
      // Ignore pause failures from autoplay policy or stale elements.
    }
  }

  function playAudio(audio: HTMLAudioElement, label: string, restore?: () => void): void {
    try {
      const playPromise = audio.play();
      playPromise.catch((error) => {
        restore?.();
        if (isInterruptedNativePlay(error)) {
          logger.debug(`${label} interrupted by native audio source transition`, error);
          return;
        }
        logger.warn(`${label} failed`, error);
      });
    } catch (error) {
      restore?.();
      logger.warn(`${label} failed`, error);
    }
  }

  function clearNativeTransitionRestore(audio: HTMLAudioElement | null): NativeTransitionRestoreState | null {
    if (!audio) {
      return null;
    }
    const state = nativeTransitionRestoreStates.get(audio);
    if (!state) {
      return null;
    }
    state.timerIds.forEach((timerId) => window.clearTimeout(timerId));
    state.cleanup?.();
    nativeTransitionRestoreStates.delete(audio);
    return state;
  }

  function armNativeTransitionSilence(audio: HTMLAudioElement, reason: string): () => void {
    const pending = clearNativeTransitionRestore(audio);

    const previousMuted = pending?.previousMuted ?? Boolean(audio.muted);
    const previousVolume = pending?.previousVolume ?? (Number.isFinite(audio.volume) ? Number(audio.volume) : 1);
    const safePreviousVolume = Math.max(0, Math.min(1, previousVolume));
    const timerIds: number[] = [];
    let restored = false;
    const restore = (): void => {
      if (restored) {
        return;
      }
      restored = true;
      clearNativeTransitionRestore(audio);

      if (previousMuted || safePreviousVolume <= 0) {
        try {
          audio.volume = safePreviousVolume;
        } catch {
          // Ignore restore failures on stale audio.
        }
        try {
          audio.muted = previousMuted;
        } catch {
          // Ignore restore failures on stale audio.
        }
        return;
      }

      const startVolume = Number.isFinite(audio.volume) ? Math.max(0, Math.min(1, Number(audio.volume))) : 0;
      for (let step = 1; step <= NATIVE_TRANSITION_RESTORE_STEPS; step += 1) {
        const timerId = window.setTimeout(() => {
          const progress = step / NATIVE_TRANSITION_RESTORE_STEPS;
          const nextVolume = startVolume + (safePreviousVolume - startVolume) * progress;
          try {
            audio.volume = Math.max(0, Math.min(1, nextVolume));
          } catch {
            // Ignore restore failures on stale audio.
          }
          if (step === NATIVE_TRANSITION_RESTORE_STEPS) {
            try {
              audio.muted = previousMuted;
            } catch {
              // Ignore restore failures on stale audio.
            }
            nativeTransitionRestoreStates.delete(audio);
          }
        }, Math.round((NATIVE_TRANSITION_RESTORE_RAMP_MS / NATIVE_TRANSITION_RESTORE_STEPS) * step));
        timerIds.push(timerId);
      }
    };

    if (!previousMuted && safePreviousVolume > 0) {
      try {
        audio.volume = 0;
      } catch {
        // Ignore volume change failures.
      }
    }

    const fallbackTimerId = window.setTimeout(restore, NATIVE_TRANSITION_RESTORE_FALLBACK_MS);
    timerIds.push(fallbackTimerId);
    nativeTransitionRestoreStates.set(audio, {
      previousMuted,
      previousVolume: safePreviousVolume,
      timerIds
    });
    logger.debug(`Native transition silence armed reason=${reason}`);
    return () => {
      const timerId = window.setTimeout(() => {
        restore();
      }, NATIVE_TRANSITION_RESTORE_AFTER_EVENT_MS);
      timerIds.push(timerId);
    };
  }

  function restoreNativeTransitionOnEvents(
    audio: HTMLAudioElement,
    restore: () => void,
    eventTypes: string[]
  ): void {
    const restoreAfterEvent = (): void => {
      restore();
    };
    const cleanup = (): void => {
      eventTypes.forEach((eventType) => {
        try {
          audio.removeEventListener(eventType, restoreAfterEvent);
        } catch {
          // Ignore listener cleanup failures on stale audio.
        }
      });
    };
    eventTypes.forEach((eventType) => {
      try {
        audio.addEventListener(eventType, restoreAfterEvent, { once: true });
      } catch {
        // Ignore listener attachment failures and rely on fallback restore timer.
      }
    });
    const state = nativeTransitionRestoreStates.get(audio);
    if (state) {
      state.cleanup = cleanup;
    }
  }

  function prepareNativeTransition(reason: string): void {
    const audio = ensureActiveAudio();
    if (!audio || audio.paused || audio.ended) {
      return;
    }
    const restore = armNativeTransitionSilence(audio, reason);
    restoreNativeTransitionOnEvents(audio, restore, ['playing', 'timeupdate', 'loadedmetadata', 'seeked']);
  }

  function pauseAllKnownAudios(except: HTMLAudioElement | null): void {
    Array.from(document.querySelectorAll('audio')).forEach((audio) => {
      const typed = audio as HTMLAudioElement;
      if (typed === except) {
        return;
      }
      pauseAudio(typed);
    });
    if (detachedAudio && detachedAudio !== except) {
      pauseAudio(detachedAudio);
    }
  }

  function applyTempoConfig(audio: HTMLAudioElement | null): void {
    if (!audio) {
      return;
    }
    try {
      audio.playbackRate = desiredPlaybackRate;
    } catch {
      // Ignore unsupported playbackRate assignments.
    }
    try {
      setAudioPreservesPitch(audio, desiredMasterTempoEnabled);
    } catch {
      // Ignore unsupported pitch preservation assignments.
    }
  }

  function ensureDetachedAudio(): HTMLAudioElement | null {
    if (detachedAudio && !detachedAudio.ended) {
      bindAudio(detachedAudio);
      applyTempoConfig(detachedAudio);
      return detachedAudio;
    }
    try {
      detachedAudio = new Audio();
      bindAudio(detachedAudio);
      applyTempoConfig(detachedAudio);
      return detachedAudio;
    } catch {
      return null;
    }
  }

  function pickActiveAudio(): HTMLAudioElement | null {
    const audios = Array.from(document.querySelectorAll('audio')) as HTMLAudioElement[];
    const detachedPlaying = detachedAudio && isPlaying(detachedAudio) ? detachedAudio : null;

    const playing = audios.find((audio) => isPlaying(audio));
    if (playing) {
      return playing;
    }
    if (detachedPlaying) {
      return detachedPlaying;
    }

    if (
      activeAudio &&
      ((activeAudio === detachedAudio) || document.contains(activeAudio)) &&
      !activeAudio.ended &&
      hasSource(activeAudio)
    ) {
      return activeAudio;
    }

    const ready = audios.find((audio) => audio.readyState > 0 && Boolean(audio.currentSrc || audio.src));
    if (ready) {
      return ready;
    }
    if (detachedAudio && detachedAudio.readyState > 0 && hasSource(detachedAudio)) {
      return detachedAudio;
    }

    const withSrc = audios.find((audio) => Boolean(audio.currentSrc || audio.src));
    if (withSrc) {
      return withSrc;
    }
    if (detachedAudio && hasSource(detachedAudio)) {
      return detachedAudio;
    }

    return audios[0] ?? detachedAudio ?? null;
  }

  function notifySource(audio: HTMLAudioElement | null): void {
    const src = audio?.currentSrc || audio?.src || '';
    if (src === lastSource) {
      return;
    }
    lastSource = src;
    callbacks.onSourceChanged(src);
  }

  function notifySourceValue(src: string): void {
    if (src === lastSource) {
      return;
    }
    lastSource = src;
    callbacks.onSourceChanged(src);
  }

  function isBridgeDetachedActive(): boolean {
    return Boolean(String(bridgeDetachedSrc || '').trim());
  }

  function clearBridgeDetachedControl(): void {
    bridgeDetachedSrc = '';
  }

  function clickElement(element: HTMLElement | null): boolean {
    if (!element) {
      return false;
    }
    try {
      element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }));
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
      element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, composed: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
      element.click();
      return true;
    } catch {
      return false;
    }
  }

  function isUsableControl(element: HTMLElement | null): boolean {
    if (!element) {
      return false;
    }
    if (element.matches('[disabled], [aria-disabled="true"], .disabled')) {
      return false;
    }
    return true;
  }

  function getPlaybackRoots(): HTMLElement[] {
    const seen = new Set<HTMLElement>();
    const roots: HTMLElement[] = [];
    const addRoot = (element: Element | null): void => {
      if (!(element instanceof HTMLElement) || seen.has(element)) {
        return;
      }
      seen.add(element);
      roots.push(element);
    };

    const activeSelectors = [
      '.track_play_waypoint.playing',
      '.waypoint.track_play_waypoint.playing',
      '.waypoint.playing',
      '.story.playing',
      '.story-innards.playing',
      '.track_play_hilite.playing',
      '.collection-item-container.track_play_hilite',
      '.story-innards.collection-item-container.track_play_hilite',
      '#track_play_waypoint',
      '#footer-player',
      '.play_status',
      '#collection-player',
      '.collection-player'
    ];

    const currentSrc = activeAudio?.currentSrc || activeAudio?.src || '';
    const currentTrackId = readTrackIdFromSource(currentSrc);
    if (currentTrackId) {
      const escapedTrackId =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(currentTrackId)
          : currentTrackId;
      document
        .querySelectorAll(`[data-trackid="${escapedTrackId}"], [data-track-id="${escapedTrackId}"]`)
        .forEach((element) => {
          const container = (element as HTMLElement).closest(
            '.story, .story-innards, .collection-item-container, .track_play_hilite'
          );
          addRoot(container ?? element);
        });
    }

    activeSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => addRoot(element));
    });

    return roots;
  }

  function clickGlobalPrevNext(direction: 1 | -1): boolean {
    const nextSelectors = [
      '#collection-player .nextbutton',
      '.collection-player .nextbutton',
      '#collection-player .next',
      '.collection-player .next',
      '#track_play_waypoint .nextbutton',
      '#track_play_waypoint .next',
      '#footer-player .nextbutton',
      '#footer-player .next',
      '.inline_player .nextbutton',
      '.inline_player .next',
      '.inlineplayer .nextbutton',
      '.inlineplayer .next',
      '.play_controls .nextbutton',
      '.play_controls .next',
      '.player .nextbutton',
      '.player .next',
      '[data-action*="next"]',
      '[aria-label*="Next"]',
      '[data-bind*="next"]'
    ];
    const prevSelectors = [
      '#collection-player .prevbutton',
      '.collection-player .prevbutton',
      '#collection-player .prev',
      '.collection-player .prev',
      '#track_play_waypoint .prevbutton',
      '#track_play_waypoint .prev',
      '#footer-player .prevbutton',
      '#footer-player .prev',
      '.inline_player .prevbutton',
      '.inline_player .prev',
      '.inlineplayer .prevbutton',
      '.inlineplayer .prev',
      '.play_controls .prevbutton',
      '.play_controls .prev',
      '.player .prevbutton',
      '.player .prev',
      '[data-action*="prev"]',
      '[aria-label*="Prev"]',
      '[aria-label*="Previous"]',
      '[data-bind*="prev"]',
      '[data-bind*="previous"]'
    ];

    const selectors = direction > 0 ? nextSelectors : prevSelectors;
    const playbackRoots = getPlaybackRoots();

    for (const root of playbackRoots) {
      for (const selector of selectors) {
        const controls = Array.from(root.querySelectorAll<HTMLElement>(selector));
        for (const control of controls) {
          if (!isUsableControl(control)) {
            continue;
          }
          if (clickElement(control)) {
            return true;
          }
        }
      }
    }

    for (const selector of selectors) {
      const controls = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const control of controls) {
        if (!isUsableControl(control)) {
          continue;
        }
        if (clickElement(control)) {
          return true;
        }
      }
    }

    return false;
  }

  function bindAudio(audio: HTMLAudioElement): void {
    if (bound.has(audio)) {
      return;
    }
    bound.add(audio);

    const onAnyEvent = (eventType = 'state'): void => {
      if (isBridgeDetachedActive() && audio !== detachedAudio) {
        return;
      }
      if (isPlaying(audio)) {
        activeAudio = audio;
      } else if (!activeAudio || !isPlaying(activeAudio)) {
        activeAudio = pickActiveAudio();
      }
      applyTempoConfig(activeAudio);
      lastScanSignature = buildScanSignature(activeAudio);
      callbacks.onAudioStateChanged(
        activeAudio,
        activeAudio && nativeTransitionRestoreStates.has(activeAudio)
          ? `${eventType}:native-transition-silence`
          : eventType
      );
      notifySource(activeAudio);
    };

    audio.addEventListener('play', () => {
      if (audio !== detachedAudio) {
        clearBridgeDetachedControl();
      }
      const previousActiveAudio = activeAudio;
      activeAudio = audio;
      notifySource(activeAudio);
      if (previousActiveAudio !== activeAudio) {
        callbacks.onAudioChanged(activeAudio);
      }
      pauseAllKnownAudios(audio);
      onAnyEvent('play');
    });

    ['pause', 'ended', 'emptied', 'timeupdate', 'seeking', 'seeked', 'durationchange', 'loadedmetadata'].forEach(
      (type) => {
        audio.addEventListener(type, () => onAnyEvent(type));
      }
    );
  }

  function ensureActiveAudio(): HTMLAudioElement | null {
    if (isBridgeDetachedActive()) {
      return null;
    }
    if (detachedAudio) {
      bindAudio(detachedAudio);
    }
    const next = pickActiveAudio();
    if (next) {
      bindAudio(next);
    }

    if (next !== activeAudio) {
      activeAudio = next;
      applyTempoConfig(activeAudio);
      callbacks.onAudioChanged(activeAudio);
      notifySource(activeAudio);
    }

    applyTempoConfig(activeAudio);
    const nextScanSignature = buildScanSignature(activeAudio);
    if (nextScanSignature !== lastScanSignature) {
      lastScanSignature = nextScanSignature;
      callbacks.onAudioStateChanged(activeAudio, 'scan');
    }
    return activeAudio;
  }

  observer.observe(document.body, {
    subtree: true,
    childList: true
  });

  const initial = ensureActiveAudio();
  if (!initial) {
    logger.debug('No audio element detected on init');
  }

  return {
    ensureActiveAudio,
    getActiveAudio() {
      if (isBridgeDetachedActive()) {
        return null;
      }
      return activeAudio;
    },
    togglePlayPause() {
      if (isBridgeDetachedActive()) {
        sendDiscoverAudioCommand('toggle-play-pause');
        return;
      }
      const audio = ensureActiveAudio();
      if (!audio) {
        return;
      }
      if (audio.paused) {
        const restore = armNativeTransitionSilence(audio, 'play');
        restoreNativeTransitionOnEvents(audio, restore, ['playing', 'timeupdate']);
        playAudio(audio, 'Play', restore);
        return;
      }
      audio.pause();
    },
    setVolume(volume, options) {
      if (isBridgeDetachedActive()) {
        const clamped = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
        sendDiscoverAudioCommand('set-volume', { volume: clamped, transient: Boolean(options?.transient) });
        return;
      }
      const audio = ensureActiveAudio();
      if (!audio) {
        return;
      }
      const clamped = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      audio.volume = clamped;
      if (clamped > 0 && audio.muted) {
        audio.muted = false;
      }
      callbacks.onAudioStateChanged(audio, 'volumechange');
    },
    setMuted(muted, options) {
      if (isBridgeDetachedActive()) {
        sendDiscoverAudioCommand('set-muted', { muted: Boolean(muted), transient: Boolean(options?.transient) });
        return;
      }
      const audio = ensureActiveAudio();
      if (!audio) {
        return;
      }
      audio.muted = Boolean(muted);
      callbacks.onAudioStateChanged(audio, 'volumechange');
    },
    applyTempoAdjust(playbackRate, masterTempoEnabled) {
      desiredPlaybackRate = clampPlaybackRate(playbackRate);
      desiredMasterTempoEnabled = Boolean(masterTempoEnabled);
      if (isBridgeDetachedActive()) {
        sendDiscoverAudioCommand('set-tempo-adjust', {
          playbackRate: desiredPlaybackRate,
          preservesPitch: desiredMasterTempoEnabled
        });
        return;
      }
      applyTempoConfig(ensureActiveAudio());
      if (detachedAudio && detachedAudio !== activeAudio) {
        applyTempoConfig(detachedAudio);
      }
      callbacks.onAudioStateChanged(activeAudio, 'tempoadjustchange');
    },
    prepareNativeTransition,
    prepareRuntimeTakeover() {
      // Fade any still-audible native origin element to 0 in the page context before a
      // runtime direct-start hard-pauses it. Sent regardless of bridge detached state.
      sendDiscoverAudioCommand('prepare-runtime-takeover');
    },
    pause() {
      if (isBridgeDetachedActive()) {
        sendDiscoverAudioCommand('pause');
        return;
      }
      const current = ensureActiveAudio();
      pauseAllKnownAudios(null);
      pauseAudio(current);
    },
    loadTrack(streamUrl, options) {
      const targetSrc = String(streamUrl || '').trim();
      if (!targetSrc) {
        return false;
      }
      const detached = Boolean(options?.detached);
      if (detached) {
        bridgeDetachedSrc = targetSrc;
        sendDiscoverAudioCommand('load-track', {
          streamUrl: targetSrc,
          detached: true
        });
        notifySourceValue(targetSrc);
        return true;
      }
      clearBridgeDetachedControl();
      const audio = detached ? ensureDetachedAudio() : ensureActiveAudio();
      if (!audio) {
        return false;
      }

      pauseAllKnownAudios(audio);
      const current = audio.currentSrc || audio.src || '';
      if (current !== targetSrc) {
        audio.src = targetSrc;
        try {
          audio.load();
        } catch {
          // Not all browser audio elements require explicit load().
        }
      }
      applyTempoConfig(audio);
      activeAudio = audio;
      callbacks.onAudioChanged(activeAudio);
      notifySource(activeAudio);
      const restore = armNativeTransitionSilence(audio, 'load-track');
      restoreNativeTransitionOnEvents(audio, restore, ['playing', 'timeupdate', 'loadedmetadata']);
      playAudio(audio, 'Track load/play', restore);
      return true;
    },
    seekToFraction(fraction) {
      if (isBridgeDetachedActive()) {
        const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
        sendDiscoverAudioCommand('seek-fraction', { fraction: clamped });
        return;
      }
      const audio = ensureActiveAudio();
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(1, fraction));
      const restoreAfterSeek = !audio.paused && !audio.ended ? armNativeTransitionSilence(audio, 'seek') : null;
      if (restoreAfterSeek) {
        restoreNativeTransitionOnEvents(audio, restoreAfterSeek, ['seeked', 'timeupdate']);
        window.setTimeout(() => {
          audio.currentTime = clamped * audio.duration;
        }, NATIVE_SEEK_DISPATCH_DELAY_MS);
        return;
      }
      audio.currentTime = clamped * audio.duration;
    },
    skipTrack(direction) {
      if (isBridgeDetachedActive()) {
        clearBridgeDetachedControl();
      }
      prepareNativeTransition('skip-track');
      if (clickGlobalPrevNext(direction)) {
        window.setTimeout(() => {
          ensureActiveAudio();
        }, 80);
        return;
      }

      const key = direction > 0 ? 'ArrowRight' : 'ArrowLeft';
      const code = direction > 0 ? 'ArrowRight' : 'ArrowLeft';
      const keyboardInit = { key, code, bubbles: true, cancelable: true };
      document.dispatchEvent(new KeyboardEvent('keydown', keyboardInit));
      window.dispatchEvent(new KeyboardEvent('keydown', keyboardInit));
      document.dispatchEvent(new KeyboardEvent('keyup', keyboardInit));
      window.dispatchEvent(new KeyboardEvent('keyup', keyboardInit));
    },
    destroy() {
      pauseAudio(detachedAudio);
      clearNativeTransitionRestore(activeAudio);
      clearNativeTransitionRestore(detachedAudio);
      observer.disconnect();
    }
  };
}
