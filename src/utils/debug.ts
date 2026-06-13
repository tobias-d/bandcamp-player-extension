import { DEBUG_KEY, DEBUG_TAGS_KEY } from '@/shared/constants';
import type { DebugEvent, LogTag } from '@/shared/types';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

type DebugWindow = Window & {
  __BC_DEBUG_EVENTS__?: DebugEvent[];
  __BC_DEBUG_EVENTS_CLEARED_AT__?: number;
};

const MAX_DEBUG_EVENTS = 200;

function isBrowserWindowContext(): boolean {
  return typeof window !== 'undefined';
}

function readStorage(key: string): string | null {
  if (!isBrowserWindowContext()) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function hasDebugQueryParam(): boolean {
  if (!isBrowserWindowContext()) {
    return false;
  }
  try {
    return new URLSearchParams(window.location.search).get('bcPlayerDebug') === '1';
  } catch {
    return false;
  }
}

function isEnabled(): boolean {
  return readStorage(DEBUG_KEY) === '1' || hasDebugQueryParam();
}

function isTagEnabled(tag: LogTag): boolean {
  const tags = readStorage(DEBUG_TAGS_KEY);
  if (!tags) {
    return true;
  }
  const allowed = tags
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return allowed.includes(tag);
}

function pushEvent(event: DebugEvent): void {
  if (!isBrowserWindowContext()) {
    return;
  }
  const debugWindow = window as DebugWindow;
  if (!Array.isArray(debugWindow.__BC_DEBUG_EVENTS__)) {
    debugWindow.__BC_DEBUG_EVENTS__ = [];
  }
  debugWindow.__BC_DEBUG_EVENTS__.push(event);
  if (debugWindow.__BC_DEBUG_EVENTS__.length > MAX_DEBUG_EVENTS) {
    debugWindow.__BC_DEBUG_EVENTS__.splice(0, debugWindow.__BC_DEBUG_EVENTS__.length - MAX_DEBUG_EVENTS);
  }
}

function write(level: DebugEvent['level'], tag: LogTag, args: unknown[]): void {
  const event: DebugEvent = {
    tag,
    level,
    args,
    ts: Date.now()
  };
  pushEvent(event);

  if (level !== 'error' && (!isEnabled() || !isTagEnabled(tag))) {
    return;
  }

  const prefix = `[${tag}]`;
  if (level === 'debug') {
    // eslint-disable-next-line no-console
    console.debug(prefix, ...args);
    return;
  }
  if (level === 'info') {
    // eslint-disable-next-line no-console
    console.info(prefix, ...args);
    return;
  }
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(prefix, ...args);
    return;
  }
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export function createLogger(tag: LogTag): Logger {
  return {
    debug: (...args: unknown[]) => write('debug', tag, args),
    info: (...args: unknown[]) => write('info', tag, args),
    warn: (...args: unknown[]) => write('warn', tag, args),
    error: (...args: unknown[]) => write('error', tag, args)
  };
}

export function getRecentDebugEvents(limit = 20): DebugEvent[] {
  if (!isBrowserWindowContext()) {
    return [];
  }
  const debugWindow = window as DebugWindow;
  const events = debugWindow.__BC_DEBUG_EVENTS__ ?? [];
  const clearedAt = debugWindow.__BC_DEBUG_EVENTS_CLEARED_AT__ ?? 0;
  const filtered = clearedAt > 0 ? events.filter((event) => event.ts >= clearedAt) : events;
  if (filtered.length !== events.length) {
    debugWindow.__BC_DEBUG_EVENTS__ = filtered;
  }
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export function clearDebugEvents(): void {
  if (!isBrowserWindowContext()) {
    return;
  }
  const debugWindow = window as DebugWindow;
  debugWindow.__BC_DEBUG_EVENTS_CLEARED_AT__ = Date.now();
  debugWindow.__BC_DEBUG_EVENTS__ = [];
}
