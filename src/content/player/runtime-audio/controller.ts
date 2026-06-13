import type { AudioBridge } from '@/content/player/audio-bridge';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { readTrackIdFromStreamUrl } from '@/shared/track-id';
import { createHostPlayer, type HostPlayer } from '@/content/player/runtime-audio/host-player';
import {
  createAttachedOriginSnapshot,
  createDetachedOriginSnapshot,
  type DetachedAudioState,
  type RuntimeOriginSnapshot
} from '@/content/player/runtime-audio/origin-snapshot';
import type {
  RuntimeAudioEngine,
  RuntimeAudioOwnershipDebugState,
  RuntimeAudioOwnershipState,
  RuntimeAudioPlaybackState,
  RuntimeAudioPreparedSnapshot,
  RuntimeHostPerfReport,
  RuntimeStretchCapability
} from '@/content/player/runtime-audio/types';
import {
  TEMPO_ADJUST_MAX_PLAYBACK_RATE,
  TEMPO_ADJUST_MIN_PLAYBACK_RATE
} from '@/shared/tempo-adjust';
import { createLogger } from '@/utils/debug';

const logger = createLogger('AUDIO');
// Controller-side transition timings. These live in the content-script context;
// the host iframe owns its own DSP timings (fade/preroll/handoff-gate/drain) in
// runtime-audio-host.ts. Values are independent on purpose — do not couple them.
const ORIGIN_PRE_RUNTIME_MUTE_MS = 80; // hold after muting origin before runtime host work
// Origin-side fade for the origin→runtime handover. The two-host ping-pong retire never hard-stops
// an audible source: it ramps the outgoing host to zero (PAUSE_FADE_SECONDS in runtime-audio-host.ts)
// so the stop does not click. The origin handover used to step the element volume straight to 0,
// which is the same broadband click on the outgoing side. Mirror the host fade with a short stepped
// ramp — HTMLMediaElement.volume is a plain setter, not an AudioParam, so there is no
// linearRampToValueAtTime to use here.
const ORIGIN_FADE_OUT_MS = 20;
const ORIGIN_FADE_STEPS = 4;
const RUNTIME_SEEK_FRACTION_EPSILON = 0.001; // dedupe near-identical runtime seek fractions
const RUNTIME_SEEK_REPEAT_SUPPRESS_MS = 250; // suppress repeat seek dispatch within this window

interface CreateRuntimeAudioControllerInput {
  bridge: AudioBridge;
  engine: RuntimeAudioEngine;
  onPlaybackState(state: RuntimeAudioPlaybackState): void;
  onPlaybackEnded(): void;
  onOwnershipChange?(owned: boolean, state: RuntimeAudioOwnershipDebugState): void;
  onRuntimeCapability?(capability: RuntimeStretchCapability): void;
  onTakeoverDebug?(reason: string, stage: string, info?: {
    detail?: string;
    originSnapshotTimeSec?: number;
    seekTargetTimeSec?: number;
  }): void;
  onPendingRuntimeSelectionChange?(pending: boolean): void;
  onRuntimeSourceChanged?(src: string): void;
  claimRuntimePlayback?(src: string): void;
  onSeekDispatch?(info: {
    fraction: number;
    runtimeOwned: boolean;
    preparedLoaded: boolean;
    runtimeDispatched: boolean;
    nativeDispatched: boolean;
    handoverPending?: boolean;
  }): void;
  getDetachedAudioState?(): DetachedAudioState | null;
  requestCurrentRuntimePrepare?(reason: string): void;
}

export interface RuntimeAudioController extends AudioBridge {
  setCurrentSource(src: string, sourceVersion: number): void;
  onOriginAudioState(audio: HTMLAudioElement | null, eventType?: string): void;
  onPreparedTrackReady(): void;
  releaseToOrigin(): void;
  setHostPerfSampling(enabled: boolean): void;
  collectHostPerfSnapshots(): Promise<RuntimeHostPerfReport[]>;
}

