/**
 * Extension iframe host for Signalsmith time-stretching.
 *
 * This script runs inside a hidden <iframe src="moz-extension://…/public/runtime-audio-host.html">.
 * Extension pages are NOT subject to Bandcamp's CSP, so WASM and AudioWorklet load normally.
 *
 * SignalsmithStretch.moduleUrl is set to public/signalsmith/worklet.js (generated at build time
 * by tools/build/generate-signalsmith-worklet.js).  Firefox extension pages hang indefinitely when
 * addModule() is given a blob: URL, so we use a real moz-extension:// URL instead.
 *
 * Protocol (parent → iframe):
 *   { type:'PROBE', ackId }
 *   { type:'LOAD_TRACK', ackId, url, channels:Float32Array[], sampleRate, numberOfFrames }
 *   { type:'SET_TEMPO', playbackRate, keyLockEnabled }
 *   { type:'SEEK_TO_TIME', positionSec }
 *   { type:'SEEK_TO_FRACTION', fraction }
 *   { type:'PLAY_FROM_TIME', ackId, positionSec, playbackRate, keyLockEnabled, volume?, muted?, handoffGate? }
 *   { type:'PLAY', ackId }
 *   { type:'PAUSE' }
 *   { type:'STOP', ackId?, drainOutputBeforeClear? }
 *   { type:'SET_VOLUME', volume }
 *   { type:'SET_MUTED', muted }
 *   { type:'SET_PERF_SAMPLING', enabled }          // resource diagnostics, panel-open only
 *   { type:'GET_PERF_SNAPSHOT', ackId }            // → ACK { perf, underruns }
 *   { type:'DESTROY', ackId? }
 *
 * Protocol (iframe → parent):
 *   { type:'HOST_READY' }
 *   { type:'ACK', ackId, ...extraFields }
 *   { type:'STATE', src, paused, currentTimeSec, durationSec, volume, muted, ts }
 *   { type:'ENDED' }
 */

import SignalsmithStretch from 'signalsmith-stretch';
import type { SignalsmithStretchNode } from 'signalsmith-stretch';
import { createResourceSampler } from '@/shared/resource-sampler';

const TIME_UPDATE_INTERVAL_SECONDS = 0.05;
const END_TOLERANCE_SECONDS = 0.02;
const MICRO_FADE_SECONDS = 0.008; // 8ms fade-in for ordinary cold starts / pause-resume transitions
const PAUSE_FADE_SECONDS = 0.02; // 20ms fade-out before pausing/stopping to avoid stop clicks
const START_PREROLL_SECONDS = 0.03; // 30ms muted preroll before the requested audible handoff point
const HANDOFF_GATE_HOLD_SECONDS = 0.12; // Hard mute Signalsmith's first handoff blocks.
const HANDOFF_GATE_FADE_SECONDS = 0.03;
const RUNTIME_OUTPUT_HEADROOM_GAIN = 0.78; // Firefox traces showed post-gain first-window peaks above 1.0.
const OUTPUT_DRAIN_SAFETY_SECONDS = 0.03; // Keep faded output alive beyond the browser-reported sink latency.
// Chunked/incremental feeding (opt-in via LOAD_TRACK.chunkedFeed). A single addBuffers transfers
// the whole decoded track into the worklet in one ~O(bytes) copy (~1 ms/MB on Firefox); a ~100 MB
// track stalls the shared audio thread for ~100–120 ms, overrunning the ~28 ms output ring and
// cracking the *other* host's playback during a ping-pong switch. Feeding the track as small slices
// with a yield between each keeps every single transfer well under the ring headroom, so the active
// render never starves. Requires the multi-chunk feeding-loop fix (generate-signalsmith-worklet #7).
const FEED_CHUNK_BYTES = 3 * 1024 * 1024; // ~3 MB/slice — keep each transfer well under the output ring
const FEED_CHUNK_YIELD_MS = 12; // let the audio thread render + refill the ring between slices

// Player state
let context: AudioContext | null = null;
let stretchNode: SignalsmithStretchNode | null = null;
let handoffGateNode: GainNode | null = null;
let gainNode: GainNode | null = null;
let analyserNode: AnalyserNode | null = null;
let keepAliveSource: ConstantSourceNode | null = null;

let loadedUrl = '';
let durationSec = 0;
let stretchNodePromise: Promise<SignalsmithStretchNode> | null = null;
let currentTimeSec = 0;
let liveTimeFloorSec = 0;
let paused = true;
let endedNotified = false;
let playbackRate = 1;
let keyLockEnabled = true;
let volume = 1;
let muted = false;
let setTempoVersion = 0;
let stretchLatencySeconds = 0;
let firstWindowProbeTimer = 0;
let firstWindowProbeSession = 0;
let startupFadeStartCtx = 0;
let startupFadeEndCtx = 0;
let requestedContextSampleRate = 0;
let lastUnderrunCount: number | null = null;
let lastUnderrunDuration: number | null = null;
let hostContextCreateCount = 0;
let hostGraphCreateCount = 0;
let hostTrackLoadCount = 0;
let hostReplacementCount = 0;
let hostActivePcmBytes = 0;
let hostSubmittedPcmBytes = 0;
let hostReleasedPcmBytes = 0;

let sequence = Promise.resolve();

// Resource-diagnostics sampler. Started only while a debug panel is open (driven by the content
// controller's SET_PERF_SAMPLING). On Firefox this iframe's AudioContext shares the one audio
// thread, so the sampler must never run when the panel is closed.
const resourceSampler = createResourceSampler();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postToParent(msg: Record<string, unknown>): void {
  window.parent.postMessage(msg, '*');
}

function emitDebug(stage: string, detail: string): void {
  postToParent({
    type: 'DEBUG',
    stage,
    detail
  });
}

