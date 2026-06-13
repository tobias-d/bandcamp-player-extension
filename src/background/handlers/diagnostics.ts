// Resource-diagnostics handlers (background page / MV3 service worker).
//
// Sampling is session-gated: each open debug panel registers a sessionId via OPEN, refreshes
// it on every 1s GET, and removes it via CLOSE. The background samples only while at least one
// session is active, so there is zero idle overhead once every panel is closed. A session
// whose CLOSE never arrives (hard tab/process kill) is pruned after it goes stale, so sampling
// still stops. Keying on sessionId (rather than a single boolean) means one tab closing its
// panel can never deregister another tab's still-open session.
//
// On Firefox the worker pool lives here, so this reports real worker samples. On Chrome the
// MV3 service worker owns no workers (the pool's slots are empty) — getStatus/collectPerfReports
// return zeros/[] and the real worker picture comes from the offscreen host (Checkpoint B).

import type {
  ContentMessage,
  HostResourceDiagnostics,
  ResourceDiagnosticsResponse
} from '@/shared/types';
import { createResourceSampler } from '@/shared/resource-sampler';
import { getWorkerPool } from '@/background/audio/worker-pool';
import { getAnalysisCacheStats } from '@/background/cache';
import { getEssentiaRuntimeSync } from '@/background/audio/essentia-runtime';

type OpenSessionMessage = Extract<ContentMessage, { type: 'OPEN_RESOURCE_DIAGNOSTICS_SESSION' }>;
type CloseSessionMessage = Extract<ContentMessage, { type: 'CLOSE_RESOURCE_DIAGNOSTICS_SESSION' }>;
type GetDiagnosticsMessage = Extract<ContentMessage, { type: 'GET_RESOURCE_DIAGNOSTICS' }>;

// ~5 missed 1s pulls. Long enough to survive transient delays, short enough that a leaked
// session stops sampling promptly.
const SESSION_STALE_MS = 5_000;

const sampler = createResourceSampler();
const activeSessions = new Map<string, number>();

function pruneStaleSessions(): void {
  const now = Date.now();
  for (const [sessionId, lastSeenAt] of activeSessions) {
    if (now - lastSeenAt > SESSION_STALE_MS) {
      activeSessions.delete(sessionId);
    }
  }
}

// Start or stop sampling to match whether any session is active. Idempotent: only acts on a
// real transition so repeated GETs don't restart the sampler.
function applySamplingState(): void {
  const shouldSample = activeSessions.size > 0;
  if (shouldSample === sampler.isRunning()) {
    return;
  }
  if (shouldSample) {
    sampler.start();
    getWorkerPool().setPerfSampling(true);
  } else {
    sampler.stop();
    getWorkerPool().setPerfSampling(false);
  }
}

// Essentia's main-thread runtime (used by the background analysis paths) exposes its WASM
// linear memory as HEAPU8. Feature-detected; null when the runtime hasn't initialized.
function readEssentiaHeapBytes(): number | null {
  const module = getEssentiaRuntimeSync()?.module as { HEAPU8?: Uint8Array } | undefined;
  return module?.HEAPU8 ? module.HEAPU8.buffer.byteLength : null;
}

export async function buildBackgroundDiagnostics(): Promise<HostResourceDiagnostics> {
  const pool = getWorkerPool();
  const status = pool.getStatus();
  const stats = getAnalysisCacheStats();
  const workers = await pool.collectPerfReports();
  const caches =
    `analysis=${stats.analysisEntries} key=${stats.keyEntries} ` +
    `decoded=${stats.decodedEntries}:${stats.decodedBytes}B ` +
    `inFlight=${stats.analysisInFlight}/${stats.keyInFlight}/${stats.decodeInFlight}`;
  return {
    context: 'background',
    awakeForDiagnostics: true,
    sample: sampler.snapshot(),
    pool: { ...status, busyFraction: pool.busyFraction() },
    workers,
    caches,
    essentiaHeapBytes: readEssentiaHeapBytes(),
    ts: Date.now()
  };
}

export function handleOpenResourceDiagnosticsSession(
  message: OpenSessionMessage
): Promise<{ ok: boolean }> {
  pruneStaleSessions();
  activeSessions.set(message.sessionId, Date.now());
  applySamplingState();
  return Promise.resolve({ ok: true });
}

export function handleCloseResourceDiagnosticsSession(
  message: CloseSessionMessage
): Promise<{ ok: boolean }> {
  activeSessions.delete(message.sessionId);
  pruneStaleSessions();
  applySamplingState();
  return Promise.resolve({ ok: true });
}

export async function handleGetResourceDiagnostics(
  message: GetDiagnosticsMessage
): Promise<ResourceDiagnosticsResponse> {
  pruneStaleSessions();
  // Refresh only a session we already know — GET never registers one (OPEN does), so a GET
  // from a session the receiver has forgotten (suspended SW) correctly reports sessionActive
  // false and prompts the content controller to re-open.
  if (activeSessions.has(message.sessionId)) {
    activeSessions.set(message.sessionId, Date.now());
  }
  applySamplingState();
  const background = await buildBackgroundDiagnostics();
  return {
    background,
    offscreen: null,
    sessionActive: activeSessions.has(message.sessionId),
    ts: Date.now()
  };
}