function clampPlaybackRate(playbackRate: number): number {
  if (!Number.isFinite(playbackRate)) {
    return 1;
  }
  return Math.min(TEMPO_ADJUST_MAX_PLAYBACK_RATE, Math.max(TEMPO_ADJUST_MIN_PLAYBACK_RATE, playbackRate));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

// Ramp an origin volume setter down to 0 over ORIGIN_FADE_OUT_MS instead of stepping straight to 0,
// so the outgoing origin does not click when it hands over to runtime (see ORIGIN_FADE_OUT_MS).
async function fadeOriginVolumeToZero(
  setVolume: (volume: number) => void,
  fromVolume: number
): Promise<void> {
  if (!(fromVolume > 0)) {
    setVolume(0);
    return;
  }
  const stepMs = ORIGIN_FADE_OUT_MS / ORIGIN_FADE_STEPS;
  for (let step = 1; step <= ORIGIN_FADE_STEPS; step += 1) {
    setVolume(step === ORIGIN_FADE_STEPS ? 0 : fromVolume * (1 - step / ORIGIN_FADE_STEPS));
    await waitMs(stepMs);
  }
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function sharesTrackIdentity(a: string, b: string): boolean {
  return Boolean(a && b && sourcesShareTrackIdentity(a, b));
}

// Short, non-sensitive identity for a host's loaded track: the public trackId from the
// stream URL (never the signed `t=` token). Used only for the host-pair debug snapshot.
function hostLoadedTrackId(host: HostPlayer): string {
  return readTrackIdFromStreamUrl(host.getLoadedSource()) || 'empty';
}

function readPreparedTrack(
  engine: RuntimeAudioEngine,
  source: string
): { track: RuntimeAudioPreparedSnapshot; buffer: AudioBuffer | null } | null {
  const match = source ? engine.findPrepared(source) : null;
  return match ? { track: match.snapshot, buffer: match.buffer } : null;
}

function seekTimeFromFraction(snapshot: RuntimeOriginSnapshot, prepared: RuntimeAudioPreparedSnapshot, fraction: number): number {
  const durationSec = snapshot.durationSec > 0 ? snapshot.durationSec : prepared.durationSec;
  const safeFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return durationSec > 0 ? durationSec * safeFraction : snapshot.currentTimeSec;
}

export function createRuntimeAudioController(input: CreateRuntimeAudioControllerInput): RuntimeAudioController {
  const { bridge, engine, onPlaybackState, onPlaybackEnded } = input;

  let destroyed = false;
  let ownershipState: RuntimeAudioOwnershipState = 'origin-started';
  let firstOriginAvailable = true;
  let currentSource = '';
  let currentSourceVersion = -1;
  let originAudio: HTMLAudioElement | null = null;
  let desiredPlaybackRate = 1;
  let desiredKeyLockEnabled = true;
  let lastUserVolume = 1;
  let lastUserMuted = false;
  // Depth of in-progress protective origin silences. While > 0 the origin element is forced
  // to volume 0 / muted as a handover guard, so its observed state MUST NOT be captured as the
  // user's intended volume — otherwise a later runtime direct-start (which uses lastUserVolume/
  // lastUserMuted) would play silent/muted. See onOriginAudioState and silenceOrigin.
  let originProtectionDepth = 0;
  let transitionToken = 0;
  let controlChain = Promise.resolve();
  let capability: RuntimeStretchCapability | null = null;
  let capabilityProbePromise: Promise<RuntimeStretchCapability> | null = null;
  let lastCapabilityLog = '';
  let lastDebugReason = '-';
  let pendingSeekFraction: number | null = null;
  let pendingRuntimeSeekFraction: number | null = null;
  let runtimeSeekTaskPending = false;
  let seekHandoverTaskPending = false;
  let lastRuntimeSeekDispatchFraction: number | null = null;
  let lastRuntimeSeekDispatchAtMs = 0;
  let pendingTempoHandover = false;
  let tempoHandoverTaskPending = false;
  let runtimePlaylistStartPending = false;
  let runtimePlaylistStartSource = '';
  let pendingRuntimePlaylistSource = '';
  let pendingRuntimePlaylistToken = 0;
  // Resource-diagnostics: while a debug panel is open this is true, and any host (including one
  // created after the panel opened) inherits the sampling state.
  let hostPerfSamplingEnabled = false;

  function createRuntimeHostPlayer(): HostPlayer {
    const host: HostPlayer = createHostPlayer({
      onState(state) {
        // Only the audible (active) host drives UI state. The idle/retiring host can emit a
        // trailing paused STATE while it is cleared — ignore it so it cannot blip the UI.
        if (host === active) {
          onPlaybackState(state);
        }
      },
      onEnded() {
        // Track end is only meaningful from the audible host. The idle host never plays to
        // completion (it is stopped while inactive).
        if (host !== active) {
          return;
        }
        setOwner('origin-started');
        onPlaybackEnded();
      },
      onDebug(stage, info) {
        debug(lastDebugReason !== '-' ? lastDebugReason : 'host', stage, info);
      }
    });
    if (hostPerfSamplingEnabled) {
      host.setPerfSampling(true);
    }
    return host;
  }

  // Two long-lived runtime hosts (ping-pong / double-buffer). `active` owns audible runtime
  // output for currentSource; `idle` is kept warm so the next track's clear+addBuffers cost
  // happens on the silent host, not the audible one. On a runtime→runtime switch we load the
  // next track into `idle`, gate it in behind the existing handoff gate, then swap the refs and
  // retire the old `active` (fade + 3.4.32 output drain + clear) off the audible path.
  let active = createRuntimeHostPlayer();
  let idle = createRuntimeHostPlayer();

  function wakeHosts(): void {
    active.wake();
    idle.wake();
  }

  function pauseHosts(): Promise<void> {
    return Promise.all([active.pause(), idle.pause()]).then(() => undefined);
  }

  const runtimeOwnsCurrent = (): boolean =>
    ownershipState === 'runtime' && active.hasLoadedTrackForSource(currentSource);

  const originOwnsCurrent = (): boolean => ownershipState === 'origin-started';

  const originPlaybackActive = (): boolean => {
    const audio = originAudio || bridge.getActiveAudio();
    if (audio && !audio.paused && !audio.ended) {
      return true;
    }
    const detached = input.getDetachedAudioState?.();
    return Boolean(detached?.playing);
  };

  const pauseCompetingOriginAudio = (audio: HTMLAudioElement, eventType: string): boolean => {
    const originSource = String(audio.currentSrc || audio.src || '').trim();
    if (!runtimeOwnsCurrent() || !originSource || audio.paused || audio.ended) {
      return false;
    }
    if (currentSource && !sharesTrackIdentity(originSource, currentSource)) {
      return false;
    }
    try {
      audio.pause();
      debug('runtime-owned-origin-play', 'origin-paused-while-runtime-owned', {
        detail: `event=${eventType} src=${originSource.slice(-80)}`
      });
      return true;
    } catch (error) {
      debug('runtime-owned-origin-play', 'origin-pause-failed-while-runtime-owned', {
        detail: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  };

  function debug(
    reason: string,
    stage: string,
    info?: {
      detail?: string;
      originSnapshotTimeSec?: number;
      seekTargetTimeSec?: number;
    }
  ): void {
    input.onTakeoverDebug?.(reason, stage, info);
  }

  function setOwner(nextOwner: RuntimeAudioOwnershipState): void {
    const resolvedNextOwner = nextOwner;
    const nextFirstOriginAvailable =
      resolvedNextOwner === 'origin-started'
        ? true
        : false;
    if (ownershipState === resolvedNextOwner && firstOriginAvailable === nextFirstOriginAvailable) {
      return;
    }
    ownershipState = resolvedNextOwner;
    firstOriginAvailable = nextFirstOriginAvailable;
    if (resolvedNextOwner === 'runtime' && currentSource) {
      input.claimRuntimePlayback?.(currentSource);
    }
    input.onOwnershipChange?.(resolvedNextOwner === 'runtime', {
      ownershipState,
      firstOriginAvailable
    });
  }

  function resetTempoIntent(): void {
    desiredPlaybackRate = 1;
    desiredKeyLockEnabled = true;
    pendingTempoHandover = false;
  }

  function clearPendingRuntimePlaylistSelection(): void {
    if (pendingRuntimePlaylistSource) {
      input.onPendingRuntimeSelectionChange?.(false);
    }
    pendingRuntimePlaylistSource = '';
    pendingRuntimePlaylistToken = 0;
  }

  function invalidateTransition(): number {
    transitionToken += 1;
    pendingSeekFraction = null;
    pendingRuntimeSeekFraction = null;
    runtimeSeekTaskPending = false;
    seekHandoverTaskPending = false;
    lastRuntimeSeekDispatchFraction = null;
    lastRuntimeSeekDispatchAtMs = 0;
    tempoHandoverTaskPending = false;
    runtimePlaylistStartPending = false;
    runtimePlaylistStartSource = '';
    clearPendingRuntimePlaylistSelection();
    return transitionToken;
  }

  function enqueueControlTask(task: () => Promise<void>): void {
    controlChain = controlChain
      .then(task)
      .catch((error) => {
        logger.warn('Runtime control task failed', error);
      });
  }

  function logCapability(nextCapability: RuntimeStretchCapability): void {
    const nextKey = `${nextCapability.supported ? '1' : '0'}|${nextCapability.reason}|${nextCapability.detail}`;
    if (nextKey === lastCapabilityLog) {
      return;
    }
    lastCapabilityLog = nextKey;
    if (nextCapability.supported) {
      logger.info('Runtime stretch probe passed', nextCapability.detail);
    } else if (nextCapability.reason !== 'pending') {
      logger.warn(`Runtime stretch probe blocked ${nextCapability.reason}`, nextCapability.detail);
    }
    input.onRuntimeCapability?.(nextCapability);
  }

  async function ensureRuntimeCapability(): Promise<RuntimeStretchCapability> {
    if (capability) {
      return capability;
    }
    if (!capabilityProbePromise) {
      logCapability({
        supported: false,
        reason: 'pending',
        detail: 'probe-start',
        checkedAt: Date.now()
      });
      capabilityProbePromise = active.probe()
        .then((result) => {
          capability = result;
          logCapability(result);
          return result;
        })
        .catch((error) => {
          const result = {
            supported: false,
            reason: 'probe-error',
            detail: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now()
          };
          capability = result;
          logCapability(result);
          return result;
        })
        .finally(() => {
          capabilityProbePromise = null;
        });
    }
    return capabilityProbePromise;
  }

  void ensureRuntimeCapability();
  // Warm the idle host's iframe/context so the first ping-pong switch loads into a ready host.
  void idle.probe();

  function readOriginSnapshot(): {
    snapshot: RuntimeOriginSnapshot;
    pauseOrigin(): Promise<void>;
    silenceOrigin(): Promise<() => void>;
  } | null {
    const createDetachedOrigin = (snapshot: RuntimeOriginSnapshot) => ({
      snapshot,
      pauseOrigin: async () => {
        if (currentSource && input.claimRuntimePlayback) {
          input.claimRuntimePlayback(currentSource);
        } else {
          bridge.pause();
        }
        await waitMs(ORIGIN_PRE_RUNTIME_MUTE_MS);
      },
      silenceOrigin: async () => {
        originProtectionDepth += 1;
        await fadeOriginVolumeToZero((volume) => {
          bridge.setVolume(volume, { transient: true });
        }, lastUserVolume);
        // Mute only after the ramp reaches 0; muting mid-fade would re-introduce the hard cut.
        bridge.setMuted(true, { transient: true });
        await waitMs(ORIGIN_PRE_RUNTIME_MUTE_MS);
        let released = false;
        return () => {
          bridge.setVolume(lastUserVolume, { transient: true });
          bridge.setMuted(lastUserMuted, { transient: true });
          if (!released) {
            released = true;
            originProtectionDepth = Math.max(0, originProtectionDepth - 1);
          }
        };
      }
    });

    const candidates: Array<{
      snapshot: RuntimeOriginSnapshot;
      pauseOrigin(): Promise<void>;
      silenceOrigin(): Promise<() => void>;
    }> = [];

    const audio = originAudio || bridge.getActiveAudio();
    if (audio) {
      candidates.push({
        snapshot: createAttachedOriginSnapshot(audio),
        pauseOrigin: async () => {
          audio.pause();
        },
        silenceOrigin: async () => {
          const previousVolume = audio.volume;
          const previousMuted = audio.muted;
          originProtectionDepth += 1;
          await fadeOriginVolumeToZero((volume) => {
            audio.volume = volume;
          }, previousVolume);
          // Mute only after the ramp reaches 0; muting mid-fade would re-introduce the hard cut.
          audio.muted = true;
          await waitMs(ORIGIN_PRE_RUNTIME_MUTE_MS);
          let released = false;
          return () => {
            audio.volume = previousVolume;
            audio.muted = previousMuted;
            if (!released) {
              released = true;
              originProtectionDepth = Math.max(0, originProtectionDepth - 1);
            }
          };
        }
      });
    }

    const detached = input.getDetachedAudioState?.();
    const detachedSnapshot = detached
      ? { ...createDetachedOriginSnapshot(detached), volume: lastUserVolume, muted: lastUserMuted }
      : null;
    if (detachedSnapshot?.src) {
      candidates.push(createDetachedOrigin(detachedSnapshot));
    }

    if (!candidates.length) {
      return null;
    }
    if (!currentSource) {
      return candidates.find((candidate) => candidate.snapshot.playing) ?? candidates[0] ?? null;
    }

    const currentCandidates = candidates.filter((candidate) =>
      Boolean(candidate.snapshot.src && sharesTrackIdentity(candidate.snapshot.src, currentSource))
    );
    return currentCandidates.find((candidate) => candidate.snapshot.playing) ?? currentCandidates[0] ?? null;
  }

  async function loadPreparedTrackInto(
    host: HostPlayer,
    prepared: { track: RuntimeAudioPreparedSnapshot; buffer: AudioBuffer | null },
    reason: string,
    token: number
  ): Promise<boolean> {
    if (host.hasLoadedTrackForSource(prepared.track.url)) {
      return true;
    }
    if (!prepared.buffer) {
      debug(reason, 'no-prepared-track:no-buffer');
      return false;
    }
    const loadedSource = host.getLoadedSource();
    if (loadedSource && !sharesTrackIdentity(loadedSource, prepared.track.url)) {
      // The target host still holds a previous track. Fade out, drain the queued output
      // (the 3.4.32 fix that keeps outgoing audio from being disposed too early), and clear
      // it before loading. In a runtime→runtime switch the target is the SILENT idle host,
      // so this clear+addBuffers happens off the audible path while `active` keeps playing.
      debug(reason, 'clear-target-before-load', {
        detail: `src=${prepared.track.url.slice(-60)}`
      });
      await host.stop({ drainOutputBeforeClear: true });
      if (destroyed || token !== transitionToken) {
        debug(reason, 'stale-after-stop');
        return false;
      }
    }
    debug(reason, 'loading-track', {
      detail: `src=${prepared.track.url.slice(-60)} freshGraph=0`
    });
    await host.loadTrack(prepared.track.url, prepared.buffer);
    if (destroyed || token !== transitionToken) {
      debug(reason, 'stale-after-load');
      return false;
    }
    return true;
  }

  async function startRuntimeFromPrepared(
    source: string,
    reason: string,
    options: {
      positionSec: number;
      volume: number;
      muted: boolean;
      playbackRate: number;
      keyLockEnabled: boolean;
      handoffGate: boolean;
      token: number;
      play: boolean;
    }
  ): Promise<boolean> {
    lastDebugReason = reason;
    const prepared = readPreparedTrack(engine, source);
    if (!prepared) {
      debug(reason, 'no-prepared-track', {
        detail: `currentSrc=${source.slice(-60)} ver=${currentSourceVersion}`
      });
      return false;
    }

    // Ping-pong target selection: if the audible `active` host already holds a *different*
    // track, load the next one into the warm `idle` host so the clear+addBuffers cost stays
    // off the audible path. Otherwise (first runtime start / same track / origin handover)
    // use `active` directly.
    const activeLoaded = active.getLoadedSource();
    const isRuntimeReplacement =
      Boolean(activeLoaded) && !sharesTrackIdentity(activeLoaded, prepared.track.url);
    const target = isRuntimeReplacement ? idle : active;
    if (isRuntimeReplacement) {
      debug(reason, 'ping-pong-load-into-idle', {
        detail: `next=${prepared.track.url.slice(-60)} retiring=${activeLoaded.slice(-40)}`
      });
    }

    const loaded = await loadPreparedTrackInto(target, prepared, reason, options.token);
    if (!loaded) {
      return false;
    }
    target.setVolume(options.volume);
    target.setMuted(options.muted);
    if (options.play) {
      await target.playFromTime(
        options.positionSec,
        options.playbackRate,
        options.keyLockEnabled,
        options.volume,
        options.muted,
        { handoffGate: options.handoffGate }
      );
    } else {
      await target.setTempo(options.playbackRate, options.keyLockEnabled);
      await target.seekToTime(options.positionSec);
      await target.pause();
    }
    if (destroyed || options.token !== transitionToken) {
      debug(reason, 'stale-after-play');
      if (target !== active) {
        // Superseded after we already played into the idle host. Silence it (fade + drain,
        // no crack) so it cannot double with the still-audible active host; the newer
        // transition reuses the now-cleared idle host.
        await target.stop({ drainOutputBeforeClear: true });
      }
      return false;
    }
    const retiring = target !== active ? active : null;
    if (retiring) {
      // `target` (idle) now owns audible output behind its handoff gate. Promote it to active.
      active = target;
      idle = retiring;
      debug(reason, 'host-swapped', {
        detail: `active<-idle retiring=${hostLoadedTrackId(retiring)}`
      });
    }
    setOwner('runtime');
    // Mark ownership transferred BEFORE retiring the old host. `target` is already audibly
    // scheduled, so the retire is post-ownership cleanup of the *outgoing* host. Advancing the
    // incident to 'playing' first keeps the retire's stop from being mis-flagged as
    // `stop-dropped-target-buffer` against the (fine) new track.
    debug(reason, 'ownership-transferred');
    if (retiring) {
      // Retire the old active off the audible path: fade + 3.4.32 drain + clear. Awaited (it
      // does not gate `target`'s already-scheduled audio) so the retiring host's cleanup
      // serializes before any later switch can reuse it.
      await retiring.stop({ drainOutputBeforeClear: true });
    }
    // Ping-pong liveness snapshot: with two live hosts the `active` id flips on every
    // runtime→runtime switch (A↔B). A never-changing id would mean ping-pong is not engaged.
    // Identify each host's loaded track by trackId only (non-sensitive; no signed URL token).
    debug(reason, 'host-pair', {
      detail: `active=${active.id()}:${hostLoadedTrackId(active)} idle=${idle.id()}:${hostLoadedTrackId(idle)}`
    });
    return true;
  }

  async function handoverToRuntime(
    reason: string,
    options: { seekFraction?: number; allowPaused?: boolean; muteOriginBeforeHandover?: boolean } = {}
  ): Promise<boolean> {
    const token = transitionToken;
    const runtimeCapability = await ensureRuntimeCapability();
    if (destroyed || token !== transitionToken) {
      debug(reason, 'stale-after-capability');
      return false;
    }
    if (!runtimeCapability.supported) {
      debug(reason, `capability-blocked:${runtimeCapability.reason}`);
      return false;
    }
    if (runtimeOwnsCurrent()) {
      await active.setTempo(desiredPlaybackRate, desiredKeyLockEnabled);
      return true;
    }

    const origin = readOriginSnapshot();
    if (!origin?.snapshot.src) {
      debug(reason, 'no-origin');
      return false;
    }
    if (currentSource && !sharesTrackIdentity(origin.snapshot.src, currentSource)) {
      debug(reason, 'identity-mismatch');
      return false;
    }
    if (!origin.snapshot.playing && !options.allowPaused) {
      debug(reason, 'origin-paused');
      return false;
    }

    const prepared = readPreparedTrack(engine, currentSource);
    if (!prepared) {
      debug(reason, 'no-prepared-track');
      return false;
    }
    const targetTimeSec =
      typeof options.seekFraction === 'number'
        ? seekTimeFromFraction(origin.snapshot, prepared.track, options.seekFraction)
        : origin.snapshot.currentTimeSec;
    const needsLoad = !active.hasLoadedTrackForSource(prepared.track.url);
    const shouldMuteOrigin = needsLoad || (origin.snapshot.playing && Boolean(options.muteOriginBeforeHandover));
    let restoreOrigin: (() => void) | null = null;
    if (shouldMuteOrigin) {
      debug(reason, 'origin-muted-before-runtime-work', {
        detail: `holdMs=${ORIGIN_PRE_RUNTIME_MUTE_MS} fadeMs=${ORIGIN_FADE_OUT_MS}${needsLoad ? '' : ' reason=handover'}`,
        originSnapshotTimeSec: origin.snapshot.currentTimeSec,
        seekTargetTimeSec: targetTimeSec
      });
      restoreOrigin = await origin.silenceOrigin();
    }

    const started = await startRuntimeFromPrepared(currentSource, reason, {
      positionSec: targetTimeSec,
      volume: origin.snapshot.volume,
      muted: origin.snapshot.muted,
      playbackRate: desiredPlaybackRate,
      keyLockEnabled: desiredKeyLockEnabled,
      handoffGate: shouldMuteOrigin,
      token,
      play: origin.snapshot.playing
    });
    if (!started) {
      restoreOrigin?.();
      return false;
    }

    debug(reason, 'runtime-ready-before-origin-pause', {
      detail: `origin=${origin.snapshot.currentTimeSec.toFixed(2)} kind=${origin.snapshot.kind}`,
      originSnapshotTimeSec: origin.snapshot.currentTimeSec,
      seekTargetTimeSec: targetTimeSec
    });
    try {
      await origin.pauseOrigin();
    } finally {
      restoreOrigin?.();
    }
    debug(reason, 'origin-paused-for-handover', {
      detail: `origin=${origin.snapshot.currentTimeSec.toFixed(2)} kind=${origin.snapshot.kind}`,
      originSnapshotTimeSec: origin.snapshot.currentTimeSec,
      seekTargetTimeSec: targetTimeSec
    });
    return true;
  }

  async function loadCurrentPreparedTrack(reason: string): Promise<boolean> {
    const source = currentSource;
    if (!source || runtimeOwnsCurrent() || !originOwnsCurrent()) {
      return false;
    }
    if (runtimePlaylistStartSource && sharesTrackIdentity(source, runtimePlaylistStartSource)) {
      debug(reason, 'skip-active-direct-start', {
        detail: `src=${source.slice(-60)}`
      });
      return false;
    }
    const runtimeCapability = await ensureRuntimeCapability();
    if (!runtimeCapability.supported) {
      debug(reason, `capability-blocked:${runtimeCapability.reason}`);
      return false;
    }
    if (!sharesTrackIdentity(source, currentSource) || !originOwnsCurrent()) {
      debug(reason, 'stale-before-load');
      return false;
    }
    const prepared = readPreparedTrack(engine, source);
    if (!prepared) {
      debug(reason, 'no-prepared-track');
      return false;
    }
    if (active.hasLoadedTrackForSource(prepared.track.url)) {
      debug(reason, 'host-ready', {
        detail: `src=${source.slice(-60)}`
      });
      return true;
    }
    const token = transitionToken;
    // Origin still owns audible output here, so the current track is preloaded into `active`
    // (the host that will play it on handover); the idle host stays reserved for the next switch.
    const loaded = await loadPreparedTrackInto(active, prepared, reason, token);
    if (!loaded || destroyed || token !== transitionToken || !sharesTrackIdentity(source, currentSource)) {
      debug(reason, 'stale-after-load');
      return false;
    }
    await active.setTempo(desiredPlaybackRate, desiredKeyLockEnabled);
    debug(reason, 'host-ready', {
      detail: `src=${source.slice(-60)}`
    });
    return true;
  }

  function hasCurrentPreparedTrack(): boolean {
    return Boolean(readPreparedTrack(engine, currentSource));
  }

  function needsRuntimePlayback(): boolean {
    return desiredPlaybackRate !== 1;
  }

  async function runSeekHandover(fraction: number): Promise<void> {
    if (runtimeOwnsCurrent()) {
      pendingSeekFraction = null;
      await active.setTempo(desiredPlaybackRate, desiredKeyLockEnabled);
      await active.seekToFraction(fraction);
      return;
    }
    if (!hasCurrentPreparedTrack()) {
      debug('seek', 'waiting-for-prepared-track');
      input.requestCurrentRuntimePrepare?.('seek-intent');
      return;
    }

    const transferred = await handoverToRuntime('seek', {
      seekFraction: fraction,
      allowPaused: true,
      muteOriginBeforeHandover: true
    });
    if (transferred) {
      pendingSeekFraction = null;
    }
  }

  function enqueueRuntimeOwnedSeek(fraction: number): void {
    const safeFraction = Math.max(0, Math.min(1, Number(fraction) || 0));
    const nowMs = performance.now();
    if (
      lastRuntimeSeekDispatchFraction !== null &&
      nowMs - lastRuntimeSeekDispatchAtMs < RUNTIME_SEEK_REPEAT_SUPPRESS_MS &&
      Math.abs(lastRuntimeSeekDispatchFraction - safeFraction) < RUNTIME_SEEK_FRACTION_EPSILON
    ) {
      debug('seek', 'runtime-seek-repeat-suppressed', {
        detail: `fraction=${safeFraction.toFixed(3)}`
      });
      return;
    }
    if (
      pendingRuntimeSeekFraction !== null &&
      Math.abs(pendingRuntimeSeekFraction - safeFraction) < RUNTIME_SEEK_FRACTION_EPSILON
    ) {
      debug('seek', 'runtime-seek-deduped', {
        detail: `fraction=${safeFraction.toFixed(3)}`
      });
      return;
    }

    pendingRuntimeSeekFraction = safeFraction;
    if (runtimeSeekTaskPending) {
      debug('seek', 'runtime-seek-coalesced', {
        detail: `fraction=${safeFraction.toFixed(3)}`
      });
      return;
    }

    runtimeSeekTaskPending = true;
    const token = transitionToken;
    enqueueControlTask(async () => {
      try {
        await waitForAnimationFrame();
        if (destroyed || token !== transitionToken || !runtimeOwnsCurrent()) {
          return;
        }
        const latestFraction = pendingRuntimeSeekFraction;
        pendingRuntimeSeekFraction = null;
        if (latestFraction === null) {
          return;
        }
        await active.seekToFraction(latestFraction);
        lastRuntimeSeekDispatchFraction = latestFraction;
        lastRuntimeSeekDispatchAtMs = performance.now();
      } finally {
        runtimeSeekTaskPending = false;
        if (
          pendingRuntimeSeekFraction !== null &&
          !destroyed &&
          token === transitionToken &&
          runtimeOwnsCurrent()
        ) {
          enqueueRuntimeOwnedSeek(pendingRuntimeSeekFraction);
        }
      }
    });
  }

  function enqueueSeekHandover(token: number): void {
    if (seekHandoverTaskPending) {
      debug('seek', 'handover-coalesced', {
        detail: `fraction=${(pendingSeekFraction ?? 0).toFixed(3)}`
      });
      return;
    }
    seekHandoverTaskPending = true;
    enqueueControlTask(async () => {
      const attemptedFraction = pendingSeekFraction;
      try {
        if (destroyed || token !== transitionToken || attemptedFraction === null) {
          return;
        }
        await runSeekHandover(attemptedFraction);
      } finally {
        seekHandoverTaskPending = false;
        // Re-run ONLY for a newer seek that arrived during this handover (trailing
        // coalesce). A successful handover clears pendingSeekFraction; a *failed* one
        // (e.g. no-origin / identity-mismatch once the track is prepared) leaves it
        // unchanged, so re-enqueuing the identical attempt would busy-loop with no delay —
        // a CPU spin that allocates a promise per iteration and runs memory away. The
        // failure reason is already in the trace, and origin/source/prepared changes
        // re-drive handover through their own events.
        if (
          pendingSeekFraction !== null &&
          pendingSeekFraction !== attemptedFraction &&
          !destroyed &&
          token === transitionToken &&
          hasCurrentPreparedTrack() &&
          !runtimeOwnsCurrent()
        ) {
          enqueueSeekHandover(token);
        }
      }
    });
  }

  function enqueueTempoHandover(token: number): void {
    if (tempoHandoverTaskPending) {
      debug('tempo-adjust', 'handover-coalesced', {
        detail: `rate=${desiredPlaybackRate.toFixed(4)} keyLock=${desiredKeyLockEnabled ? '1' : '0'}`
      });
      return;
    }
    tempoHandoverTaskPending = true;
    enqueueControlTask(async () => {
      const attemptedRate = desiredPlaybackRate;
      const attemptedKeyLock = desiredKeyLockEnabled;
      try {
        if (destroyed || token !== transitionToken || !pendingTempoHandover) {
          return;
        }
        const transferred = await handoverToRuntime('tempo-adjust', {
          muteOriginBeforeHandover: true
        });
        if (transferred) {
          pendingTempoHandover = false;
          await active.setTempo(desiredPlaybackRate, desiredKeyLockEnabled);
          debug('tempo-adjust', 'runtime-active-controls-synced', {
            detail: `rate=${desiredPlaybackRate.toFixed(4)} keyLock=${desiredKeyLockEnabled ? '1' : '0'}`
          });
        }
      } finally {
        tempoHandoverTaskPending = false;
        // Re-run only if a newer tempo/keyLock input arrived during this handover. A failed
        // handover leaves pendingTempoHandover set with the same desired values; re-enqueuing
        // the identical attempt would busy-loop (CPU spin + runaway allocation). See the
        // matching note in enqueueSeekHandover.
        if (
          pendingTempoHandover &&
          (desiredPlaybackRate !== attemptedRate || desiredKeyLockEnabled !== attemptedKeyLock) &&
          !destroyed &&
          token === transitionToken &&
          hasCurrentPreparedTrack() &&
          !runtimeOwnsCurrent()
        ) {
          enqueueTempoHandover(token);
        }
      }
    });
  }

  function enqueueRuntimePlaylistStart(
    source: string,
    token: number
  ): void {
    if (runtimePlaylistStartPending) {
      debug('direct-start', 'coalesced');
      return;
    }
    runtimePlaylistStartPending = true;
    runtimePlaylistStartSource = source;
    if (sharesTrackIdentity(source, pendingRuntimePlaylistSource)) {
      clearPendingRuntimePlaylistSelection();
    }
    wakeHosts();
    lastDebugReason = 'direct-start';
    enqueueControlTask(async () => {
      try {
        if (destroyed || token !== transitionToken) {
          debug('direct-start', 'stale');
          return;
        }
        if (runtimeOwnsCurrent()) {
          debug('direct-start', 'already-owned');
          return;
        }
        // Ramp the outgoing origin to 0 in the page context (the only layer that can reach
        // Bandcamp's `new Audio()` element — it is not in the content-script DOM) before it
        // is paused, so the stop is faded rather than a hard cut.
        bridge.prepareRuntimeTakeover();
        bridge.pause();
        const started = await startRuntimeFromPrepared(source, 'direct-start', {
          positionSec: 0,
          volume: lastUserVolume,
          muted: lastUserMuted,
          playbackRate: desiredPlaybackRate,
          keyLockEnabled: desiredKeyLockEnabled,
          handoffGate: true,
          token,
          play: true
        });
        if (started) {
          debug('direct-start', 'runtime-playlist-ownership-taken');
        }
      } finally {
        if (token === transitionToken) {
          runtimePlaylistStartPending = false;
          runtimePlaylistStartSource = '';
        }
      }
    });
  }

  return {
    ensureActiveAudio() {
      const audio = bridge.ensureActiveAudio();
      if (audio) {
        originAudio = audio;
      }
      return audio;
    },

    getActiveAudio() {
      const audio = bridge.getActiveAudio();
      if (audio) {
        originAudio = audio;
      }
      return audio;
    },

    togglePlayPause() {
      if (runtimeOwnsCurrent()) {
        void active.togglePlayPause();
        return;
      }
      setOwner('origin-started');
      const audio = bridge.ensureActiveAudio();
      if (audio) {
        originAudio = audio;
      }
      bridge.togglePlayPause();
    },

    setVolume(volume) {
      lastUserVolume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : lastUserVolume;
      if (originOwnsCurrent()) {
        bridge.setVolume(volume);
      } else {
        active.setVolume(volume);
      }
    },

    setMuted(muted) {
      lastUserMuted = Boolean(muted);
      if (originOwnsCurrent()) {
        bridge.setMuted(muted);
      } else {
        active.setMuted(Boolean(muted));
      }
    },

    applyTempoAdjust(playbackRate, masterTempoEnabled) {
      const nextPlaybackRate = clampPlaybackRate(playbackRate);
      const nextKeyLockEnabled = Boolean(masterTempoEnabled);
      const changed =
        desiredPlaybackRate !== nextPlaybackRate ||
        desiredKeyLockEnabled !== nextKeyLockEnabled;
      desiredPlaybackRate = nextPlaybackRate;
      desiredKeyLockEnabled = nextKeyLockEnabled;
      wakeHosts();
      if (runtimeOwnsCurrent()) {
        pendingTempoHandover = false;
        if (!changed) {
          debug('tempo-adjust', 'runtime-active-controls-unchanged', {
            detail: `rate=${desiredPlaybackRate.toFixed(4)} keyLock=${desiredKeyLockEnabled ? '1' : '0'}`
          });
          return;
        }
        enqueueControlTask(async () => {
          await active.setTempo(desiredPlaybackRate, desiredKeyLockEnabled);
          debug('tempo-adjust', 'runtime-active-controls-synced', {
            detail: `rate=${desiredPlaybackRate.toFixed(4)} keyLock=${desiredKeyLockEnabled ? '1' : '0'}`
          });
        });
        return;
      }
      if (desiredPlaybackRate !== 1) {
        pendingTempoHandover = true;
        lastDebugReason = 'tempo-adjust';
        if (!hasCurrentPreparedTrack()) {
          input.requestCurrentRuntimePrepare?.('tempo-adjust-intent');
        }
        enqueueTempoHandover(transitionToken);
      } else {
        pendingTempoHandover = false;
      }
    },

    prepareNativeTransition(reason) {
      if (runtimeOwnsCurrent()) {
        return;
      }
      bridge.prepareNativeTransition(reason);
    },

    prepareRuntimeTakeover() {
      bridge.prepareRuntimeTakeover();
    },

    pause() {
      if (runtimeOwnsCurrent()) {
        enqueueControlTask(() => active.pause());
        return;
      }
      bridge.pause();
    },

    releaseToOrigin() {
      invalidateTransition();
      setOwner('origin-started');
      enqueueControlTask(() => pauseHosts());
    },

    setHostPerfSampling(enabled) {
      hostPerfSamplingEnabled = enabled;
      active.setPerfSampling(enabled);
      idle.setPerfSampling(enabled);
    },

    async collectHostPerfSnapshots() {
      // Snapshot the ping-pong pair. Identity uses the public trackId only (never the signed URL
      // token); a host whose iframe is not yet created resolves null and renders "not running".
      const hosts: Array<{ host: HostPlayer; active: boolean }> = [
        { host: active, active: true },
        { host: idle, active: false }
      ];
      return Promise.all(
        hosts.map(async ({ host, active: isActive }): Promise<RuntimeHostPerfReport> => {
          const snapshot = await host.getPerfSnapshot();
          return {
            hostId: host.id(),
            track: hostLoadedTrackId(host),
            active: isActive,
            perf: snapshot?.perf ?? null,
            underruns: snapshot?.underruns ?? null
          };
        })
      );
    },

    loadTrack(streamUrl, options) {
      const targetSrc = String(streamUrl || '').trim();
      if (!targetSrc) {
        return false;
      }
      resetTempoIntent();
      const token = invalidateTransition();

      const isDetachedSelection = Boolean(options?.detached);
      setOwner(isDetachedSelection ? 'runtime-pending' : 'origin-started');

      if (isDetachedSelection) {
        currentSource = targetSrc;
        input.onRuntimeSourceChanged?.(targetSrc);

        if (capability?.supported === false) {
          debug('direct-start', `capability-blocked:${capability.reason}`);
          return false;
        }

        const preparedForDirectStart = readPreparedTrack(engine, targetSrc);
        if (
          preparedForDirectStart &&
          (
            preparedForDirectStart.buffer ||
            active.hasLoadedTrackForSource(preparedForDirectStart.track.url)
          )
        ) {
          runtimePlaylistStartSource = targetSrc;
          currentSourceVersion = Number.isFinite(preparedForDirectStart.track.sourceVersion)
            ? preparedForDirectStart.track.sourceVersion
            : currentSourceVersion;
          debug('direct-start', 'runtime-playlist-load-enqueued', {
            detail: `src=${targetSrc.slice(-60)}`
          });
          enqueueRuntimePlaylistStart(targetSrc, token);
          return true;
        }

        debug('direct-start', 'runtime-waiting-for-prepared', {
          detail: `src=${targetSrc.slice(-60)}`
        });
        pendingRuntimePlaylistSource = targetSrc;
        pendingRuntimePlaylistToken = token;
        input.onPendingRuntimeSelectionChange?.(true);
        // Stop any old audible owner while the chosen track is decoded.
        // Starting native detached audio here bypasses SignalSmith and can leave it muted.
        bridge.pause();
        enqueueControlTask(async () => {
          await pauseHosts();
        });
        input.requestCurrentRuntimePrepare?.('runtime-playlist-selection-intent');
        return true;
      }

      enqueueControlTask(async () => {
        await pauseHosts();
        if (destroyed || token !== transitionToken) {
          return;
        }
        bridge.loadTrack(targetSrc, options);
      });
      return true;
    },

    seekToFraction(fraction) {
      const safeFraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
      if (runtimeOwnsCurrent()) {
        input.onSeekDispatch?.({
          fraction: safeFraction,
          runtimeOwned: true,
          preparedLoaded: true,
          runtimeDispatched: true,
          nativeDispatched: false,
          handoverPending: false
        });
        enqueueRuntimeOwnedSeek(safeFraction);
        return;
      }
      // Coalesce repeats while a handover is already pending. A waveform drag emits a seek per
      // animation frame (~60/sec); on a track that isn't runtime-owned yet, the seek cannot apply
      // until it is prepared, so re-dispatching debug/render and re-kicking the predecode every
      // frame is pure waste (and, with the debug panel open, that event flood is what stalls the
      // tab). Only the first seek of a pending episode dispatches + kicks prepare; later drag
      // frames just update the target fraction, and onPreparedTrackReady applies the latest one.
      const wasPending = pendingSeekFraction !== null;
      pendingSeekFraction = safeFraction;
      if (!wasPending) {
        const preparedLoaded = hasCurrentPreparedTrack();
        input.onSeekDispatch?.({
          fraction: safeFraction,
          runtimeOwned: false,
          preparedLoaded,
          runtimeDispatched: false,
          nativeDispatched: false,
          handoverPending: true
        });
        lastDebugReason = 'seek';
        if (!preparedLoaded) {
          input.requestCurrentRuntimePrepare?.('seek-intent');
        }
      }
      enqueueSeekHandover(transitionToken);
    },

    skipTrack(direction) {
      const token = invalidateTransition();
      setOwner('origin-started');
      enqueueControlTask(async () => {
        await pauseHosts();
        if (!destroyed && token === transitionToken) {
          bridge.skipTrack(direction);
        }
      });
    },

    destroy() {
      destroyed = true;
      invalidateTransition();
      void active.destroy();
      void idle.destroy();
    },

    setCurrentSource(src, sourceVersion) {
      const nextSource = String(src || '').trim();
      const sourceChanged = Boolean(currentSource && nextSource && !sharesTrackIdentity(currentSource, nextSource));
      currentSource = nextSource;
      currentSourceVersion = Number.isFinite(sourceVersion) ? Number(sourceVersion) : -1;
      if (!nextSource || sourceChanged) {
        resetTempoIntent();
        invalidateTransition();
        setOwner('origin-started');
        enqueueControlTask(() => pauseHosts());
      }
      if (nextSource && needsRuntimePlayback() && readPreparedTrack(engine, nextSource) && !originPlaybackActive()) {
        enqueueControlTask(async () => {
          await loadCurrentPreparedTrack('current-source-prepared');
        });
      }
    },

    onOriginAudioState(audio, eventType = 'state') {
      if (audio) {
        originAudio = audio;
        // Skip while a protective silence is forcing the element to 0/muted, otherwise the
        // transient mute (observed via the pause/timeupdate events fired during the handover)
        // poisons lastUserVolume and the next runtime direct-start plays muted.
        if (originProtectionDepth === 0 && !eventType.endsWith(':native-transition-silence')) {
          lastUserVolume = audio.volume;
          lastUserMuted = audio.muted;
        }
        if (pauseCompetingOriginAudio(audio, eventType)) {
          return;
        }
      }
      if (eventType === 'play' || eventType === 'audio-changed') {
        wakeHosts();
      }
    },

    onPreparedTrackReady() {
      if (pendingSeekFraction !== null) {
        enqueueSeekHandover(transitionToken);
        return;
      }
      if (originOwnsCurrent() && pendingTempoHandover) {
        enqueueTempoHandover(transitionToken);
        return;
      }
      if (
        ownershipState === 'runtime-pending' &&
        pendingRuntimePlaylistSource &&
        pendingRuntimePlaylistToken === transitionToken &&
        readPreparedTrack(engine, pendingRuntimePlaylistSource)
      ) {
        debug('prepared-track-ready', 'runtime-pending-ready', {
          detail: `src=${pendingRuntimePlaylistSource.slice(-60)}`
        });
        enqueueRuntimePlaylistStart(pendingRuntimePlaylistSource, transitionToken);
        return;
      }
      if (!originPlaybackActive() && needsRuntimePlayback()) {
        enqueueControlTask(async () => {
          await loadCurrentPreparedTrack('prepared-track-ready');
        });
      } else if (!originPlaybackActive()) {
        debug('prepared-track-ready', 'skip-passive-neutral-runtime');
      } else {
        debug('prepared-track-ready', 'skip-passive-origin-playing');
      }
    }
  };
}
