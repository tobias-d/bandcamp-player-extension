// Content-side resource-diagnostics controller.
//
// Owns one stable sessionId per panel instance and samples the content context locally while
// the debug panel is open. On open it registers the session with the background and starts a
// 1s pull of the backend snapshot; on close it stops everything and deregisters. The panel's
// debug-body reads getDebugState() synchronously (the returned object is mutated in place), so
// async backend data is always cached before a render needs it.
//
// Sampling is strictly gated on the panel being open — nothing runs during normal playback,
// which matters because Firefox shares one audio thread across AudioContexts.

import type { ContextResourceSample } from '@/shared/resource-sampler';
import { createResourceSampler } from '@/shared/resource-sampler';
import type { ResourceDiagnosticsResponse } from '@/shared/types';
import type { RuntimeHostPerfReport } from '@/content/player/runtime-audio/types';
import { sendMessage } from '@/utils/messaging';

const PULL_INTERVAL_MS = 1000;

export interface ResourceDiagnosticsDebugState {
  open: boolean;
  content: ContextResourceSample | null;
  backend: ResourceDiagnosticsResponse | null;
  hosts: RuntimeHostPerfReport[] | null;
  lastPullAt: number;
  lastPullError: string;
}

// Hooks into the runtime audio host iframes (Checkpoint C). Optional so the controller works
// before the runtime audio controller exists (it is created later in the page lifecycle).
export interface ResourceDiagnosticsHostHooks {
  setHostPerfSampling?: (enabled: boolean) => void;
  collectHostPerfSnapshots?: () => Promise<RuntimeHostPerfReport[]>;
}

export interface ResourceDiagnosticsController {
  setPanelOpen(open: boolean): void;
  getDebugState(): ResourceDiagnosticsDebugState;
  destroy(): void;
}

export function createResourceDiagnosticsController(
  hostHooks: ResourceDiagnosticsHostHooks = {}
): ResourceDiagnosticsController {
  const sessionId = crypto.randomUUID();
  const sampler = createResourceSampler();
  let open = false;
  // Bumped on every open/close so a pull that resolves after the panel closed (or reopened) is
  // dropped instead of writing stale data.
  let generation = 0;
  let pullInFlight = false;
  let pullTimer: ReturnType<typeof setInterval> | null = null;

  const state: ResourceDiagnosticsDebugState = {
    open: false,
    content: null,
    backend: null,
    hosts: null,
    lastPullAt: 0,
    lastPullError: ''
  };

  const sendOpen = (): void => {
    void sendMessage({ type: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION', sessionId }).catch(() => undefined);
  };
  const sendClose = (): void => {
    void sendMessage({ type: 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION', sessionId }).catch(() => undefined);
  };

  const pull = async (): Promise<void> => {
    if (!open || pullInFlight) {
      return;
    }
    pullInFlight = true;
    const gen = generation;
    try {
      const [response, hosts] = await Promise.all([
        sendMessage<ResourceDiagnosticsResponse>({ type: 'GET_RESOURCE_DIAGNOSTICS', sessionId }),
        hostHooks.collectHostPerfSnapshots?.() ?? Promise.resolve(null)
      ]);
      if (gen !== generation || !open) {
        return;
      }
      state.backend = response;
      state.hosts = hosts;
      state.lastPullAt = Date.now();
      state.lastPullError = '';
      // Single reconciliation rule: the backend forgot our session (e.g. MV3 SW suspended and
      // restarted), so re-open it. No retry loop — the next pull confirms.
      if (!response.sessionActive) {
        sendOpen();
      }
    } catch (error) {
      if (gen !== generation || !open) {
        return;
      }
      state.lastPullError = error instanceof Error ? error.message : String(error);
    } finally {
      pullInFlight = false;
      if (open && gen === generation) {
        state.content = sampler.snapshot();
      }
    }
  };

  const setPanelOpen = (next: boolean): void => {
    if (next === open) {
      return;
    }
    open = next;
    generation += 1;
    state.open = next;
    if (next) {
      sampler.start();
      sendOpen();
      hostHooks.setHostPerfSampling?.(true);
      state.content = sampler.snapshot();
      pullTimer = setInterval(() => {
        void pull();
      }, PULL_INTERVAL_MS);
      void pull();
    } else {
      if (pullTimer !== null) {
        clearInterval(pullTimer);
        pullTimer = null;
      }
      sampler.stop();
      sendClose();
      hostHooks.setHostPerfSampling?.(false);
      state.content = null;
      state.backend = null;
      state.hosts = null;
      state.lastPullError = '';
    }
  };

  // Navigation/tab close fires pagehide even when the panel never received an explicit close,
  // so the backend session is always deregistered (backstopped by its own stale-prune).
  const onPageHide = (): void => {
    if (open) {
      sendClose();
    }
  };
  window.addEventListener('pagehide', onPageHide);

  return {
    setPanelOpen,
    getDebugState() {
      return state;
    },
    destroy() {
      window.removeEventListener('pagehide', onPageHide);
      setPanelOpen(false);
    }
  };
}
