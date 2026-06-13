import { PlayerState } from '@/content/player/state';
import {
  recordTransportBridgeEvent,
  recordTransportGuard,
  recordTransportPlaylistAlign,
  recordTransportSelection,
  recordTransportUiAction
} from '@/content/debug/debugger';
import { createLogger } from '@/utils/debug';

const logger = createLogger('UI');
const GUARD_DEDUPE_WINDOW_MS = 1200;
const ALIGN_DEDUPE_WINDOW_MS = 900;
let lastGuardAction = '';
let lastGuardDetail = '';
let lastGuardTs = 0;
let lastAlignDetail = '';
let lastAlignTs = 0;

export function recordUiAction(state: PlayerState, action: string, detail: string): void {
  recordTransportUiAction(state.transportDebug, action, detail);
  logger.info('transport action', { seq: state.transportDebug.actionSeq, action, detail });
}

export function recordSelection(state: PlayerState, action: string, detail: string): void {
  recordTransportSelection(state.transportDebug, action, detail);
  logger.info('playlist selection', { action, detail });
}

export function recordBridgeEvent(state: PlayerState, eventType: string, detail: string): void {
  recordTransportBridgeEvent(state.transportDebug, eventType, detail);
}

export function recordPlaylistAlign(state: PlayerState, detail: string): void {
  const now = Date.now();
  const isKeptAlign = detail.includes(' kept (');
  if (isKeptAlign && detail === lastAlignDetail && now - lastAlignTs < ALIGN_DEDUPE_WINDOW_MS) {
    return;
  }
  lastAlignDetail = detail;
  lastAlignTs = now;
  recordTransportPlaylistAlign(state.transportDebug, detail);
}

export function recordGuard(state: PlayerState, action: string, detail: string): void {
  const now = Date.now();
  if (action === lastGuardAction && detail === lastGuardDetail && now - lastGuardTs < GUARD_DEDUPE_WINDOW_MS) {
    return;
  }
  lastGuardAction = action;
  lastGuardDetail = detail;
  lastGuardTs = now;
  recordTransportGuard(state.transportDebug, action, detail);
  logger.info('transport guard', { action, detail });
}
