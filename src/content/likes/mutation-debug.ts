import type {
  LikeMutationAction,
  LikeMutationDebug,
  LikeMutationGate,
  LikeMutationTarget,
  LikesDebugSnapshot
} from '@/shared/types';
import { createLogger } from '@/utils/debug';

const logger = createLogger('LIKES');
const MAX_PROCESS_EVENTS = 120;
const PROCESS_OVERFLOW_WARN_INTERVAL_MS = 10_000;

let lastOverflowWarnAt = 0;

function maybeWarnProcessOverflow(overflowCount: number): void {
  if (overflowCount <= 0) {
    return;
  }
  const now = Date.now();
  if (now - lastOverflowWarnAt < PROCESS_OVERFLOW_WARN_INTERVAL_MS) {
    return;
  }
  lastOverflowWarnAt = now;
  logger.warn(`process-log overflow: truncating ${overflowCount} oldest entries`);
}

export function pushLikeProcessEvent(snapshot: LikesDebugSnapshot, stage: string, detail: string): void {
  const nextEvent = {
    ts: Date.now(),
    stage: String(stage || 'mutation'),
    detail: String(detail || '-')
  };
  const next = [...snapshot.processEvents, nextEvent];
  if (next.length > MAX_PROCESS_EVENTS) {
    maybeWarnProcessOverflow(next.length - MAX_PROCESS_EVENTS);
  }
  snapshot.processEvents = next.slice(-MAX_PROCESS_EVENTS);
}

export function patchLikeMutationDebug(
  snapshot: LikesDebugSnapshot,
  patch: Partial<LikeMutationDebug>
): void {
  snapshot.mutation = {
    ...snapshot.mutation,
    ...patch,
    ts: Number.isFinite(Number(patch.ts)) ? Number(patch.ts) : Date.now()
  };
}

export function setLikeMutationAction(
  snapshot: LikesDebugSnapshot,
  target: LikeMutationTarget,
  action: LikeMutationAction,
  phase: 'pending' | 'blocked' | 'failed' | 'ok',
  reason = ''
): void {
  snapshot.lastAction = `${target}:${action}:${phase}`;
  snapshot.lastActionTs = Date.now();
  if (reason) {
    snapshot.lastError = reason;
  } else if (phase !== 'failed' && phase !== 'blocked') {
    snapshot.lastError = '';
  }
}

export function resetLikeMutationDebug(snapshot: LikesDebugSnapshot): void {
  patchLikeMutationDebug(snapshot, {
    inFlight: false,
    target: 'none',
    action: 'none',
    key: '',
    gate: 'n/a',
    reasonCode: '',
    requestOrigin: '',
    requestContextFamily: '',
    requestContextVariant: '',
    selectedOriginReason: '',
    endpointPath: '',
    status: 0,
    ok: false,
    cooldownMsRemaining: 0,
    identityItemId: '',
    identityItemType: '',
    identityBandId: '',
    identityPageUrl: '',
    pageHost: '',
    targetHost: '',
    sameHost: false,
    fanIdPresent: false,
    fanIdValue: '',
    crumbPresent: false,
    crumbLength: 0,
    crumbSource: '',
    retryCount: 0,
    preflightReason: '',
    requestPreview: '',
    responsePreview: '',
    transport: '',
    preflightAt: 0,
    dispatchAt: 0,
    completedAt: 0,
    durationMs: 0
  });
}

export function setLikeMutationGate(
  snapshot: LikesDebugSnapshot,
  gate: LikeMutationGate,
  reasonCode: string
): void {
  patchLikeMutationDebug(snapshot, {
    gate,
    reasonCode
  });
}
