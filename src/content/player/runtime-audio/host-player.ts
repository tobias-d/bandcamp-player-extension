/**
 * Content-script side of the extension iframe runtime audio host.
 *
 * Injects a hidden <iframe src="moz-extension://…/public/runtime-audio-host.html"> and
 * routes all player commands to it via postMessage.
 *
 * The iframe runs in the extension's CSP context (WASM allowed), avoiding Bandcamp's CSP
 * which blocks WebAssembly.instantiate() in the content-script context.
 */

import { extensionAssetUrl } from '@/utils/asset-url';
import type { RuntimeAudioPlaybackState, RuntimeStretchCapability } from '@/content/player/runtime-audio/types';
import type { ContextResourceSample } from '@/shared/resource-sampler';
import { sourcesShareTrackIdentity } from '@/content/playlist/track-identity';
import { createLogger } from '@/utils/debug';

export interface HostPerfSnapshot {
  perf: ContextResourceSample | null;
  underruns: number | null;
}

const logger = createLogger('AUDIO');

const HOST_PAGE_PATH = 'public/runtime-audio-host.html';
const HOST_IFRAME_ATTR = 'data-bc-runtime-audio-host';
const HOST_READY_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 15_000;

// Feed the decoded track into the worklet as small slices (with a yield between each) instead of
// one ~O(bytes) transfer, so no single copy stalls the shared audio thread long enough to crack the
// other host during a switch.
//
// Firefox-only by design: only Firefox renders sibling AudioContexts on a shared audio thread, so
// only there does the per-switch addBuffers transfer starve the active track. Chrome's transfer is
// effectively free and never stalls, so chunking would add switch latency for zero benefit — it
// keeps the fast single-shot load. Default ON for Firefox; `__BC_RUNTIME_CHUNKED_FEED__=0` is a
// kill-switch. Read once on the content-script (bandcamp.com) origin — the iframe has a different
// origin/localStorage, so the result is passed per LOAD_TRACK message.
const RUNTIME_CHUNKED_FEED = ((): boolean => {
  if (__BUILD_TARGET__ !== 'firefox') {
    return false;
  }
  try {
    return localStorage.getItem('__BC_RUNTIME_CHUNKED_FEED__') !== '0';
  } catch {
    return true;
  }
})();

// Two long-lived hosts coexist for the ping-pong runtime audio design, so iframe cleanup must
// keep live siblings and remove only orphans. Each content-script load gets a unique prefix so
// iframes left by a previous load are always distinguishable from this load's live hosts.
const HOST_INSTANCE_PREFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let hostInstanceCounter = 0;
const liveHostInstanceIds = new Set<string>();

interface HostPlayerInput {
  onState(state: RuntimeAudioPlaybackState): void;
  onEnded(): void;
  onDebug?(stage: string, info?: { detail?: string }): void;
}

export interface HostPlayer {
  probe(): Promise<RuntimeStretchCapability>;
  hasLoadedTrackForSource(src: string): boolean;
  getLoadedSource(): string;
  loadTrack(src: string, buffer?: AudioBuffer, options?: { transfer?: boolean; freshGraph?: boolean }): Promise<void>;
  setTempo(playbackRate: number, keyLockEnabled: boolean): Promise<void>;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  playFromTime(
    positionSec: number,
    playbackRate: number,
    keyLockEnabled: boolean,
    volume?: number,
    muted?: boolean,
    options?: { handoffGate?: boolean }
  ): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  togglePlayPause(): Promise<void>;
  seekToTime(positionSec: number): Promise<void>;
  seekToFraction(fraction: number): Promise<void>;
  stop(options?: { drainOutputBeforeClear?: boolean }): Promise<void>;
  destroy(options?: { awaitContextClose?: boolean }): Promise<void>;
  wake(): void;
  id(): string;
  setPerfSampling(enabled: boolean): void;
  getPerfSnapshot(): Promise<HostPerfSnapshot | null>;
}