function emitContextStats(reason: string, ctx: AudioContext): void {
  const extended = ctx as AudioContext & {
    outputLatency?: number;
    getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
    playbackStats?: {
      underrunCount?: number;
      totalUnderrunDuration?: number;
      underrunEvents?: number;
      underrunDuration?: number;
    };
  };
  const outputLatency = Number.isFinite(extended.outputLatency)
    ? Number(extended.outputLatency).toFixed(4)
    : '-';
  const baseLatency = Number.isFinite(ctx.baseLatency)
    ? Number(ctx.baseLatency).toFixed(4)
    : '-';
  const playbackStats = extended.playbackStats;
  const underrunCountRaw = playbackStats?.underrunCount ?? playbackStats?.underrunEvents;
  const underrunDurationRaw = playbackStats?.totalUnderrunDuration ?? playbackStats?.underrunDuration;
  const underrunCount = Number.isFinite(underrunCountRaw) ? Number(underrunCountRaw) : null;
  const underrunDurationValue = Number.isFinite(underrunDurationRaw) ? Number(underrunDurationRaw) : null;
  const underrunDelta =
    underrunCount !== null && lastUnderrunCount !== null
      ? underrunCount - lastUnderrunCount
      : null;
  const underrunDurationDelta =
    underrunDurationValue !== null && lastUnderrunDuration !== null
      ? underrunDurationValue - lastUnderrunDuration
      : null;
  if (underrunCount !== null) {
    lastUnderrunCount = underrunCount;
  }
  if (underrunDurationValue !== null) {
    lastUnderrunDuration = underrunDurationValue;
  }
  emitDebug(
    'host-context-stats',
    `reason=${reason} state=${ctx.state} sampleRate=${ctx.sampleRate} baseLatency=${baseLatency} outputLatency=${outputLatency} outputTimestamp=${typeof extended.getOutputTimestamp === 'function' ? '1' : '0'} underruns=${underrunCount ?? '-'} underrunDelta=${underrunDelta ?? '-'} underrunDuration=${underrunDurationValue ?? '-'} underrunDurationDelta=${underrunDurationDelta ?? '-'}`
  );
}

