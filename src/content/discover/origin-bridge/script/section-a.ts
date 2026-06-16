export function buildOriginBridgeScriptSectionA(marker: string, source: string, commandSource: string): string {
  return `
    (() => {
      if (window[${JSON.stringify(marker)}]) {
        return;
      }
      window[${JSON.stringify(marker)}] = true;

      const post = (type, payload) => {
        window.postMessage({ source: ${JSON.stringify(source)}, type, payload, ts: Date.now() }, '*');
      };
      const MEDIA_SESSION_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack'];
      const registerMediaSessionBridge = () => {
        try {
          if (!navigator.mediaSession || typeof navigator.mediaSession.setActionHandler !== 'function') {
            return;
          }
          MEDIA_SESSION_ACTIONS.forEach((action) => {
            try {
              navigator.mediaSession.setActionHandler(action, () => {
                post('MEDIA_SESSION_ACTION', { action });
              });
            } catch (_) {}
          });
        } catch (_) {}
      };
      const emittedIdentityKeys = new Set();
      const trackedAudios = new Set();
      let activeAudio = null;
      let lastAudioStateKey = '';
      let lastAudioEmitAt = 0;
      let ownedPlaybackHostStatus = 'ready';
      let ownedPlaybackHostDetail = 'native-audio-bridge';
      let ownedPlaybackHostLastCommand = 'init';
      let ownedPlaybackHostLastCommandDetail = '-';
      let ownedPlaybackHostLastCommandAt = 0;
      let ownedPlaybackHostLastAudioEvent = '-';
      let ownedPlaybackHostLastAudioEventDetail = '-';
      let ownedPlaybackHostLastAudioEventAt = 0;
      let lastOwnedPlaybackHostKey = '';
      let lastOwnedPlaybackHostEmitAt = 0;
      let detachedAudio = null;
      let playbackOwner = 'origin';
      let runtimeOwnedSrc = '';
      let suppressedOriginSrc = '';
      let lastDetachedSrc = '';
      let intendedVolume = 1;
      let intendedMuted = false;
      let intendedPreservesPitch = true;

      const setAudioPreservesPitch = (audio, enabled) => {
        if (!audio) {
          return;
        }
        const normalized = Boolean(enabled);
        try { audio.preservesPitch = normalized; } catch (_) {}
        try { audio.mozPreservesPitch = normalized; } catch (_) {}
        try { audio.webkitPreservesPitch = normalized; } catch (_) {}
      };

      const MUTE_PAUSE_HOLD_MS = 24;
      const MUTE_PAUSE_RESTORE_MS = 80;
      // Mirror the controller's origin fade (§4.2): ramp to silence instead of stepping,
      // so the outgoing native element is already at 0 when its hard pause lands.
      const ORIGIN_FADE_OUT_MS = 20;
      const ORIGIN_FADE_STEPS = 4;
      const mutePauseRestoreStates = new WeakMap();

      const destroyDetachedAudio = () => {
        if (!detachedAudio) { return; }
        const audio = detachedAudio;
        detachedAudio = null;
        if (playbackOwner === 'detached') {
          playbackOwner = 'origin';
        }
        lastDetachedSrc = '';
        muteAndPauseTrackedAudio(audio);
        try { audio.src = ''; } catch (_) {}
        trackedAudios.delete(audio);
        if (activeAudio === audio) {
          activeAudio = null;
        }
      };

      const hasAudioSource = (audio) => Boolean(audio && (audio.currentSrc || audio.src));

      const isPlayingAudio = (audio) => Boolean(audio && !audio.paused && !audio.ended && hasAudioSource(audio));

      const isSuppressedOriginSource = (src) => {
        const normalizedSrc = String(src || '').trim();
        return Boolean(normalizedSrc && suppressedOriginSrc && normalizedSrc === suppressedOriginSrc);
      };

      const readBufferedAheadSec = (audio) => {
        if (!audio || !Number.isFinite(audio.currentTime) || !audio.buffered || audio.buffered.length <= 0) {
          return null;
        }
        const currentTime = Number(audio.currentTime || 0);
        for (let index = 0; index < audio.buffered.length; index += 1) {
          const start = audio.buffered.start(index);
          const end = audio.buffered.end(index);
          if (currentTime >= start && currentTime <= end) {
            return Math.max(0, end - currentTime);
          }
        }
        return null;
      };

      const collectKnownAudios = () => {
        const known = new Set();
        Array.from(trackedAudios).forEach((audio) => {
          if (audio) {
            known.add(audio);
          }
        });
        Array.from(document.querySelectorAll('audio')).forEach((audio) => {
          if (!(audio instanceof HTMLAudioElement)) {
            return;
          }
          bindDiscoverAudio(audio);
          known.add(audio);
        });
        return Array.from(known);
      };

      const pickActiveAudio = () => {
        if (
          activeAudio &&
          !activeAudio.ended &&
          hasAudioSource(activeAudio)
        ) {
          return activeAudio;
        }
        const all = collectKnownAudios();
        const playing = all.find((audio) => isPlayingAudio(audio));
        if (playing) {
          return playing;
        }
        return all.find((audio) => audio && !audio.ended && hasAudioSource(audio)) || null;
      };

      const pickOriginAudio = () => {
        const all = collectKnownAudios();
        const playing = all.find((audio) => isPlayingAudio(audio));
        if (playing) {
          return playing;
        }
        return all.find((audio) => audio && !audio.ended && hasAudioSource(audio)) || null;
      };

      const pauseTrackedAudio = (audio) => {
        if (!audio || audio.paused || audio.ended) {
          return;
        }
        try {
          audio.pause();
        } catch (_) {}
      };

      const pauseKnownAudios = (except = null) => {
        collectKnownAudios().forEach((audio) => {
          if (!audio || audio === except) {
            return;
          }
          pauseTrackedAudio(audio);
        });
      };

      const clearMutePauseRestore = (audio) => {
        if (!audio) return null;
        const state = mutePauseRestoreStates.get(audio);
        if (!state) return null;
        if (state.fadeTimer) {
          window.clearTimeout(state.fadeTimer);
        }
        if (state.holdTimer) {
          window.clearTimeout(state.holdTimer);
        }
        if (state.restoreTimer) {
          window.clearTimeout(state.restoreTimer);
        }
        mutePauseRestoreStates.delete(audio);
        return state;
      };

      const restoreMutePauseState = (audio, state) => {
        if (!audio || !state) return;
        try { audio.muted = state.previousMuted; } catch (_) {}
        try { audio.volume = state.previousVolume; } catch (_) {}
        if (mutePauseRestoreStates.get(audio) === state) {
          mutePauseRestoreStates.delete(audio);
        }
      };

      const muteAndPauseTrackedAudio = (audio) => {
        if (!audio || audio.paused || audio.ended) return;

        const pending = clearMutePauseRestore(audio);
        const previousVolume = pending ? pending.previousVolume : audio.volume;
        const previousMuted = pending ? pending.previousMuted : audio.muted;
        const state = {
          previousVolume,
          previousMuted,
          holdTimer: 0,
          restoreTimer: 0
        };
        mutePauseRestoreStates.set(audio, state);

        try { audio.muted = true; } catch (_) {}
        try { audio.volume = 0; } catch (_) {}

        state.holdTimer = window.setTimeout(() => {
          try { audio.pause(); } catch (_) {}
          state.restoreTimer = window.setTimeout(() => {
            restoreMutePauseState(audio, state);
          }, MUTE_PAUSE_RESTORE_MS);
        }, MUTE_PAUSE_HOLD_MS);
      };

      // Like muteAndPauseTrackedAudio, but ramps the volume to 0 over ORIGIN_FADE_OUT_MS
      // instead of stepping it. Used proactively on a runtime takeover so the outgoing
      // native origin element is already silent before its hard pause (ours or Bandcamp's).
      const fadeAndPauseTrackedAudio = (audio) => {
        if (!audio || audio.paused || audio.ended) return;

        const pending = clearMutePauseRestore(audio);
        const previousVolume = pending ? pending.previousVolume : audio.volume;
        const previousMuted = pending ? pending.previousMuted : audio.muted;
        const state = {
          previousVolume,
          previousMuted,
          holdTimer: 0,
          restoreTimer: 0,
          fadeTimer: 0
        };
        mutePauseRestoreStates.set(audio, state);

        const fromVolume = (Number.isFinite(previousVolume) && previousVolume > 0) ? previousVolume : 1;
        const stepMs = ORIGIN_FADE_OUT_MS / ORIGIN_FADE_STEPS;
        let step = 0;
        const advanceFade = () => {
          if (mutePauseRestoreStates.get(audio) !== state) return; // superseded
          step += 1;
          const next = step >= ORIGIN_FADE_STEPS ? 0 : fromVolume * (1 - step / ORIGIN_FADE_STEPS);
          try { audio.volume = next; } catch (_) {}
          if (step < ORIGIN_FADE_STEPS) {
            state.fadeTimer = window.setTimeout(advanceFade, stepMs);
            return;
          }
          // Mute only after the ramp reaches 0; muting mid-fade re-introduces the hard cut.
          try { audio.muted = true; } catch (_) {}
          state.holdTimer = window.setTimeout(() => {
            try { audio.pause(); } catch (_) {}
            state.restoreTimer = window.setTimeout(() => {
              restoreMutePauseState(audio, state);
            }, MUTE_PAUSE_RESTORE_MS);
          }, MUTE_PAUSE_HOLD_MS);
        };
        advanceFade();
      };

      const muteAndPauseKnownAudios = (except = null) => {
        collectKnownAudios().forEach((audio) => {
          if (!audio || audio === except) return;
          muteAndPauseTrackedAudio(audio);
        });
      };

      const emitOwnedPlaybackHostState = () => {
        const currentAudio = (playbackOwner === 'detached' && detachedAudio) ? detachedAudio : (activeAudio || pickActiveAudio());
        const currentSrc = String((currentAudio && (currentAudio.currentSrc || currentAudio.src)) || '');
        const playing = isPlayingAudio(currentAudio);
        const detachedReady = Boolean(
          playbackOwner === 'detached' &&
          detachedAudio &&
          hasAudioSource(detachedAudio) &&
          currentSrc &&
          currentAudio === detachedAudio
        );
        const trackedAudioCount = trackedAudios.size;
        const knownAudios = collectKnownAudios();
        const playingAudios = knownAudios.filter((audio) => isPlayingAudio(audio));
        const activeSrc = String(((currentAudio || activeAudio) && ((currentAudio || activeAudio).currentSrc || (currentAudio || activeAudio).src)) || '');
        const playingSrcs = playingAudios
          .map((audio) => String(audio.currentSrc || audio.src || '').trim())
          .filter(Boolean)
          .slice(0, 6);
        const stateKey = [
          ownedPlaybackHostStatus,
          ownedPlaybackHostDetail,
          ownedPlaybackHostLastCommand,
          ownedPlaybackHostLastCommandDetail,
          ownedPlaybackHostLastCommandAt,
          ownedPlaybackHostLastAudioEvent,
          ownedPlaybackHostLastAudioEventDetail,
          ownedPlaybackHostLastAudioEventAt,
          currentSrc,
          playing ? '1' : '0',
          detachedReady ? '1' : '0',
          trackedAudioCount,
          knownAudios.length,
          playingAudios.length,
          activeSrc,
          playingSrcs.join(',')
        ].join('|');
        const now = Date.now();
        if (stateKey === lastOwnedPlaybackHostKey && now - lastOwnedPlaybackHostEmitAt < 250) {
          return;
        }
        lastOwnedPlaybackHostKey = stateKey;
        lastOwnedPlaybackHostEmitAt = now;
        post('OWNED_PLAYBACK_HOST_STATE', {
          status: ownedPlaybackHostStatus,
          phase: 'skeleton',
          engine: 'page-context-origin-bridge',
          detail: ownedPlaybackHostDetail,
          currentSrc,
          playing,
          detachedReady,
          lastCommand: ownedPlaybackHostLastCommand,
          lastCommandDetail: ownedPlaybackHostLastCommandDetail,
          lastCommandAt: ownedPlaybackHostLastCommandAt,
          lastAudioEvent: ownedPlaybackHostLastAudioEvent,
          lastAudioEventDetail: ownedPlaybackHostLastAudioEventDetail,
          lastAudioEventAt: ownedPlaybackHostLastAudioEventAt,
          trackedAudioCount,
          knownAudioCount: knownAudios.length,
          playingAudioCount: playingAudios.length,
          activeSrc,
          playingSrcs
        });
      };

      const emitDiscoverAudioState = (audioOverride = null) => {
        const target = (playbackOwner === 'detached' && detachedAudio) ? detachedAudio : (audioOverride || activeAudio || pickActiveAudio());
        const src = String((target && (target.currentSrc || target.src)) || '');
        const paused = Boolean(!target || target.paused || target.ended);
        const ended = Boolean(target && target.ended);
        const currentTimeSecRaw = Number((target && target.currentTime) || 0);
        const durationSecRaw = Number((target && target.duration) || 0);
        const volumeRaw = Number((target && target.volume) || 0);
        const currentTimeSec = Number.isFinite(currentTimeSecRaw) ? currentTimeSecRaw : 0;
        const durationSec = Number.isFinite(durationSecRaw) ? durationSecRaw : 0;
        const volume = Number.isFinite(volumeRaw) ? Math.max(0, Math.min(1, volumeRaw)) : 1;
        const muted = Boolean(target && target.muted);
        const stateKey = [
          src,
          paused ? '1' : '0',
          ended ? '1' : '0',
          Math.floor(currentTimeSec),
          Math.floor(durationSec),
          volume.toFixed(3),
          muted ? '1' : '0'
        ].join('|');
        const now = Date.now();
        if (stateKey === lastAudioStateKey && now - lastAudioEmitAt < 250) {
          return;
        }
        lastAudioStateKey = stateKey;
        lastAudioEmitAt = now;
        post('DISCOVER_AUDIO_STATE', {
          src,
          paused,
          ended,
          currentTimeSec,
          durationSec,
          volume,
          muted
        });
      };

      const bindDiscoverAudio = (audio) => {
        if (!audio || trackedAudios.has(audio)) {
          return;
        }
        trackedAudios.add(audio);
        const onAudioEvent = (eventName) => {
          const originStarted = audio !== detachedAudio && (eventName === 'play' || eventName === 'playing');
          let originTrackChangeSrc = '';
          if (playbackOwner === 'runtime' && originStarted) {
            const nativeSrc = String(audio.currentSrc || audio.src || '').trim();
            const staleSuppressedOrigin =
              Boolean(nativeSrc) &&
              isSuppressedOriginSource(nativeSrc);
            if (staleSuppressedOrigin) {
              pauseTrackedAudio(audio);
              ownedPlaybackHostLastAudioEvent = String(eventName || 'state');
              ownedPlaybackHostLastAudioEventAt = Date.now();
              ownedPlaybackHostLastAudioEventDetail =
                'target=origin stale-paused=1 owner=runtime runtimeSrc=' + (runtimeOwnedSrc || '-')
                + ' suppressedSrc=' + (suppressedOriginSrc || '-')
                + ' src=' + (nativeSrc || '-');
              emitOwnedPlaybackHostState();
              emitDiscoverAudioState(activeAudio || pickActiveAudio());
              return;
            }
            playbackOwner = 'origin';
            runtimeOwnedSrc = '';
            suppressedOriginSrc = '';
            activeAudio = audio;
            if (nativeSrc) {
              originTrackChangeSrc = nativeSrc;
            }
          }
          // Detached playback belongs to the page bridge. Native origin playback
          // explicitly switches ownership back to origin.
          if (playbackOwner === 'detached' && originStarted) {
            const nativeSrc = String(audio.currentSrc || audio.src || '').trim();
            if (nativeSrc && nativeSrc !== lastDetachedSrc) {
              playbackOwner = 'origin';
              suppressedOriginSrc = '';
              destroyDetachedAudio();
              originTrackChangeSrc = nativeSrc;
            }
          }
          const hasSrc = Boolean(audio.currentSrc || audio.src);
          if (isPlayingAudio(audio)) {
            activeAudio = audio;
          } else if (activeAudio === audio) {
            // Keep the same active audio on pause so Discover metadata/playlist
            // does not jump to an older tracked audio element.
            const shouldReleaseActive =
              eventName === 'ended' ||
              eventName === 'emptied' ||
              !hasSrc;
            if (shouldReleaseActive) {
              activeAudio = pickActiveAudio();
            }
          } else if (!activeAudio && hasSrc) {
            activeAudio = audio;
          }
          const currentTimeSec = Number.isFinite(audio.currentTime) ? Number(audio.currentTime || 0) : 0;
          const durationSec = Number.isFinite(audio.duration) ? Number(audio.duration || 0) : 0;
          const bufferedAheadSec = readBufferedAheadSec(audio);
          ownedPlaybackHostLastAudioEvent = String(eventName || 'state');
          ownedPlaybackHostLastAudioEventAt = Date.now();
          ownedPlaybackHostLastAudioEventDetail =
            'target=' + (playbackOwner === 'detached' && audio === detachedAudio ? 'detached' : 'origin')
            + ' src=' + (String(audio.currentSrc || audio.src || '').trim() || '-')
            + ' paused=' + (audio.paused ? '1' : '0')
            + ' t=' + currentTimeSec.toFixed(2) + '/' + durationSec.toFixed(2)
            + ' volume=' + (Number.isFinite(audio.volume) ? Math.max(0, Math.min(1, Number(audio.volume))).toFixed(3) : '-')
            + ' muted=' + (audio.muted ? '1' : '0')
            + ' ready=' + String(Number(audio.readyState))
            + ' network=' + String(Number(audio.networkState))
            + ' bufferedAhead=' + (bufferedAheadSec !== null ? bufferedAheadSec.toFixed(2) : '-');
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(audio);
          if (originTrackChangeSrc) {
            post('DISCOVER_ORIGIN_TRACK_CHANGE', { src: originTrackChangeSrc });
          }
          if (eventName === 'ended' && hasSrc) {
            post('DISCOVER_AUDIO_ENDED', {
              src: String(audio.currentSrc || audio.src || '').trim(),
              currentTimeSec: Number.isFinite(audio.currentTime) ? Number(audio.currentTime || 0) : 0,
              durationSec: Number.isFinite(audio.duration) ? Number(audio.duration || 0) : 0
            });
          }
        };
        ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'durationchange', 'seeking', 'seeked', 'timeupdate'].forEach((eventName) => {
          audio.addEventListener(eventName, () => onAudioEvent(eventName), true);
        });
      };

      try {
        const NativeAudio = window.Audio;
        const WrappedAudio = function (...args) {
          const audio = new NativeAudio(...args);
          bindDiscoverAudio(audio);
          return audio;
        };
        WrappedAudio.prototype = NativeAudio.prototype;
        Object.setPrototypeOf(WrappedAudio, NativeAudio);
        window.Audio = WrappedAudio;
      } catch (_) {}

      try {
        const nativePlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
          if (this instanceof HTMLAudioElement) {
            bindDiscoverAudio(this);
            if (playbackOwner === 'runtime' && this !== detachedAudio) {
              const nativeSrc = String(this.currentSrc || this.src || '').trim();
              const staleSuppressedOrigin = Boolean(nativeSrc) && isSuppressedOriginSource(nativeSrc);
              if (staleSuppressedOrigin) {
                pauseTrackedAudio(this);
                emitDiscoverAudioState(activeAudio || pickActiveAudio());
                return Promise.resolve();
              }
            }
            activeAudio = this;
          }
          const result = nativePlay.apply(this, args);
          emitDiscoverAudioState(this instanceof HTMLAudioElement ? this : null);
          return result;
        };
      } catch (_) {}
      const parseBodyAsJson = async (response) => {
        try {
          return await response.json();
        } catch (_) {
          try {
            return await response.text();
          } catch (_) {
            return '';
          }
        }
      };

      const normalizeDigits = (value) => String(value ?? '').replace(/[^\\d]/g, '').trim();

      const readEndpointCrumb = (endpointPath, fallbackCrumb) => {
        const endpointKey = String(endpointPath || '').replace(/^\\//, '');
        const crumbs = window._crumbs && typeof window._crumbs === 'object' ? window._crumbs : null;
        const endpointCrumb =
          crumbs && typeof crumbs === 'object'
            ? firstNonEmpty(
                String(crumbs[endpointKey] || ''),
                String(crumbs['/' + endpointKey] || ''),
                String(crumbs.crumb || ''),
                String(crumbs.bc_page || ''),
                String(crumbs.global || ''),
                String(crumbs.bc_crumb || '')
              )
            : '';
        return firstNonEmpty(endpointCrumb, String(window.gCrumb || '').trim(), fallbackCrumb || '');
      };

      const runLikesMutation = async (payload) => {
        const action = String(payload && payload.action === 'uncollect' ? 'uncollect' : 'collect');
        const endpointPath = action === 'collect' ? '/collect_item_cb' : '/uncollect_item_cb';
        const requestContextFamily = String((payload && payload.requestContextFamily) || '').trim().toLowerCase();
        const fanId = normalizeDigits(payload && payload.fanId);
        const itemId = normalizeDigits(payload && payload.itemId);
        const bandId = normalizeDigits(payload && payload.bandId);
        const itemTypeLong = String(payload && payload.itemType === 'track' ? 'track' : 'album');
        const pageUrlRaw = String((payload && payload.pageUrl) || '').trim();
        const resolveBaseOrigin = () => {
          if (requestContextFamily === 'release-pages' && pageUrlRaw) {
            try {
              return new URL(pageUrlRaw, window.location.href).origin;
            } catch (_) {}
          }
          return 'https://bandcamp.com';
        };
        const baseOrigin = resolveBaseOrigin();
        let customDomainHost = '';
        if (pageUrlRaw) {
          try {
            const parsed = new URL(pageUrlRaw, window.location.href);
            const host = String(parsed.host || '').trim().toLowerCase();
            if (host && host !== 'bandcamp.com' && !host.endsWith('.bandcamp.com')) {
              customDomainHost = host;
            }
          } catch (_) {}
        }
        let crumb = readEndpointCrumb(endpointPath, String((payload && payload.crumb) || '').trim());

        if (!fanId) {
          return { ok: false, error: 'fan-id-missing', reason: 'page-bridge', status: 0 };
        }
        if (!itemId) {
          return { ok: false, error: 'item-id-missing', reason: 'page-bridge', status: 0 };
        }
        if (!crumb) {
          return { ok: false, error: 'crumb-missing', reason: 'page-bridge', status: 0 };
        }

        let attemptCrumb = crumb;
        for (let crumbRetry = 0; crumbRetry < 2; crumbRetry += 1) {
          const params = new URLSearchParams();
          params.set('fan_id', fanId);
          params.set('item_id', itemId);
          params.set('item_type', itemTypeLong);
          params.set('crumb', attemptCrumb);
          if (bandId) {
            params.set('band_id', bandId);
          }
          if (customDomainHost && baseOrigin === 'https://bandcamp.com') {
            params.set('custom_domain_host', customDomainHost);
          }

          const response = await fetch(baseOrigin + endpointPath, {
            method: 'POST',
            credentials: 'include',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'x-requested-with': 'XMLHttpRequest'
            },
            body: params.toString()
          });
          const body = await parseBodyAsJson(response);
          const record = body && typeof body === 'object' ? body : null;
          const errorValue = record ? record.error : null;
          const errorMessage = record ? String(record.error_message || '').trim() : '';
          const responseCrumb = record ? String(record.crumb || '').trim() : '';
          const invalidCrumb = String(errorValue || '').toLowerCase() === 'invalid_crumb' && responseCrumb;

          if (!response.ok) {
            if (invalidCrumb && crumbRetry < 1) {
              attemptCrumb = responseCrumb;
              crumb = responseCrumb;
              continue;
            }
            return {
              ok: false,
              status: response.status || 0,
              error: 'http-error',
              reason: 'request-failed:origin=' + baseOrigin + ':ctx=' + (requestContextFamily || '-')
            };
          }

          if (record && errorValue) {
            if (invalidCrumb && crumbRetry < 1) {
              attemptCrumb = responseCrumb;
              crumb = responseCrumb;
              continue;
            }
            const errorDetail =
              errorMessage ||
              (typeof errorValue === 'string' ? errorValue : '') ||
              (record && typeof record === 'object' ? JSON.stringify(record).slice(0, 600) : '') ||
              String(errorValue || 'unknown');
            return {
              ok: false,
              status: response.status || 0,
              error: 'API error: ' + errorDetail,
              reason: 'request-failed:origin=' + baseOrigin + ':ctx=' + (requestContextFamily || '-')
            };
          }

          return {
            ok: true,
            status: response.status || 200,
            reason: 'ok:origin=' + baseOrigin + ':ctx=' + (requestContextFamily || '-')
          };
        }
        return {
          ok: false,
          status: 0,
          error: 'mutation-failed',
          reason: 'request-failed'
        };
      };

      window.addEventListener('message', (event) => {
        const data = event && event.data;
        if (!data || data.source !== ${JSON.stringify(commandSource)}) {
          return;
        }
        if (data.type === 'LIKES_MUTATION_COMMAND') {
          const requestId = String(data.requestId || '').trim();
          const command = String(data.command || '').trim();
          if (!requestId || command !== 'toggle-wishlist') {
            return;
          }
          Promise.resolve()
            .then(() => runLikesMutation(data.payload || {}))
            .then((result) => {
              post('LIKES_MUTATION_RESULT', Object.assign({ requestId }, result || {}));
            })
            .catch((error) => {
              post('LIKES_MUTATION_RESULT', {
                requestId,
                ok: false,
                status: 0,
                error: error && error.message ? String(error.message) : String(error || 'mutation-error'),
                reason: 'page-bridge:exception'
              });
            });
          return;
        }
        if (data.type === 'OWNED_PLAYBACK_HOST_COMMAND') {
          const command = String(data.command || '').trim();
          ownedPlaybackHostLastCommand = command || 'unknown';
          ownedPlaybackHostLastCommandAt = Date.now();
          ownedPlaybackHostLastCommandDetail = 'host-command';
          if (command === 'ping' || command === 'request-state') {
            emitOwnedPlaybackHostState();
          }
          return;
        }
        if (data.type !== 'DISCOVER_AUDIO_COMMAND') {
          return;
        }
        const command = String(data.command || '').trim();
        ownedPlaybackHostLastCommand = command || 'unknown';
        ownedPlaybackHostLastCommandAt = Date.now();
        if (command === 'request-state') {
          ownedPlaybackHostLastCommandDetail = 'request-state';
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(pickActiveAudio());
          return;
        }
        if (command === 'load-track') {
          const streamUrl = String(data.streamUrl || '').trim();
          const detachedRequested = Boolean(data.detached);
          ownedPlaybackHostLastCommandDetail =
            'mode=' + (detachedRequested ? 'detached' : 'origin')
            + ' src=' + (streamUrl || '-')
            + ' current=' + (String(((activeAudio || detachedAudio) && ((activeAudio || detachedAudio).currentSrc || (activeAudio || detachedAudio).src)) || '').trim() || '-');
          if (streamUrl) {
            if (detachedRequested) {
              // Detached mode: play via extension-owned audio, leave Bandcamp's native player alone.
              playbackOwner = 'detached';
              runtimeOwnedSrc = '';
              suppressedOriginSrc = '';
              lastDetachedSrc = streamUrl;
              muteAndPauseKnownAudios(detachedAudio);
              if (!detachedAudio) {
                try {
                  detachedAudio = new Audio();
                } catch (_) {}
              }
              if (detachedAudio) {
                bindDiscoverAudio(detachedAudio);
                setAudioPreservesPitch(detachedAudio, intendedPreservesPitch);
                activeAudio = detachedAudio;
                clearMutePauseRestore(detachedAudio);
                const current = String(detachedAudio.currentSrc || detachedAudio.src || '').trim();
                if (current !== streamUrl) {
                  try {
                    detachedAudio.src = streamUrl;
                    detachedAudio.load();
                  } catch (_) {}
                }
                try { detachedAudio.volume = intendedVolume; } catch (_) {}
                try { detachedAudio.muted = intendedMuted; } catch (_) {}
                try {
                  const playResult = detachedAudio.play();
                  if (playResult && typeof playResult.catch === 'function') {
                    playResult.catch(() => {});
                  }
                } catch (_) {}
              }
            } else {
              // Origin mode: destroy detached audio and restore native player control.
              playbackOwner = 'origin';
              runtimeOwnedSrc = '';
              suppressedOriginSrc = '';
              destroyDetachedAudio();
              const targetAudio = pickOriginAudio() || pickActiveAudio();
              if (!targetAudio) {
                emitOwnedPlaybackHostState();
                emitDiscoverAudioState(null);
                return;
              }
              activeAudio = targetAudio;
              muteAndPauseKnownAudios(targetAudio);
              clearMutePauseRestore(targetAudio);
              const current = String(targetAudio.currentSrc || targetAudio.src || '').trim();
              if (current !== streamUrl) {
                try {
                  targetAudio.src = streamUrl;
                  targetAudio.load();
                } catch (_) {}
              }
              try { targetAudio.volume = intendedVolume; } catch (_) {}
              try { targetAudio.muted = intendedMuted; } catch (_) {}
              try {
                const playResult = targetAudio.play();
                if (playResult && typeof playResult.catch === 'function') {
                  playResult.catch(() => {});
                }
              } catch (_) {}
              activeAudio = targetAudio;
            }
          }
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(playbackOwner === 'detached' ? detachedAudio : (activeAudio || pickActiveAudio()));
          return;
        }
        if (command === 'set-tempo-adjust') {
          const playbackRate = Number(data.playbackRate);
          intendedPreservesPitch = Boolean(data.preservesPitch);
          ownedPlaybackHostLastCommandDetail =
            'rate=' + (Number.isFinite(playbackRate) ? playbackRate.toFixed(4) : '-')
            + ' preservesPitch=' + (intendedPreservesPitch ? '1' : '0')
            + ' owner=' + playbackOwner;
          if (playbackOwner === 'detached' && detachedAudio && Number.isFinite(playbackRate) && playbackRate > 0) {
            try { detachedAudio.playbackRate = playbackRate; } catch (_) {}
            setAudioPreservesPitch(detachedAudio, intendedPreservesPitch);
          }
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(playbackOwner === 'detached' ? detachedAudio : pickActiveAudio());
          return;
        }
        if (command === 'runtime-owns-playback') {
          const runtimeSrc = String(data.streamUrl || '').trim();
          const originAudio = pickOriginAudio() || pickActiveAudio();
          const originSrc = String((originAudio && (originAudio.currentSrc || originAudio.src)) || '').trim();
          playbackOwner = 'runtime';
          runtimeOwnedSrc = runtimeSrc;
          suppressedOriginSrc = originSrc;
          ownedPlaybackHostLastCommandDetail =
            'owner=runtime src=' + (runtimeSrc || '-')
            + ' suppressedSrc=' + (originSrc || '-');
          pauseKnownAudios();
          activeAudio = pickActiveAudio();
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(activeAudio);
          return;
        }

        if (command === 'prepare-runtime-takeover') {
          // A runtime direct-start is beginning. Ramp any still-audible native origin
          // element to 0 now, before it gets hard-paused, so the stop lands on silence.
          collectKnownAudios().forEach((audio) => {
            if (audio && audio !== detachedAudio && isPlayingAudio(audio)) {
              fadeAndPauseTrackedAudio(audio);
            }
          });
          ownedPlaybackHostLastCommandDetail = 'prepare-runtime-takeover';
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(activeAudio || pickActiveAudio());
          return;
        }

        const target = (playbackOwner === 'detached' && detachedAudio) ? detachedAudio : pickActiveAudio();
        if (!target) {
          ownedPlaybackHostLastCommandDetail = 'target=none';
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(null);
          return;
        }
        if (command === 'toggle-play-pause') {
          ownedPlaybackHostLastCommandDetail =
            'target=' + (playbackOwner === 'detached' && target === detachedAudio ? 'detached' : 'origin')
            + ' paused=' + (target.paused ? '1' : '0')
            + ' src=' + (String(target.currentSrc || target.src || '').trim() || '-');
          if (target.paused || target.ended) {
            clearMutePauseRestore(target);
            try { target.volume = intendedVolume; } catch (_) {}
            try { target.muted = intendedMuted; } catch (_) {}
            try {
              const playResult = target.play();
              if (playResult && typeof playResult.catch === 'function') {
                playResult.catch(() => {});
              }
            } catch (_) {}
          } else {
            muteAndPauseTrackedAudio(target);
          }
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(target);
          return;
        }
        if (command === 'seek-fraction') {
          const fraction = Number(data.fraction);
          const beforeCurrentTime = Number.isFinite(target.currentTime) ? Number(target.currentTime || 0) : 0;
          const durationSec = Number.isFinite(target.duration) ? Number(target.duration || 0) : 0;
          const bufferedAheadSec = readBufferedAheadSec(target);
          const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
          ownedPlaybackHostLastCommandDetail =
            'target=' + (playbackOwner === 'detached' && target === detachedAudio ? 'detached' : 'origin')
            + ' fraction=' + clamped.toFixed(3)
            + ' before=' + beforeCurrentTime.toFixed(2) + '/' + durationSec.toFixed(2)
            + ' after=' + (durationSec > 0 ? (durationSec * clamped).toFixed(2) : '-')
            + ' paused=' + (target.paused ? '1' : '0')
            + ' ready=' + String(Number(target.readyState))
            + ' network=' + String(Number(target.networkState))
            + ' bufferedAhead=' + (bufferedAheadSec !== null ? bufferedAheadSec.toFixed(2) : '-');
          if (Number.isFinite(fraction) && target.duration > 0) {
            const volumeToRestore = intendedVolume;
            try { target.volume = 0; } catch (_) {}
            try {
              target.currentTime = target.duration * clamped;
            } catch (_) {}
            const restore = () => {
              try { target.volume = volumeToRestore; } catch (_) {}
            };
            try {
              target.addEventListener('seeked', restore, { once: true });
            } catch (_) {}
            setTimeout(restore, 200);
          }
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(target);
          return;
        }
        if (command === 'set-volume') {
          const volume = Number(data.volume);
          const transient = Boolean(data.transient);
          ownedPlaybackHostLastCommandDetail =
            'target=' + (playbackOwner === 'detached' && target === detachedAudio ? 'detached' : 'origin')
            + ' volume=' + (Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)).toFixed(3) : '-')
            + ' transient=' + (transient ? '1' : '0');
          if (Number.isFinite(volume)) {
            const clamped = Math.max(0, Math.min(1, volume));
            if (!transient) {
              intendedVolume = clamped;
            }
            clearMutePauseRestore(target);
            try {
              target.volume = clamped;
              if (clamped > 0 && target.muted) {
                target.muted = false;
              }
            } catch (_) {}
          }
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(target);
          return;
        }
        if (command === 'set-muted') {
          const muted = Boolean(data.muted);
          const transient = Boolean(data.transient);
          ownedPlaybackHostLastCommandDetail =
            'target=' + (playbackOwner === 'detached' && target === detachedAudio ? 'detached' : 'origin')
            + ' muted=' + (muted ? '1' : '0')
            + ' transient=' + (transient ? '1' : '0');
          if (!transient) {
            intendedMuted = muted;
          }
          clearMutePauseRestore(target);
          try {
            target.muted = muted;
          } catch (_) {}
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(target);
          return;
        }
        if (command === 'pause') {
          muteAndPauseKnownAudios();
          activeAudio = pickActiveAudio();
          emitOwnedPlaybackHostState();
          emitDiscoverAudioState(activeAudio || target);
          return;
        }
      });

      const toId = (value) => {
        const raw = String(value ?? '').trim();
        if (!raw) {
          return '';
        }
        const match = raw.match(/\\d+/);
        return match ? match[0] : '';
      };

      const toType = (value) => {
        const raw = String(value ?? '').trim().toLowerCase();
        if (raw === 'a' || raw === 'album') {
          return 'a';
        }
        if (raw === 't' || raw === 'track') {
          return 't';
        }
        return '';
      };

      const firstNonEmpty = (...values) => {
        for (const value of values) {
          const text = String(value ?? '').trim();
          if (text) {
            return text;
          }
        }
        return '';
      };

      const readTrackIdFromUrl = (url) => {
        const raw = String(url ?? '').trim();
        if (!raw) {
          return '';
        }
        try {
          const parsed = new URL(raw, window.location.href);
          const streamPathMatch = parsed.pathname.match(/\\/mp3-(?:128|v0|320)\\/(\\d{6,})(?:\\/|$)/i);
          if (streamPathMatch && streamPathMatch[1]) {
            return streamPathMatch[1];
          }
          const trackParam = parsed.searchParams.get('track_id') || parsed.searchParams.get('id');
          if (trackParam && /^\\d{4,}$/.test(trackParam)) {
            return trackParam;
          }
        } catch (_) {}
        const pathMatch = raw.match(/(\\d{6,})/g);
        if (!pathMatch || !pathMatch.length) {
          return '';
        }
        return pathMatch[0] || '';
      };

      const normalizeReleaseUrl = (rawUrl) => {
        try {
          const parsed = new URL(String(rawUrl || ''), window.location.href);
          if (!/\\/(album|track)\\//i.test(parsed.pathname)) {
            return '';
          }
          return (parsed.origin + parsed.pathname).replace(/\\/+$/, '').toLowerCase();
        } catch (_) {
          return '';
        }
      };

      const getCurrentAudioTrackId = () => {
        const audios = Array.from(document.querySelectorAll('audio'));
        const playing = audios.find((audio) => !audio.paused && !audio.ended && (audio.currentSrc || audio.src));
        const src = (playing && (playing.currentSrc || playing.src)) || (audios[0] && (audios[0].currentSrc || audios[0].src)) || '';
        return readTrackIdFromUrl(src);
      };

      const emitApiHint = (bandId, tralbumId, tralbumType, url, trackId) => {
        if (!bandId || !tralbumId) {
          return;
        }
        const key = String(bandId) + ':' + String(tralbumId) + ':' + String(tralbumType || '-') + ':' + String(trackId || '-');
        if (emittedIdentityKeys.has(key)) {
          return;
        }
        emittedIdentityKeys.add(key);
        post('API_HINT', {
          bandId,
          tralbumId,
          tralbumType,
          trackId: String(trackId || ''),
          url: String(url || '')
        });
      };

      const postIdentityHintFromUrl = (rawUrl) => {
        try {
          const parsed = new URL(String(rawUrl || ''), window.location.href);
          const bandId = toId(parsed.searchParams.get('band_id'));
          const tralbumId = toId(parsed.searchParams.get('tralbum_id'));
          const tralbumType = toType(parsed.searchParams.get('tralbum_type') || parsed.searchParams.get('item_type'));
          const trackId = toId(parsed.searchParams.get('track_id'));
          emitApiHint(bandId, tralbumId, tralbumType, parsed.toString(), trackId);
        } catch (_) {}
      };

      const scanPerformanceForHints = () => {
        try {
          const entries = performance.getEntriesByType('resource');
  `;
}
