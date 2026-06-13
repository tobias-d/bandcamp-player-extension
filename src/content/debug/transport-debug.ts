import { formatTraceClock } from '@/shared/debug-trace';

export type TransportTraceChannel = 'ui' | 'selection' | 'bridge' | 'align' | 'guard';

export interface TransportTraceEntry {
  ts: number;
  channel: TransportTraceChannel;
  action: string;
  detail: string;
}

export interface TransportDebugState {
  actionSeq: number;
  uiCount: number;
  selectionCount: number;
  bridgeCount: number;
  alignCount: number;
  guardCount: number;
  selectionOkCount: number;
  selectionMissCount: number;
  fallbackLoadCount: number;
  blockedCount: number;
  lastUiAction: string;
  lastUiActionDetail: string;
  lastUiActionAt: number;
  lastSelection: string;
  lastSelectionDetail: string;
  lastSelectionAt: number;
  lastBridgeEvent: string;
  lastBridgeDetail: string;
  lastBridgeAt: number;
  lastPlaylistAlign: string;
  lastPlaylistAlignAt: number;
  trace: TransportTraceEntry[];
}

const PLAYER_TRACE_LIMIT = 60;
const DISCOVER_TRACE_LIMIT = 40;

export function formatSince(ts: number): string {
  if (!ts) {
    return '-';
  }
  const delta = Math.max(0, Date.now() - ts);
  return `${delta}ms`;
}

export function createTransportDebugState(): TransportDebugState {
  return {
    actionSeq: 0,
    uiCount: 0,
    selectionCount: 0,
    bridgeCount: 0,
    alignCount: 0,
    guardCount: 0,
    selectionOkCount: 0,
    selectionMissCount: 0,
    fallbackLoadCount: 0,
    blockedCount: 0,
    lastUiAction: '-',
    lastUiActionDetail: '-',
    lastUiActionAt: 0,
    lastSelection: '-',
    lastSelectionDetail: '-',
    lastSelectionAt: 0,
    lastBridgeEvent: '-',
    lastBridgeDetail: '-',
    lastBridgeAt: 0,
    lastPlaylistAlign: '-',
    lastPlaylistAlignAt: 0,
    trace: []
  };
}

function pushTransportTrace(
  state: TransportDebugState,
  channel: TransportTraceChannel,
  action: string,
  detail: string
): void {
  state.trace.push({
    ts: Date.now(),
    channel,
    action: action || '-',
    detail: detail || '-'
  });
  if (state.trace.length > PLAYER_TRACE_LIMIT) {
    state.trace.splice(0, state.trace.length - PLAYER_TRACE_LIMIT);
  }
}

export function recordTransportUiAction(state: TransportDebugState, action: string, detail: string): void {
  state.actionSeq += 1;
  state.uiCount += 1;
  state.lastUiAction = action || '-';
  state.lastUiActionDetail = detail || '-';
  state.lastUiActionAt = Date.now();
  pushTransportTrace(state, 'ui', action, detail);
}

export function recordTransportSelection(state: TransportDebugState, action: string, detail: string): void {
  state.selectionCount += 1;
  if (action === 'select-ok' || action === 'runtime-playlist-load-track') {
    state.selectionOkCount += 1;
  }
  if (action === 'select-miss') {
    state.selectionMissCount += 1;
  }
  if (action === 'fallback-load-track') {
    state.fallbackLoadCount += 1;
  }
  if (action.includes('blocked')) {
    state.blockedCount += 1;
  }
  state.lastSelection = action || '-';
  state.lastSelectionDetail = detail || '-';
  state.lastSelectionAt = Date.now();
  pushTransportTrace(state, 'selection', action, detail);
}

export function recordTransportBridgeEvent(state: TransportDebugState, eventType: string, detail: string): void {
  state.bridgeCount += 1;
  state.lastBridgeEvent = eventType || '-';
  state.lastBridgeDetail = detail || '-';
  state.lastBridgeAt = Date.now();
  pushTransportTrace(state, 'bridge', eventType, detail);
}

export function recordTransportPlaylistAlign(state: TransportDebugState, detail: string): void {
  state.alignCount += 1;
  state.lastPlaylistAlign = detail || '-';
  state.lastPlaylistAlignAt = Date.now();
  pushTransportTrace(state, 'align', 'playlist-align', detail);
}

export function recordTransportGuard(state: TransportDebugState, action: string, detail: string): void {
  state.guardCount += 1;
  state.blockedCount += 1;
  pushTransportTrace(state, 'guard', action, detail);
}

export function recordTransportPlaylistRefresh(state: TransportDebugState, detail: string): void {
  pushTransportTrace(state, 'align', 'playlist-refresh', detail);
}

export function formatTransportTraceLines(state: TransportDebugState, limit = 10): string[] {
  return state.trace.slice(-Math.max(1, limit)).map((entry) =>
    `${formatTraceClock(entry.ts)} [${entry.channel}] ${entry.action} ${entry.detail}`
  );
}

export interface DiscoverTransportTraceEntry {
  ts: number;
  kind: 'action' | 'result';
  action: string;
  detail: string;
}

export interface DiscoverTransportDebugState {
  actionSeq: number;
  lastAction: string;
  lastActionDetail: string;
  lastActionAt: number;
  lastResult: string;
  lastResultDetail: string;
  lastResultAt: number;
  trace: DiscoverTransportTraceEntry[];
}

export function createDiscoverTransportDebugState(): DiscoverTransportDebugState {
  return {
    actionSeq: 0,
    lastAction: '-',
    lastActionDetail: '-',
    lastActionAt: 0,
    lastResult: '-',
    lastResultDetail: '-',
    lastResultAt: 0,
    trace: []
  };
}

function pushDiscoverTrace(
  state: DiscoverTransportDebugState,
  kind: 'action' | 'result',
  action: string,
  detail: string
): void {
  state.trace.push({
    ts: Date.now(),
    kind,
    action: action || '-',
    detail: detail || '-'
  });
  if (state.trace.length > DISCOVER_TRACE_LIMIT) {
    state.trace.splice(0, state.trace.length - DISCOVER_TRACE_LIMIT);
  }
}

export function recordDiscoverTransportAction(
  state: DiscoverTransportDebugState,
  action: string,
  detail: string
): void {
  state.actionSeq += 1;
  state.lastAction = action || '-';
  state.lastActionDetail = detail || '-';
  state.lastActionAt = Date.now();
  pushDiscoverTrace(state, 'action', action, detail);
}

export function recordDiscoverTransportResult(
  state: DiscoverTransportDebugState,
  action: string,
  detail: string
): void {
  state.lastResult = action || '-';
  state.lastResultDetail = detail || '-';
  state.lastResultAt = Date.now();
  pushDiscoverTrace(state, 'result', action, detail);
}

export function formatDiscoverTransportTraceLines(state: DiscoverTransportDebugState, limit = 8): string[] {
  return state.trace.slice(-Math.max(1, limit)).map((entry) =>
    `${formatTraceClock(entry.ts)} [${entry.kind}] ${entry.action} ${entry.detail}`
  );
}