function createAudioContext(sampleRate?: number): AudioContext {
  if (Number.isFinite(sampleRate) && Number(sampleRate) > 0) {
    try {
      return new AudioContext({ sampleRate: Number(sampleRate) });
    } catch {
      // Fall back to the browser default sample rate when the constructor rejects
      // the requested value.
    }
  }
  return new AudioContext();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatDebugBytes(bytes: number): string {
  return `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(1)}MiB`;
}

function emitHostInputChurn(): void {
  emitDebug(
    'host-input-churn',
    `loads=${hostTrackLoadCount} replacements=${hostReplacementCount} contexts=${hostContextCreateCount} graphs=${hostGraphCreateCount} activePcm=${formatDebugBytes(hostActivePcmBytes)} submittedPcm=${formatDebugBytes(hostSubmittedPcmBytes)} releasedPcm=${formatDebugBytes(hostReleasedPcmBytes)}`
  );
}

function resolveSemitones(rate: number, keyLock: boolean): number {
  if (keyLock || rate <= 0) {
    return 0;
  }
  return 12 * Math.log2(rate);
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function emitState(): void {
  postToParent({
    type: 'STATE',
    src: loadedUrl,
    paused,
    currentTimeSec,
    durationSec,
    volume,
    muted,
    ts: Date.now()
  });
}

function resolveOutputGain(): number {
  return muted ? 0 : volume * RUNTIME_OUTPUT_HEADROOM_GAIN;
}

function updateGain(): void {
  if (!gainNode) {
    return;
  }
  const targetGain = resolveOutputGain();
  if (context && context.state === 'running') {
    const now = context.currentTime;
    const gain = gainNode.gain;
    gain.cancelScheduledValues(now);
    if (startupFadeEndCtx > now) {
      const fadeStartCtx = Math.max(now, startupFadeStartCtx);
      gain.setValueAtTime(0, now);
      gain.setValueAtTime(0, fadeStartCtx);
      gain.linearRampToValueAtTime(targetGain, startupFadeEndCtx);
      return;
    }
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(targetGain, now + 0.005);
    return;
  }
  gainNode.gain.value = targetGain;
}

function clearFirstWindowProbe(): void {
  firstWindowProbeSession += 1;
  if (firstWindowProbeTimer > 0) {
    window.clearTimeout(firstWindowProbeTimer);
    firstWindowProbeTimer = 0;
  }
}

function waitUntilContextTime(ctx: AudioContext, targetTime: number): Promise<void> {
  const delayMs = Math.max(0, Math.ceil((targetTime - ctx.currentTime) * 1000));
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function fadeOutForInactiveTransition(debugStage: 'pause' | 'stop' | 'load'): Promise<void> {
  if (!context || !gainNode || context.state !== 'running') {
    return;
  }

  const now = context.currentTime;
  const fadeEndCtx = now + PAUSE_FADE_SECONDS;
  const gain = gainNode.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(0, fadeEndCtx);
  emitDebug(`host-${debugStage}-fade`, `fadeMs=${Math.round(PAUSE_FADE_SECONDS * 1000)} from=${gain.value.toFixed(4)}`);
  await waitUntilContextTime(context, fadeEndCtx);
}

function scheduleHandoffGate(releaseStartCtx: number): void {
  if (!context || !handoffGateNode) {
    return;
  }
  const now = context.currentTime;
  const releaseEndCtx = releaseStartCtx + HANDOFF_GATE_FADE_SECONDS;
  const gain = handoffGateNode.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(0, now);
  gain.setValueAtTime(0, Math.max(now, releaseStartCtx));
  gain.linearRampToValueAtTime(1, Math.max(now, releaseEndCtx));
}

function openHandoffGate(): void {
  if (!context || !handoffGateNode) {
    return;
  }
  const now = context.currentTime;
  const gain = handoffGateNode.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(1, now);
}

function armFirstWindowProbe(
  expectedOutputCtx: number,
  inputTimeSec: number,
  rate: number
): void {
  if (!context || !analyserNode) {
    return;
  }

  clearFirstWindowProbe();
  const session = firstWindowProbeSession;
  const sampleBuffer = new Float32Array(analyserNode.fftSize);
  const deadlineCtx = expectedOutputCtx + 0.16;
  const startedAtCtx = context.currentTime;
  let sampleReads = 0;
  let maxPeak = 0;
  let maxRms = 0;
  let maxStep = 0;
  let firstNonSilentCtx: number | null = null;

  const poll = (): void => {
    if (!context || !analyserNode || session !== firstWindowProbeSession) {
      return;
    }

    analyserNode.getFloatTimeDomainData(sampleBuffer);
    sampleReads += 1;

    let sumSquares = 0;
    let localPeak = 0;
    let localStep = 0;
    let previous = sampleBuffer[0] || 0;

    for (let index = 0; index < sampleBuffer.length; index += 1) {
      const value = sampleBuffer[index] || 0;
      const absValue = Math.abs(value);
      const step = Math.abs(value - previous);
      previous = value;
      if (absValue > localPeak) {
        localPeak = absValue;
      }
      if (step > localStep) {
        localStep = step;
      }
      sumSquares += value * value;
    }

    const localRms = Math.sqrt(sumSquares / sampleBuffer.length);
    maxPeak = Math.max(maxPeak, localPeak);
    maxRms = Math.max(maxRms, localRms);
    maxStep = Math.max(maxStep, localStep);
    if (firstNonSilentCtx === null && localPeak >= 0.002) {
      firstNonSilentCtx = context.currentTime;
    }

    if (context.currentTime >= deadlineCtx || paused) {
      const nonSilentMs = firstNonSilentCtx === null
        ? '-'
        : `${Math.round((firstNonSilentCtx - expectedOutputCtx) * 1000)}ms`;
      emitDebug(
        'host-first-window',
        `input=${inputTimeSec.toFixed(2)} rate=${rate.toFixed(4)} peak=${maxPeak.toFixed(4)} rms=${maxRms.toFixed(4)} step=${maxStep.toFixed(4)} nonSilent=${nonSilentMs} reads=${sampleReads} probeMs=${Math.round((context.currentTime - startedAtCtx) * 1000)}`
      );
      firstWindowProbeTimer = 0;
      return;
    }

    firstWindowProbeTimer = window.setTimeout(poll, 8);
  };

  firstWindowProbeTimer = window.setTimeout(poll, 0);
}

// ---------------------------------------------------------------------------
// AudioContext + Signalsmith node lifecycle
// ---------------------------------------------------------------------------

function ensureContext(): AudioContext {
  if (!context || context.state === 'closed') {
    context = createAudioContext(requestedContextSampleRate || undefined);
    hostContextCreateCount += 1;
  }
  return context;
}

async function disposeAudioGraph(closeContext: boolean): Promise<boolean> {
  clearFirstWindowProbe();

  if (keepAliveSource) {
    try {
      keepAliveSource.stop();
      keepAliveSource.disconnect();
    } catch {
      // ignore
    }
    keepAliveSource = null;
  }
  if (stretchNode) {
    try {
      stretchNode.disconnect();
    } catch {
      // ignore
    }
  }
  if (handoffGateNode) {
    try {
      handoffGateNode.disconnect();
    } catch {
      // ignore
    }
  }
  if (gainNode) {
    try {
      gainNode.disconnect();
    } catch {
      // ignore
    }
  }
  if (analyserNode) {
    try {
      analyserNode.disconnect();
    } catch {
      // ignore
    }
  }
  stretchNode = null;
  stretchNodePromise = null;
  handoffGateNode = null;
  gainNode = null;
  analyserNode = null;
  stretchLatencySeconds = 0;
  startupFadeStartCtx = 0;
  startupFadeEndCtx = 0;

  if (!closeContext) {
    return true;
  }
  if (!context || context.state === 'closed') {
    context = null;
    return true;
  }

  const contextToClose = context;
  try {
    await contextToClose.close();
  } catch {
    return false;
  }
  if (contextToClose.state !== 'closed') {
    return false;
  }
  if (context === contextToClose) {
    context = null;
  }
  return true;
}

async function ensureContextSampleRate(sampleRate: number): Promise<void> {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return;
  }

  const desired = Math.round(Number(sampleRate));
  requestedContextSampleRate = desired;

  if (!context || context.state === 'closed') {
    return;
  }

  const current = Math.round(context.sampleRate);
  if (Math.abs(current - desired) < 1) {
    return;
  }

  emitDebug('host-context-recreate', `from=${current} to=${desired}`);
  await disposeAudioGraph(true);
}

async function resampleChannelsIfNeeded(
  channels: Float32Array[],
  sourceSampleRate: number,
  targetSampleRate: number
): Promise<{
  channels: Float32Array[];
  resampled: boolean;
  inputFrames: number;
  outputFrames: number;
  detail: string;
}> {
  if (!channels.length) {
    return {
      channels,
      resampled: false,
      inputFrames: 0,
      outputFrames: 0,
      detail: 'empty-channels'
    };
  }
  if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
    return {
      channels,
      resampled: false,
      inputFrames: channels[0]?.length || 0,
      outputFrames: channels[0]?.length || 0,
      detail: 'invalid-source-rate'
    };
  }
  if (!Number.isFinite(targetSampleRate) || targetSampleRate <= 0) {
    return {
      channels,
      resampled: false,
      inputFrames: channels[0]?.length || 0,
      outputFrames: channels[0]?.length || 0,
      detail: 'invalid-target-rate'
    };
  }
  if (Math.abs(sourceSampleRate - targetSampleRate) < 1) {
    const frames = channels[0]?.length || 0;
    return {
      channels,
      resampled: false,
      inputFrames: frames,
      outputFrames: frames,
      detail: `resample: skipped ${sourceSampleRate}→${targetSampleRate} frames=${frames}→${frames}`
    };
  }

  const inputFrames = channels[0]?.length || 0;
  if (!inputFrames) {
    return {
      channels,
      resampled: false,
      inputFrames: 0,
      outputFrames: 0,
      detail: 'empty-input-frames'
    };
  }

  const outputFrames = Math.max(1, Math.round((inputFrames * targetSampleRate) / sourceSampleRate));
  const resampleDetail = `resample: ${sourceSampleRate}→${targetSampleRate} frames=${inputFrames}→${outputFrames}`;
  emitDebug('host-resample', resampleDetail);

  const offline = new OfflineAudioContext(channels.length, outputFrames, targetSampleRate);
  const buffer = offline.createBuffer(channels.length, inputFrames, sourceSampleRate);
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    buffer.copyToChannel(new Float32Array(channels[channelIndex]), channelIndex);
  }

  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);

  const rendered = await offline.startRendering();
  const renderedChannels: Float32Array[] = [];
  for (let channelIndex = 0; channelIndex < rendered.numberOfChannels; channelIndex += 1) {
    renderedChannels.push(rendered.getChannelData(channelIndex).slice(0));
  }
  return {
    channels: renderedChannels,
    resampled: true,
    inputFrames,
    outputFrames,
    detail: resampleDetail
  };
}

