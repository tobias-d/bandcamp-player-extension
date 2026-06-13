import SignalsmithStretch, { type SignalsmithStretchNode } from 'signalsmith-stretch';
import type { RuntimeStretchCapability } from '@/content/player/runtime-audio/types';
import { extensionAssetUrl } from '@/utils/asset-url';

const SIGNALSMITH_WORKLET_URL = extensionAssetUrl('public/signalsmith/SignalsmithStretch.mjs');
const PROBE_SCHEDULE_LEAD_SECONDS = 0.05;
const PROBE_DURATION_SECONDS = 0.12;
const PROBE_TIMEOUT_MS = 3000;
const SIGNALSMITH_NODE_KEY = 'signalsmith-stretch';

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function createAudioContext(): AudioContext {
  const ContextCtor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!ContextCtor) {
    throw new Error('AudioContext unavailable');
  }
  return new ContextCtor();
}

function copyChannels(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel).slice(0));
  }
  return channels;
}

function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function createTimeoutError(stage: string): Error {
  return new Error(`${stage}-timeout-${PROBE_TIMEOUT_MS}ms`);
}

async function withTimeout<T>(stage: string, task: Promise<T>): Promise<T> {
  let timeoutId = 0;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(createTimeoutError(stage));
    }, PROBE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadWorkletModule(ctx: AudioContext): Promise<void> {
  const stretchFactory = SignalsmithStretch as typeof SignalsmithStretch & { moduleUrl?: string };
  stretchFactory.moduleUrl = SIGNALSMITH_WORKLET_URL;
  await withTimeout('module-load', ctx.audioWorklet.addModule(stretchFactory.moduleUrl || SIGNALSMITH_WORKLET_URL));
}

async function waitForReady(
  node: AudioWorkletNode
): Promise<Record<string, number>> {
  return withTimeout(
    'ready',
    new Promise<Record<string, number>>((resolve, reject) => {
      node.port.onmessage = (event: MessageEvent) => {
        const data = Array.isArray(event.data) ? event.data : [];
        if (data[0] === 'ready' && data[1] && typeof data[1] === 'object') {
          resolve(data[1] as Record<string, number>);
          return;
        }
      };
      node.onprocessorerror = (event) => {
        reject(new Error(`processor-error:${String(event.type || 'unknown')}`));
      };
    })
  );
}

function decorateNode(
  node: AudioWorkletNode,
  remoteMethodKeys: Record<string, number>
): SignalsmithStretchNode {
  const typedNode = node as SignalsmithStretchNode;
  let idCounter = 0;
  const requestMap = new Map<number, (value: unknown) => void>();
  let timeUpdateCallback: ((inputTime: number) => void) | null = null;

  typedNode.inputTime = 0;
  node.port.onmessage = (event: MessageEvent) => {
    const data = Array.isArray(event.data) ? event.data : [];
    const id = data[0];
    const value = data[1];
    if (id === 'time') {
      typedNode.inputTime = Number.isFinite(value) ? Number(value) : typedNode.inputTime;
      timeUpdateCallback?.(typedNode.inputTime);
      return;
    }
    if (typeof id === 'number' && requestMap.has(id)) {
      const resolve = requestMap.get(id);
      requestMap.delete(id);
      resolve?.(value);
    }
  };

  const post = (transfer: Transferable[] | null, method: string, ...args: unknown[]): Promise<unknown> => {
    const id = idCounter++;
    return new Promise((resolve) => {
      requestMap.set(id, resolve);
      node.port.postMessage([id, method, ...args], transfer || []);
    });
  };

  for (const [key, argCount] of Object.entries(remoteMethodKeys)) {
    (typedNode as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[key] = (...args: unknown[]) => {
      let transfer: Transferable[] | null = null;
      if (args.length > argCount) {
        const candidate = args.pop();
        transfer = Array.isArray(candidate) ? (candidate as Transferable[]) : null;
      }
      return post(transfer, key, ...args);
    };
  }

  typedNode.setUpdateInterval = (seconds: number, callback?: (inputTime: number) => void): Promise<unknown> => {
    timeUpdateCallback = callback || null;
    return post(null, 'setUpdateInterval', seconds);
  };

  return typedNode;
}

async function createProbeNode(ctx: AudioContext): Promise<SignalsmithStretchNode> {
  await loadWorkletModule(ctx);
  const rawNode = new AudioWorkletNode(ctx, SIGNALSMITH_NODE_KEY, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  const remoteMethodKeys = await waitForReady(rawNode);
  const node = decorateNode(rawNode, remoteMethodKeys);
  await withTimeout('configure', node.configure({ preset: 'default' }));
  return node;
}

export async function probeSignalsmithRuntime(): Promise<RuntimeStretchCapability> {
  let context: AudioContext | null = null;
  let stretchNode: SignalsmithStretchNode | null = null;

  try {
    context = createAudioContext();
    stretchNode = await createProbeNode(context);

    const frameCount = Math.max(128, Math.round(context.sampleRate * PROBE_DURATION_SECONDS));
    const probeBuffer = context.createBuffer(2, frameCount, context.sampleRate);

    await withTimeout(
      'schedule-stop-initial',
      stretchNode.schedule({ output: context.currentTime + PROBE_SCHEDULE_LEAD_SECONDS, active: false }, true)
    );
    await withTimeout('drop-buffers', stretchNode.dropBuffers());
    await withTimeout('add-buffers', stretchNode.addBuffers(copyChannels(probeBuffer)));
    await withTimeout(
      'schedule-start',
      stretchNode.schedule(
        {
          output: context.currentTime + PROBE_SCHEDULE_LEAD_SECONDS,
          active: true,
          input: 0,
          rate: 1.05,
          semitones: 0
        },
        true
      )
    );
    await withTimeout(
      'schedule-stop-final',
      stretchNode.schedule({ output: context.currentTime + PROBE_SCHEDULE_LEAD_SECONDS * 2, active: false }, true)
    );

    return {
      supported: true,
      reason: 'ok',
      detail: 'worklet-create-configure-schedule',
      checkedAt: Date.now()
    };
  } catch (error) {
    return {
      supported: false,
      reason: 'probe-failed',
      detail: formatErrorDetail(error),
      checkedAt: Date.now()
    };
  } finally {
    if (stretchNode) {
      try {
        stretchNode.disconnect();
      } catch {
        // Ignore disconnect failures from partially-initialized nodes.
      }
    }
    if (context && context.state !== 'closed') {
      await context.close().catch(() => undefined);
    }
  }
}