export function createHostPlayer(input: HostPlayerInput): HostPlayer {
  const iframeUrl = extensionAssetUrl(HOST_PAGE_PATH);
  const instanceId = `${HOST_INSTANCE_PREFIX}-${(hostInstanceCounter += 1)}`;
  liveHostInstanceIds.add(instanceId);

  let iframe: HTMLIFrameElement | null = null;
  let readyPromise: Promise<void> | null = null;
  let readyResolve: (() => void) | null = null;

  let ackCounter = 0;
  const ackMap = new Map<number, (data: Record<string, unknown>) => void>();

  let loadedUrl = '';
  let localPaused = true;
  let destroyed = false;

  // ---------------------------------------------------------------------------
  // Iframe injection
  // ---------------------------------------------------------------------------

  function injectIframe(): void {
    if (iframe) {
      return;
    }

    document.querySelectorAll(`iframe[${HOST_IFRAME_ATTR}]`).forEach((node) => {
      if (!(node instanceof HTMLIFrameElement) || !node.parentNode) {
        return;
      }
      // Keep iframes owned by a currently-live host instance (the ping-pong sibling);
      // remove only orphans left by a previous content-script load.
      const ownerId = node.getAttribute(HOST_IFRAME_ATTR);
      if (ownerId && liveHostInstanceIds.has(ownerId)) {
        return;
      }
      node.parentNode.removeChild(node);
    });

    readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    iframe = document.createElement('iframe');
    iframe.src = iframeUrl;
    iframe.setAttribute(HOST_IFRAME_ATTR, instanceId);
    // 1×1px at top-left corner, opacity:0 — keeps the iframe in the viewport so Firefox
    // does not throttle its audio rendering (cross-origin off-screen iframes are throttled).
    // Non-zero dimensions prevent Firefox from treating the document as inactive.
    iframe.style.cssText =
      'position:fixed;top:0;left:0;width:1px;height:1px;border:none;pointer-events:none;z-index:-9999;opacity:0;';
    iframe.setAttribute('allow', 'autoplay');
    document.body.appendChild(iframe);
  }

  // ---------------------------------------------------------------------------
  // Messaging utilities
  // ---------------------------------------------------------------------------

  function postToIframe(msg: Record<string, unknown>, transfer?: Transferable[]): void {
    if (!iframe?.contentWindow || destroyed) {
      return;
    }
    iframe.contentWindow.postMessage(msg, '*', transfer ?? []);
  }

  function nextAckId(): number {
    const id = ackCounter;
    ackCounter += 1;
    return id;
  }

  function waitForAck(
    ackId: number,
    timeoutMs = ACK_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        ackMap.delete(ackId);
        reject(new Error(`ack-timeout-${ackId}`));
      }, timeoutMs);

      ackMap.set(ackId, (data) => {
        window.clearTimeout(timer);
        resolve(data);
      });
    });
  }

  async function waitForReady(): Promise<void> {
    if (!readyPromise || !iframe) {
      return;
    }
    const timeout = new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error('host-ready-timeout'));
      }, HOST_READY_TIMEOUT_MS);
    });
    await Promise.race([readyPromise, timeout]);
  }

  // ---------------------------------------------------------------------------
  // Inbound message handler
  // ---------------------------------------------------------------------------

  function handleMessage(event: MessageEvent): void {
    if (!iframe?.contentWindow || event.source !== iframe.contentWindow) {
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = event.data as any;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    switch (msg.type as string) {
      case 'HOST_READY': {
        readyResolve?.();
        readyResolve = null;
        break;
      }

      case 'ACK': {
        const ackId = msg.ackId as number;
        const handler = ackMap.get(ackId);
        if (handler) {
          ackMap.delete(ackId);
          handler(msg as Record<string, unknown>);
        }
        break;
      }

      case 'STATE': {
        const state = msg as {
          paused?: boolean;
        };
        localPaused = Boolean(state.paused ?? true);
        input.onState(msg as unknown as RuntimeAudioPlaybackState);
        break;
      }

      case 'ENDED': {
        localPaused = true;
        input.onEnded();
        break;
      }

      case 'DEBUG': {
        logger.debug('[HOST]', msg.detail ?? msg.msg ?? msg);
        if (typeof msg.stage === 'string') {
          input.onDebug?.(msg.stage, {
            detail: typeof msg.detail === 'string' ? msg.detail : undefined
          });
        }
        break;
      }

      default:
        break;
    }
  }

  window.addEventListener('message', handleMessage);

  // Inject iframe immediately on construction
  injectIframe();

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  return {
    async probe(): Promise<RuntimeStretchCapability> {
      // The host runs inside a moz-extension:// iframe where WASM and AudioWorklet are
      // always allowed. A live probe context would just replicate the failure we're
      // trying to avoid (Firefox AbortError on blob-URL addModule in hidden iframes).
      // Instead, trust the extension environment and declare capability as soon as the
      // iframe is alive. Real failures surface through the takeover `failed:` stage.
      try {
        await waitForReady();
        return { supported: true, reason: 'ok', detail: 'extension-page-trusted', checkedAt: Date.now() };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { supported: false, reason: 'host-not-ready', detail, checkedAt: Date.now() };
      }
    },

    hasLoadedTrackForSource(src: string): boolean {
      const candidate = String(src || '').trim();
      return Boolean(candidate && loadedUrl && sourcesShareTrackIdentity(candidate, loadedUrl));
    },

    getLoadedSource(): string {
      return loadedUrl;
    },

    async loadTrack(src: string, buffer?: AudioBuffer, options?: { transfer?: boolean; freshGraph?: boolean }): Promise<void> {
      const safeSource = String(src || '').trim();
      if (!safeSource || !buffer) {
        return;
      }

      await waitForReady();
      const totalStart = performance.now();
      logger.debug(`[HOST-PLAYER] loadTrack start src=${safeSource} transfer=${Boolean(options?.transfer)}`);

      const channels: Float32Array[] = [];
      const transfers: ArrayBuffer[] = [];
      const copyStart = performance.now();
      for (let i = 0; i < buffer.numberOfChannels; i += 1) {
        // When transfer=true, move the original channel data directly (zero-copy).
        // The source AudioBuffer becomes detached — only safe when the caller
        // no longer needs the buffer (e.g. proactive preload).
        const ch = options?.transfer ? buffer.getChannelData(i) : buffer.getChannelData(i).slice(0);
        channels.push(ch);
        transfers.push(ch.buffer);
      }
      const copyMs = Math.round(performance.now() - copyStart);
      input.onDebug?.('host-player-load-copy', {
        detail: `copyMs=${copyMs} channels=${buffer.numberOfChannels} frames=${buffer.length} transfer=${options?.transfer ? '1' : '0'}`
      });

      const ackId = nextAckId();
      const ackStart = performance.now();
      postToIframe(
        {
          type: 'LOAD_TRACK',
          ackId,
          url: safeSource,
          channels,
          sampleRate: buffer.sampleRate,
          numberOfFrames: buffer.length,
          freshGraph: options?.freshGraph === true,
          chunkedFeed: RUNTIME_CHUNKED_FEED
        },
        transfers
      );
      const ackData = await waitForAck(ackId);
      if (typeof ackData.error === 'string' && ackData.error) {
        throw new Error(`iframe-load-failed:${ackData.error}`);
      }
      const ackMs = Math.round(performance.now() - ackStart);
      const totalMs = Math.round(performance.now() - totalStart);
      input.onDebug?.('host-player-load-ack', {
        detail: `ackMs=${ackMs} totalMs=${totalMs}`
      });
      loadedUrl = safeSource;
      localPaused = true;
      logger.debug(`[HOST-PLAYER] loadTrack ack src=${safeSource}`);
    },

    async setTempo(playbackRate: number, keyLockEnabled: boolean): Promise<void> {
      postToIframe({ type: 'SET_TEMPO', playbackRate, keyLockEnabled });
    },

    setVolume(volume: number): void {
      postToIframe({ type: 'SET_VOLUME', volume });
    },

    setMuted(muted: boolean): void {
      postToIframe({ type: 'SET_MUTED', muted });
    },

    setPerfSampling(enabled: boolean): void {
      // Fire-and-forget like SET_VOLUME; the iframe starts/stops its own sampler.
      postToIframe({ type: 'SET_PERF_SAMPLING', enabled });
    },

    async getPerfSnapshot(): Promise<HostPerfSnapshot | null> {
      if (!iframe?.contentWindow || destroyed) {
        return null;
      }
      const ackId = nextAckId();
      postToIframe({ type: 'GET_PERF_SNAPSHOT', ackId });
      try {
        const ack = await waitForAck(ackId, 1_500);
        return {
          perf: (ack.perf as ContextResourceSample | null) ?? null,
          underruns: typeof ack.underruns === 'number' ? ack.underruns : null
        };
      } catch {
        return null;
      }
    },

    async playFromTime(
      positionSec: number,
      playbackRate: number,
      keyLockEnabled: boolean,
      volumeOverride?: number,
      mutedOverride?: boolean,
      options: { handoffGate?: boolean } = {}
    ): Promise<void> {
      if (!loadedUrl) {
        return;
      }
      await waitForReady();
      const ackId = nextAckId();
      const ackStart = performance.now();
      postToIframe({
        type: 'PLAY_FROM_TIME',
        ackId,
        positionSec: Number.isFinite(positionSec) ? Number(positionSec) : 0,
        playbackRate,
        keyLockEnabled,
        volume: Number.isFinite(volumeOverride) ? Number(volumeOverride) : undefined,
        muted: typeof mutedOverride === 'boolean' ? mutedOverride : undefined,
        handoffGate: options.handoffGate !== false
      });
      const playAck = await waitForAck(ackId);
      if (typeof playAck.error === 'string' && playAck.error) {
        throw new Error(`iframe-play-failed:${playAck.error}`);
      }
      input.onDebug?.('host-player-play-ack', {
        detail: `ackMs=${Math.round(performance.now() - ackStart)}`
      });
      localPaused = false;
    },

    async play(): Promise<void> {
      if (!loadedUrl) {
        return;
      }
      await waitForReady();
      const ackId = nextAckId();
      postToIframe({ type: 'PLAY', ackId });
      const playAck = await waitForAck(ackId);
      if (typeof playAck.error === 'string' && playAck.error) {
        throw new Error(`iframe-play-failed:${playAck.error}`);
      }
      localPaused = false;
    },

    async pause(): Promise<void> {
      if (!loadedUrl) {
        localPaused = true;
        return;
      }
      await waitForReady();
      const ackId = nextAckId();
      postToIframe({ type: 'PAUSE', ackId });
      const pauseAck = await waitForAck(ackId);
      if (typeof pauseAck.error === 'string' && pauseAck.error) {
        throw new Error(`iframe-pause-failed:${pauseAck.error}`);
      }
      localPaused = true;
    },

    async togglePlayPause(): Promise<void> {
      if (localPaused) {
        await this.play();
      } else {
        await this.pause();
      }
    },

    async seekToTime(positionSec: number): Promise<void> {
      if (!loadedUrl) {
        return;
      }
      const safeTime = Number.isFinite(positionSec) ? Number(positionSec) : 0;
      postToIframe({ type: 'SEEK_TO_TIME', positionSec: safeTime });
    },

    async seekToFraction(fraction: number): Promise<void> {
      if (!loadedUrl) {
        return;
      }
      const safeFraction = Number.isFinite(fraction) ? fraction : 0;
      postToIframe({ type: 'SEEK_TO_FRACTION', fraction: safeFraction });
    },

    async stop(options: { drainOutputBeforeClear?: boolean } = {}): Promise<void> {
      if (!loadedUrl) {
        localPaused = true;
        return;
      }
      await waitForReady();
      const ackId = nextAckId();
      const ackStart = performance.now();
      postToIframe({
        type: 'STOP',
        ackId,
        drainOutputBeforeClear: options.drainOutputBeforeClear === true
      });
      const stopAck = await waitForAck(ackId);
      if (typeof stopAck.error === 'string' && stopAck.error) {
        throw new Error(`iframe-stop-failed:${stopAck.error}`);
      }
      input.onDebug?.('host-player-stop-ack', {
        detail: `ackMs=${Math.round(performance.now() - ackStart)}`
      });
      loadedUrl = '';
      localPaused = true;
    },

    wake(): void {
      postToIframe({ type: 'WAKE' });
    },

    id(): string {
      return instanceId;
    },

    async destroy(options: { awaitContextClose?: boolean } = {}): Promise<void> {
      if (destroyed) {
        return;
      }
      if (options.awaitContextClose) {
        const ackId = nextAckId();
        const ackStart = performance.now();
        postToIframe({ type: 'DESTROY', ackId });
        const destroyAck = await waitForAck(ackId);
        if (typeof destroyAck.error === 'string' && destroyAck.error) {
          throw new Error(`iframe-destroy-failed:${destroyAck.error}`);
        }
        input.onDebug?.('host-player-destroy-ack', {
          detail: `ackMs=${Math.round(performance.now() - ackStart)} contextClosed=${destroyAck.contextClosed === true ? '1' : '0'}`
        });
      } else {
        postToIframe({ type: 'DESTROY' });
      }
      destroyed = true;
      liveHostInstanceIds.delete(instanceId);
      window.removeEventListener('message', handleMessage);
      // Clear any pending ACK waiters
      for (const handler of ackMap.values()) {
        handler({ type: 'ACK', ackId: -1 });
      }
      ackMap.clear();
      if (iframe?.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
      iframe = null;
      loadedUrl = '';
    }
  };
}