async function ensureStretchNode(): Promise<SignalsmithStretchNode> {
  if (stretchNode) {
    return stretchNode;
  }
  // Share an in-flight factory call so concurrent callers (WAKE + LOAD_TRACK) don't
  // each try to create a separate node.
  if (stretchNodePromise) {
    return stretchNodePromise;
  }

  const ctx = ensureContext();
  await ctx.resume().catch(() => undefined);
  // Fail immediately if the context is still suspended — calling addModule() on a
  // suspended context hangs indefinitely in Firefox. The caller should retry once a
  // WAKE message (triggered by a user gesture) has successfully resumed the context.
  if (ctx.state !== 'running') {
    postToParent({ type: 'DEBUG', detail: `ensureStretchNode: context-suspended state=${ctx.state}` });
    throw new Error('context-suspended');
  }

  stretchNodePromise = (async (): Promise<SignalsmithStretchNode> => {
    // Set moduleUrl to a real moz-extension:// URL so addModule() uses a concrete URL
    // instead of a blob: URL.  Firefox extension pages hang indefinitely on
    // addModule(blobUrl) even when the CSP allows blob: — using a static file URL fixes this.
    // The worklet.js file is generated by tools/build/generate-signalsmith-worklet.js.
    const stretchFactory = SignalsmithStretch as typeof SignalsmithStretch & { moduleUrl?: string };
    stretchFactory.moduleUrl = new URL('./signalsmith/worklet.js', window.location.href).href;
    let node: SignalsmithStretchNode;
    postToParent({ type: 'DEBUG', detail: `stretchFactory: start ctx=${ctx.state}` });
    try {
      node = await Promise.race([
        stretchFactory(ctx, {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error('stretch-factory-timeout'));
          }, 30_000);
        })
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      postToParent({ type: 'DEBUG', detail: `stretchFactory: failed ctx=${ctx.state} err=${detail}` });
      stretchNodePromise = null;
      await disposeAudioGraph(true);
      throw err;
    }
    postToParent({ type: 'DEBUG', detail: 'stretchFactory: ok' });

    await node.configure({ preset: 'default' });
    try {
      const reportedLatency = await node.latency();
      stretchLatencySeconds = Number.isFinite(reportedLatency) ? Math.max(0, Number(reportedLatency)) : 0;
      emitDebug(
        'host-latency',
        `latency=${stretchLatencySeconds.toFixed(4)}s update=${TIME_UPDATE_INTERVAL_SECONDS.toFixed(3)}s`
      );
    } catch {
      stretchLatencySeconds = 0;
      emitDebug(
        'host-latency',
        `latency=unavailable update=${TIME_UPDATE_INTERVAL_SECONDS.toFixed(3)}s`
      );
    }
    await node.setUpdateInterval(TIME_UPDATE_INTERVAL_SECONDS, (inputTime) => {
      // Only advance currentTimeSec from the worklet when the node is actively playing.
      // When paused (e.g. between a SEEK_TO_TIME and the subsequent PLAY command), the
      // serial task queue owns currentTimeSec exclusively.  The worklet's inputTime lags
      // behind an explicit seek by up to one 50 ms tick, so allowing the timer to write
      // here while paused would race-reset the seeked position back to 0 before PLAY reads it.
      if (!paused && Number.isFinite(inputTime)) {
        const safeTime = Math.max(0, Number(inputTime));
        const monotonicTime = Math.max(liveTimeFloorSec, safeTime);
        currentTimeSec = durationSec > 0 ? Math.min(durationSec, monotonicTime) : monotonicTime;
        liveTimeFloorSec = currentTimeSec;
      }

      if (!paused && durationSec > 0 && currentTimeSec >= durationSec - END_TOLERANCE_SECONDS) {
        currentTimeSec = durationSec;
        paused = true;
        emitState();
        if (!endedNotified) {
          endedNotified = true;
          postToParent({ type: 'ENDED' });
        }
        return;
      }

      emitState();
    });

    // Detect worklet processor crashes (e.g. branch-1 crash with numberOfInputs=0)
    (node as unknown as EventTarget).addEventListener('processorerror', (e: Event) => {
      postToParent({ type: 'DEBUG', detail: `processorerror: ${(e as ErrorEvent).message ?? e}` });
    });

    handoffGateNode = ctx.createGain();
    handoffGateNode.gain.value = 1;
    gainNode = ctx.createGain();
    analyserNode = ctx.createAnalyser();
    analyserNode.fftSize = 2048;
    node.connect(handoffGateNode);
    handoffGateNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(ctx.destination);
    updateGain();

    // Prevent Firefox from auto-suspending the AudioContext while the worklet
    // is idle (active: false). A suspended context makes node.schedule() a
    // no-op and silences all output. 1e-6 gain (~-120 dB) is inaudible but
    // keeps the context processing graph active.
    if (!keepAliveSource) {
      const kaGain = ctx.createGain();
      kaGain.gain.value = 1e-6;
      keepAliveSource = ctx.createConstantSource();
      keepAliveSource.connect(kaGain);
      kaGain.connect(ctx.destination);
      keepAliveSource.start();
    }

    stretchNode = node;
    stretchNodePromise = null;
    hostGraphCreateCount += 1;
    return node;
  })();

  return stretchNodePromise;
}

function readNodeTime(): number {
  if (!stretchNode || !Number.isFinite(stretchNode.inputTime)) {
    return currentTimeSec;
  }
  const safeTime = Math.max(0, Number(stretchNode.inputTime));
  return durationSec > 0 ? Math.min(durationSec, safeTime) : safeTime;
}

// ---------------------------------------------------------------------------
// Serial task queue
// ---------------------------------------------------------------------------

function enqueue(task: () => Promise<void>): void {
  sequence = sequence.then(task).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Schedule helper (calls through to Signalsmith node)
// ---------------------------------------------------------------------------

// rateOnly=true: update rate/semitones without seeking; worklet extrapolates the current
// position from its timeMap. This avoids using a stale currentTimeSec and prevents the
// "future output" starvation: by omitting 'output', the worklet uses its own currentTime
// so the new timeMap entry is immediately active in process().
async function scheduleImpl(
  active: boolean,
  nextTimeSec: number,
  rateOnly = false,
  options: { handoffGate?: boolean } = {}
): Promise<{ handoffGateReleaseCtx?: number }> {
  if (!loadedUrl) {
    return {};
  }

  const ctx = ensureContext();
  if (active && ctx.state === 'suspended') {
    postToParent({ type: 'DEBUG', detail: `scheduleImpl: ctx suspended before resume, active=${active}` });
    await ctx.resume().catch(() => undefined);
    postToParent({ type: 'DEBUG', detail: `scheduleImpl: ctx state after resume=${ctx.state}` });
  }

  const node = await ensureStretchNode();
  const safeTime = durationSec > 0 ? clamp(nextTimeSec, 0, durationSec) : Math.max(0, nextTimeSec);
  const safeRate = clamp(playbackRate, 0.1, 4.0);
  const semitones = resolveSemitones(safeRate, keyLockEnabled);
  const isColdStart = paused && active && !rateOnly;
  const useHandoffGate = Boolean(options.handoffGate && isColdStart);
  const prerollInputSec = isColdStart ? Math.min(START_PREROLL_SECONDS, safeTime) : 0;
  const prerollOutputSec = prerollInputSec > 0 ? prerollInputSec / safeRate : 0;
  // A track start (safeTime≈0) cannot preroll input before t=0, so its time-stretch pipeline
  // gets less warmup than a mid-track cold start, which prerolls START_PREROLL_SECONDS before the
  // audible point. On slow machines that shortfall is the difference between cracking track
  // changes (preroll=0 → 120ms warmup) and clean mid-track starts (preroll=30ms → 150ms warmup),
  // because a just-built/cold worklet needs the longer lead before its first audible sample.
  // Hold the handoff gate longer by the missing preroll so a t=0 cold start gets the same total
  // worklet warmup before the audible fade-in.
  const gateHoldSec =
    HANDOFF_GATE_HOLD_SECONDS +
    (isColdStart ? Math.max(0, START_PREROLL_SECONDS - prerollInputSec) / safeRate : 0);
  const scheduleInputTime = prerollInputSec > 0 ? safeTime - prerollInputSec : safeTime;
  const scheduleOutputTime =
    isColdStart && stretchLatencySeconds > 0
      ? ctx.currentTime + stretchLatencySeconds
      : undefined;
  const scheduledAudibleOutputCtx =
    typeof scheduleOutputTime === 'number'
      ? scheduleOutputTime + prerollOutputSec
      : ctx.currentTime + prerollOutputSec;
  const handoffGateReleaseCtx = useHandoffGate
    ? scheduledAudibleOutputCtx + gateHoldSec
    : undefined;

  if (active && !rateOnly) {
    clearFirstWindowProbe();
  }

  if (isColdStart && gainNode && ctx.state === 'running') {
    const targetGain = resolveOutputGain();
    const g = gainNode;
    const fadeStartCtx = Math.max(ctx.currentTime, scheduledAudibleOutputCtx - MICRO_FADE_SECONDS);
    const fadeEndCtx = Math.max(fadeStartCtx + MICRO_FADE_SECONDS, scheduledAudibleOutputCtx);
    startupFadeStartCtx = fadeStartCtx;
    startupFadeEndCtx = fadeEndCtx;
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.setValueAtTime(0, fadeStartCtx);
    g.gain.linearRampToValueAtTime(targetGain, fadeEndCtx);
  } else if (!active) {
    startupFadeStartCtx = 0;
    startupFadeEndCtx = 0;
  }

  if (useHandoffGate && typeof handoffGateReleaseCtx === 'number') {
    scheduleHandoffGate(handoffGateReleaseCtx);
    emitDebug(
      'host-handoff-gate',
      `releaseMs=${Math.round(gateHoldSec * 1000)} fadeMs=${Math.round(HANDOFF_GATE_FADE_SECONDS * 1000)} releaseCtx=${handoffGateReleaseCtx.toFixed(3)}`
    );
  } else if (!isColdStart || !active) {
    openHandoffGate();
  }

  // Rate-only changes intentionally omit outputTime so the worklet applies them
  // against its own clock without creating a future-gap. For a cold start from
  // paused -> playing, schedule against the node's reported latency so the first
  // audible sample lands on the requested input time instead of jumping ahead by
  // the worklet's internal latency.
  const scheduleParams: Record<string, unknown> = { active, rate: safeRate, semitones };
  if (!rateOnly) {
    scheduleParams.input = scheduleInputTime;
  }
  if (typeof scheduleOutputTime === 'number') {
    scheduleParams.outputTime = scheduleOutputTime;
  }

  await node.schedule(scheduleParams, false);

  paused = !active;
  if (active && !rateOnly) {
    emitDebug(
      'host-play-scheduled',
      `input=${safeTime.toFixed(2)} startInput=${scheduleInputTime.toFixed(2)} rate=${safeRate.toFixed(4)} outputCtx=${scheduledAudibleOutputCtx.toFixed(3)} preroll=${prerollInputSec.toFixed(3)} fade=${(isColdStart ? MICRO_FADE_SECONDS : 0).toFixed(3)} gate=${useHandoffGate ? `${Math.round(gateHoldSec * 1000)}ms/${Math.round(HANDOFF_GATE_FADE_SECONDS * 1000)}ms` : '-'} latency=${stretchLatencySeconds.toFixed(4)} userVolume=${(muted ? 0 : volume).toFixed(3)} outputGain=${resolveOutputGain().toFixed(3)}`
    );
    armFirstWindowProbe(handoffGateReleaseCtx ?? scheduledAudibleOutputCtx, safeTime, safeRate);
  } else if (!active) {
    clearFirstWindowProbe();
  }
  if (rateOnly) {
    // Tempo-only updates must not move playback backward. On Chrome, the worklet can
    // briefly report an older inputTime while a new tempo map is being applied, which
    // makes the runtime-owned playhead appear to jump or makes later tempo clicks feel
    // like they were ignored. Keep the last known live position as the floor unless an
    // explicit seek/load path chooses a new position.
    const stabilizedTime = Math.max(liveTimeFloorSec, currentTimeSec, readNodeTime());
    currentTimeSec = durationSec > 0 ? Math.min(durationSec, stabilizedTime) : stabilizedTime;
  } else {
    currentTimeSec = safeTime;
  }
  liveTimeFloorSec = currentTimeSec;
  if (active) {
    endedNotified = false;
  }
  emitState();
  return { handoffGateReleaseCtx };
}

// ---------------------------------------------------------------------------
// Probe — runs in an isolated context to avoid polluting player state
// ---------------------------------------------------------------------------

async function handleProbe(ackId: number): Promise<void> {
  let ctx: AudioContext | null = null;
  let node: SignalsmithStretchNode | null = null;
  try {
    ctx = new AudioContext();
    // Resume before addModule — Firefox requires a running context for AudioWorklet init.
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
    // Keep the probe path aligned with the real playback path. Without an explicit moduleUrl,
    // SignalsmithStretch falls back to generating a blob-backed worklet module at runtime.
    // That fallback can trip CSP in Chrome, even though playback itself now uses the static
    // packaged worklet asset.
    const stretchFactory = SignalsmithStretch as typeof SignalsmithStretch & { moduleUrl?: string };
    stretchFactory.moduleUrl = new URL('./signalsmith/worklet.js', window.location.href).href;
    node = await stretchFactory(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    await node.configure({ preset: 'default' });
    postToParent({ type: 'ACK', ackId, supported: true, reason: 'ok', detail: 'worklet-configure-ok' });
  } catch (error) {
    postToParent({
      type: 'ACK',
      ackId,
      supported: false,
      reason: 'probe-failed',
      detail: formatErrorDetail(error)
    });
  } finally {
    if (node) {
      try {
        node.disconnect();
      } catch {
        // ignore
      }
    }
    if (ctx && ctx.state !== 'closed') {
      await ctx.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleMessage(event: MessageEvent): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = event.data as any;
  if (!msg || typeof msg.type !== 'string') {
    return;
  }

  // Opportunistically resume the AudioContext on every incoming message.
  // Firefox propagates user-gesture activation through postMessage, so messages
  // triggered by user interactions (e.g. SET_TEMPO, PLAY) arrive in a gesture
  // context that allows ctx.resume() to succeed where a plain timeout would not.
  if (context && context.state === 'suspended') {
    void context.resume().catch(() => undefined);
  }

  switch (msg.type as string) {
    case 'WAKE': {
      // Sent by the content script during a user gesture (e.g. play click, tempo slider).
      // Only resume an already-created context here. Creating or pre-warming the host before
      // the first prepared track forces a later 48kHz -> native-rate rebuild in the middle of
      // live page playback, which is exactly the crack we're trying to avoid.
      if (context) {
        void context.resume().catch(() => undefined);
      }
      break;
    }

    case 'PROBE': {
      void handleProbe(msg.ackId as number);
      break;
    }

    case 'LOAD_TRACK': {
      const { ackId, url, channels, sampleRate, numberOfFrames } = msg as {
        ackId: number;
        url: string;
        channels: Float32Array[];
        sampleRate: number;
        numberOfFrames: number;
        freshGraph?: boolean;
        chunkedFeed?: boolean;
      };
      const chunkedFeed = msg.chunkedFeed === true;
      enqueue(async () => {
        let ackError: string | undefined;
        const totalStart = performance.now();
        let graphRecreate = false;
        // Stall detector: a GC pause during a load step lands as an outsized gap
        // between checkpoints. Track the largest per-phase gap so the slow-machine
        // memory theory is measurable instead of inferred.
        let lastCheckpoint = totalStart;
        let maxGapMs = 0;
        let maxGapPhase = '-';
        const checkpoint = (phase: string): void => {
          const now = performance.now();
          const gap = now - lastCheckpoint;
          if (gap > maxGapMs) {
            maxGapMs = gap;
            maxGapPhase = phase;
          }
          lastCheckpoint = now;
        };
        try {
          if (loadedUrl && !paused) {
            await fadeOutForInactiveTransition('load');
          }
          checkpoint('fade');
          if (msg.freshGraph === true) {
            emitDebug('host-graph-recreate', 'reason=fresh-load');
            await disposeAudioGraph(false);
            graphRecreate = true;
          }
          checkpoint('dispose');
          let clearMs = 0;
          if (loadedUrl && stretchNode) {
            const clearStart = performance.now();
            await stretchNode.schedule({ active: false }, false);
            await stretchNode.clearBuffers();
            clearMs = Math.round(performance.now() - clearStart);
            hostReplacementCount += 1;
            hostReleasedPcmBytes += hostActivePcmBytes;
            hostActivePcmBytes = 0;
          }
          checkpoint('clear');
          const sourceSampleRate = Number.isFinite(sampleRate) && sampleRate > 0
            ? Number(sampleRate)
            : 0;
          await ensureContextSampleRate(sourceSampleRate);
          const hostSampleRate = ensureContext().sampleRate;
          emitContextStats('load-track', ensureContext());
          const resampleStart = performance.now();
          const prepared = await resampleChannelsIfNeeded(
            channels,
            sourceSampleRate,
            hostSampleRate
          );
          const resampleMs = Math.round(performance.now() - resampleStart);
          checkpoint('resample');
          const preparedChannels = prepared.channels;
          const preparedFrames = preparedChannels[0]?.length || numberOfFrames;
          const preparedPcmBytes = preparedChannels.reduce(
            (total, channel) => total + channel.byteLength,
            0
          );
          const node = await ensureStretchNode();
          await node.schedule({ active: false }, false);
          checkpoint('ensure-node');
          if (!loadedUrl) {
            const clearStart = performance.now();
            // First load still starts from explicitly empty SignalSmith state.
            await node.clearBuffers();
            clearMs = Math.round(performance.now() - clearStart);
          }
          const addStart = performance.now();
          // The iframe does not reuse these arrays after loading. Transfer them into
          // the worklet so Firefox does not clone an entire decoded track at switch time.
          let addChunks = 1;
          let maxChunkAddMs = 0;
          if (chunkedFeed && preparedFrames > 0 && preparedChannels.length > 0) {
            // Feed the track as small slices with a yield between each so no single transfer
            // stalls the shared audio thread longer than the output ring can absorb. Each slice
            // is copied (slice()) off the originals on THIS (iframe) thread — not the audio
            // thread — then transferred. The worklet appends them as a multi-chunk timeline
            // (safe via the feeding-loop fix). Total transfer time is unchanged; it is spread out.
            const bytesPerFrame = preparedChannels.length * Float32Array.BYTES_PER_ELEMENT;
            const chunkFrames = Math.max(1, Math.floor(FEED_CHUNK_BYTES / Math.max(1, bytesPerFrame)));
            addChunks = 0;
            for (let start = 0; start < preparedFrames; start += chunkFrames) {
              const end = Math.min(preparedFrames, start + chunkFrames);
              const sliceChannels = preparedChannels.map((channel) => channel.slice(start, end));
              const chunkStart = performance.now();
              await node.addBuffers(
                sliceChannels,
                sliceChannels.map((channel) => channel.buffer)
              );
              maxChunkAddMs = Math.max(maxChunkAddMs, performance.now() - chunkStart);
              addChunks += 1;
              if (end < preparedFrames) {
                await new Promise((resolve) => window.setTimeout(resolve, FEED_CHUNK_YIELD_MS));
              }
            }
          } else {
            await node.addBuffers(
              preparedChannels,
              preparedChannels.map((channel) => channel.buffer)
            );
            maxChunkAddMs = performance.now() - addStart;
          }
          const addMs = Math.round(performance.now() - addStart);
          maxChunkAddMs = Math.round(maxChunkAddMs);
          checkpoint('add');
          // O1 instrumentation: addMs brackets exactly the addBuffers main↔worklet round-trip.
          // The worklet-side addBuffers is O(1) (it just pushes the channel arrays), so a roughly
          // CONSTANT addMsPerMB across different-sized tracks means the cost is the per-byte PCM
          // transfer — which incremental/chunked feeding can spread across render quanta. A roughly
          // constant addMs regardless of size would mean fixed per-call overhead (chunking wouldn't
          // help). See runtime-audio.md §4.4 (Firefox chunked/incremental worklet feed).
          const addMB = preparedPcmBytes / (1024 * 1024);
          hostTrackLoadCount += 1;
          hostActivePcmBytes = preparedPcmBytes;
          hostSubmittedPcmBytes += preparedPcmBytes;
          loadedUrl = String(url || '').trim();
          durationSec =
            hostSampleRate > 0 && preparedFrames > 0
              ? preparedFrames / hostSampleRate
              : sourceSampleRate > 0
                ? numberOfFrames / sourceSampleRate
                : 0;
          currentTimeSec = 0;
          liveTimeFloorSec = 0;
          paused = true;
          endedNotified = false;
          emitDebug(
            'host-load',
            `srcRate=${sourceSampleRate || '-'} hostRate=${hostSampleRate.toFixed(0)} resampled=${prepared.resampled ? '1' : '0'} frames=${prepared.inputFrames}->${prepared.outputFrames}`
          );
          emitDebug(
            'host-load-timing',
            `resampleMs=${resampleMs} graphRecreate=${graphRecreate ? '1' : '0'} clearMs=${clearMs} clearTransfer=0 dspReset=1 addMs=${addMs} addMB=${addMB.toFixed(1)} addMsPerMB=${addMB > 0 ? (addMs / addMB).toFixed(2) : '-'} chunks=${addChunks} maxChunkAddMs=${maxChunkAddMs} addTransfer=1 totalMs=${Math.round(performance.now() - totalStart)}`
          );
          // In chunked mode the 'add' phase intentionally spans many slices + yields, so the
          // checkpoint gap is total wall-time, not an audio-thread stall. Report the largest
          // single-chunk transfer instead (the real per-quantum stall proxy), so the stall
          // warning reflects what can actually starve the render.
          emitDebug(
            'host-load-stall',
            chunkedFeed
              ? `maxGapMs=${maxChunkAddMs} phase=chunk`
              : `maxGapMs=${Math.round(maxGapMs)} phase=${maxGapPhase}`
          );
          emitHostInputChurn();
          await scheduleImpl(false, 0);
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          postToParent({ type: 'ACK', ackId, ...(ackError !== undefined ? { error: ackError } : {}) });
        }
      });
      break;
    }

    case 'SET_TEMPO': {
      const { playbackRate: nextRate, keyLockEnabled: nextKeyLock } = msg as {
        playbackRate: number;
        keyLockEnabled: boolean;
      };
      playbackRate = Number.isFinite(nextRate) ? clamp(nextRate, 0.1, 4.0) : 1;
      keyLockEnabled = Boolean(nextKeyLock);
      const v = ++setTempoVersion;
      if (loadedUrl) {
        enqueue(async () => {
          if (setTempoVersion !== v) {
            return;
          }
          await scheduleImpl(!paused, currentTimeSec, true);  // rateOnly: don't seek
        });
      } else {
        emitState();
      }
      break;
    }

    case 'SEEK_TO_TIME': {
      if (!loadedUrl) {
        break;
      }
      const positionSec = Number.isFinite(msg.positionSec) ? Number(msg.positionSec) : 0;
      enqueue(async () => {
        await scheduleImpl(!paused, positionSec);
        emitContextStats('seek-to-time', ensureContext());
      });
      break;
    }

    case 'SEEK_TO_FRACTION': {
      if (!loadedUrl || durationSec <= 0) {
        break;
      }
      const fraction = Number.isFinite(msg.fraction) ? clamp(Number(msg.fraction), 0, 1) : 0;
      enqueue(async () => {
        await scheduleImpl(!paused, durationSec * fraction);
        emitContextStats('seek-to-fraction', ensureContext());
      });
      break;
    }

    case 'PLAY': {
      const { ackId } = msg as { ackId: number };
      if (!loadedUrl) {
        postToParent({ type: 'ACK', ackId });
        break;
      }
      enqueue(async () => {
        let ackError: string | undefined;
        try {
          await scheduleImpl(true, currentTimeSec);
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          postToParent({ type: 'ACK', ackId, ...(ackError !== undefined ? { error: ackError } : {}) });
        }
      });
      break;
    }

    case 'PLAY_FROM_TIME': {
      const {
        ackId,
        positionSec,
        playbackRate: nextRate,
        keyLockEnabled: nextKeyLock,
        volume: nextVolume,
        muted: nextMuted
      } = msg as {
        ackId: number;
        positionSec: number;
        playbackRate: number;
        keyLockEnabled: boolean;
        volume?: number;
        muted?: boolean;
        handoffGate?: boolean;
      };
      if (!loadedUrl) {
        postToParent({ type: 'ACK', ackId });
        break;
      }
      enqueue(async () => {
        let ackError: string | undefined;
        const scheduleStart = performance.now();
        try {
          playbackRate = Number.isFinite(nextRate) ? clamp(nextRate, 0.1, 4.0) : 1;
          keyLockEnabled = Boolean(nextKeyLock);
          if (Number.isFinite(nextVolume)) {
            volume = clamp(Number(nextVolume), 0, 1);
          }
          if (typeof nextMuted === 'boolean') {
            muted = nextMuted;
          }
          setTempoVersion += 1;
          const safeTime = Number.isFinite(positionSec) ? Number(positionSec) : 0;
          const { handoffGateReleaseCtx } = await scheduleImpl(true, safeTime, false, {
            handoffGate: msg.handoffGate !== false
          });
          emitContextStats('play-from-time', ensureContext());
          emitDebug(
            'host-schedule-timing',
            `ackWaitMs=${Math.round(performance.now() - scheduleStart)} handoffGate=${typeof handoffGateReleaseCtx === 'number' ? '1' : '0'}`
          );
          if (typeof handoffGateReleaseCtx === 'number' && context) {
            await waitUntilContextTime(context, handoffGateReleaseCtx);
          }
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          postToParent({ type: 'ACK', ackId, ...(ackError !== undefined ? { error: ackError } : {}) });
        }
      });
      break;
    }

    case 'PAUSE': {
      const { ackId } = msg as { ackId?: number };
      if (!loadedUrl) {
        if (typeof ackId === 'number') {
          postToParent({ type: 'ACK', ackId });
        }
        break;
      }
      enqueue(async () => {
        let ackError: string | undefined;
        try {
          const pauseTime = readNodeTime();
          await fadeOutForInactiveTransition('pause');
          await scheduleImpl(false, pauseTime);
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          if (typeof ackId === 'number') {
            postToParent({ type: 'ACK', ackId, ...(ackError !== undefined ? { error: ackError } : {}) });
          }
        }
      });
      break;
    }

    case 'STOP': {
      const { ackId, drainOutputBeforeClear } = msg as {
        ackId?: number;
        drainOutputBeforeClear?: boolean;
      };
      if (!loadedUrl) {
        if (typeof ackId === 'number') {
          postToParent({ type: 'ACK', ackId });
        }
        break;
      }
      enqueue(async () => {
        let ackError: string | undefined;
        const stopStart = performance.now();
        try {
          await fadeOutForInactiveTransition('stop');
          if (drainOutputBeforeClear === true && context && context.state === 'running') {
            const extended = context as AudioContext & { outputLatency?: number };
            const reportedLatencySec = Number(extended.outputLatency);
            const outputLatencySec = Number.isFinite(reportedLatencySec) && reportedLatencySec >= 0
              ? reportedLatencySec
              : 0;
            const holdSeconds = outputLatencySec + OUTPUT_DRAIN_SAFETY_SECONDS;
            const drainStartCtx = context.currentTime;
            const drainTargetCtx = drainStartCtx + holdSeconds;
            await waitUntilContextTime(context, drainTargetCtx);
            // Closed-loop guard: waitUntilContextTime is a wall-clock setTimeout, so on
            // a throttled/suspending tab it can resolve before the audio clock actually
            // advanced by holdSeconds. Re-arm once so the silence is really rendered.
            let rearmed = 0;
            if (context.state === 'running' && context.currentTime < drainTargetCtx) {
              rearmed = 1;
              await waitUntilContextTime(context, drainTargetCtx);
            }
            emitDebug(
              'host-output-drain',
              `outputLatencyMs=${Number.isFinite(reportedLatencySec) ? Math.round(outputLatencySec * 1000) : '-'} marginMs=${Math.round(OUTPUT_DRAIN_SAFETY_SECONDS * 1000)} holdMs=${Math.round(holdSeconds * 1000)} rearm=${rearmed}`
            );
          }
          await scheduleImpl(false, 0);
          const clearStart = performance.now();
          if (stretchNode) {
            await stretchNode.clearBuffers();
          }
          const clearMs = Math.round(performance.now() - clearStart);
          hostReleasedPcmBytes += hostActivePcmBytes;
          hostActivePcmBytes = 0;
          loadedUrl = '';
          durationSec = 0;
          currentTimeSec = 0;
          liveTimeFloorSec = 0;
          paused = true;
          endedNotified = false;
          emitDebug(
            'host-stop-timing',
            `clearMs=${clearMs} clearTransfer=0 dspReset=1 totalMs=${Math.round(performance.now() - stopStart)}`
          );
          emitHostInputChurn();
          emitState();
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          if (typeof ackId === 'number') {
            postToParent({ type: 'ACK', ackId, ...(ackError !== undefined ? { error: ackError } : {}) });
          }
        }
      });
      break;
    }

    case 'SET_VOLUME': {
      volume = Number.isFinite(msg.volume) ? clamp(Number(msg.volume), 0, 1) : 1;
      if (volume > 0 && muted) {
        muted = false;
      }
      updateGain();
      emitState();
      break;
    }

    case 'SET_MUTED': {
      muted = Boolean(msg.muted);
      updateGain();
      emitState();
      break;
    }

    case 'SET_PERF_SAMPLING': {
      if (msg.enabled) {
        resourceSampler.start();
      } else {
        resourceSampler.stop();
      }
      break;
    }

    case 'GET_PERF_SNAPSHOT': {
      const { ackId } = msg as { ackId?: number };
      if (typeof ackId === 'number') {
        postToParent({
          type: 'ACK',
          ackId,
          perf: resourceSampler.snapshot(),
          underruns: lastUnderrunCount
        });
      }
      break;
    }

    case 'DESTROY': {
      const { ackId } = msg as { ackId?: number };
      enqueue(async () => {
        const destroyStart = performance.now();
        let ackError: string | undefined;
        let contextClosed = false;
        try {
          contextClosed = await disposeAudioGraph(true);
          if (!contextClosed) {
            ackError = 'audio-context-close-incomplete';
          }
          loadedUrl = '';
          stretchLatencySeconds = 0;
          requestedContextSampleRate = 0;
          emitDebug(
            'host-destroy-timing',
            `closeMs=${Math.round(performance.now() - destroyStart)} contextClosed=${contextClosed ? '1' : '0'}`
          );
        } catch (err) {
          ackError = formatErrorDetail(err);
        } finally {
          if (typeof ackId === 'number') {
            postToParent({
              type: 'ACK',
              ackId,
              contextClosed,
              ...(ackError !== undefined ? { error: ackError } : {})
            });
          }
        }
      });
      break;
    }

    default:
      break;
  }
}

window.addEventListener('message', handleMessage);

// Signal that the iframe is alive and ready to receive commands
function init(): void {
  // Keep startup lazy: the first LOAD_TRACK chooses the host sample rate, so creating an
  // AudioContext here would lock us to the browser default and force a live rebuild later.
  window.parent.postMessage({ type: 'HOST_READY' }, '*');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
