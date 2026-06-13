import type { PageGlobals } from '@/shared/types';
import type {
  ApiIdentityHint,
  BridgeStateSnapshot,
  DiscoverAudioEndedEvent,
  DiscoverPayloadTrackMatch,
  DiscoverAudioState,
  OwnedPlaybackHostState,
  PendingLikesMutation
} from '@/content/discover/origin-bridge/types';

const MAX_API_HINTS = 60;
const API_HINT_RETENTION_MS = 5 * 60 * 1000;
const DISCOVER_TRACK_MATCH_RETENTION_MS = 90_000;
const MAX_DISCOVER_TRACK_MATCHES = 240;

const state: BridgeStateSnapshot = {
  latestPayload: null,
  latestSelection: null,
  latestGlobals: null,
  apiIdentityHints: [],
  latestDiscoverAudioState: null,
  latestDiscoverAudioEnded: null,
  latestOwnedPlaybackHostState: null,
  latestPayloadTrackMatchesByTrackId: new Map<string, DiscoverPayloadTrackMatch>()
};

const pendingLikesMutations = new Map<string, PendingLikesMutation>();

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw, window.location.href).toString();
  } catch {
    return '';
  }
}

function normalizeReleaseUrl(value: unknown): string {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return '';
  }
  try {
    const parsed = new URL(normalized);
    const path = parsed.pathname.replace(/\/+$/, '');
    if (!/\/(album|track)\//.test(path)) {
      return '';
    }
    return `${parsed.origin}${path}`;
  } catch {
    return '';
  }
}

function toId(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const match = raw.match(/\d+/);
  return match?.[0] || '';
}

function readTrackIdFromUrl(value: unknown): string {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return '';
  }
  try {
    const parsed = new URL(normalized);
    const streamPathMatch = parsed.pathname.match(/\/mp3-(?:128|v0|320)\/(\d{6,})(?:\/|$)/i);
    if (streamPathMatch?.[1]) {
      return streamPathMatch[1];
    }
    const trackParam = parsed.searchParams.get('track_id') || parsed.searchParams.get('id');
    if (trackParam && /^\d{4,}$/.test(trackParam)) {
      return trackParam;
    }
  } catch {
    // Ignore malformed URLs and fall back to a plain-text scan below.
  }
  const pathMatch = String(value ?? '').match(/(\d{6,})/g);
  return pathMatch?.[0] || '';
}

function readDiscoverResults(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const direct = (payload as { results?: unknown[] }).results;
  if (Array.isArray(direct)) {
    return direct;
  }
  const nested = (payload as { discovery?: { results?: unknown[] } }).discovery?.results;
  return Array.isArray(nested) ? nested : [];
}

function indexPayloadTrackMatches(payload: unknown, ts: number): void {
  const results = readDiscoverResults(payload);
  if (!results.length) {
    return;
  }

  for (const itemRaw of results) {
    if (!itemRaw || typeof itemRaw !== 'object') {
      continue;
    }
    const item = itemRaw as Record<string, unknown>;
    const featured = (item['featured_track'] ?? {}) as Record<string, unknown>;
    const streamUrl = normalizeUrl(featured['stream_url'] ?? featured['streamUrl']);
    const trackId =
      toId(item['track_id']) ||
      toId(featured['track_id']) ||
      readTrackIdFromUrl(streamUrl);
    if (!trackId) {
      continue;
    }
    state.latestPayloadTrackMatchesByTrackId.set(trackId, {
      trackId,
      trackTitle: normalizeText(item['title']),
      artistName: normalizeText(item['artist'] ?? item['album_artist'] ?? featured['band_name'] ?? item['band_name']),
      albumTitle: normalizeText(item['album_title'] ?? item['albumTitle'] ?? item['release_title']),
      releaseUrl: normalizeReleaseUrl(
        item['item_url'] ?? item['itemUrl'] ?? item['tralbum_url'] ?? item['tralbumUrl'] ?? item['url'] ?? item['link']
      ),
      streamUrl,
      ts
    });
  }

  const cutoff = Date.now() - DISCOVER_TRACK_MATCH_RETENTION_MS;
  for (const [trackId, match] of state.latestPayloadTrackMatchesByTrackId.entries()) {
    if (!match || match.ts < cutoff) {
      state.latestPayloadTrackMatchesByTrackId.delete(trackId);
    }
  }
  if (state.latestPayloadTrackMatchesByTrackId.size > MAX_DISCOVER_TRACK_MATCHES) {
    const sorted = Array.from(state.latestPayloadTrackMatchesByTrackId.entries())
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, MAX_DISCOVER_TRACK_MATCHES);
    state.latestPayloadTrackMatchesByTrackId = new Map(sorted);
  }
}

export function setLatestObservedPayload(payload: unknown, ts: number): void {
  state.latestPayload = { data: payload, ts };
  indexPayloadTrackMatches(payload, ts);
}

export function setLatestObservedSelection(url: string, ts: number): void {
  state.latestSelection = { url, ts };
}

export function setLatestPageGlobals(payload: {
  tralbum?: unknown;
  band?: unknown;
  page?: unknown;
  fan?: unknown;
  collection?: unknown;
  wishlist?: unknown;
  bc?: unknown;
}, ts: number): void {
  state.latestGlobals = {
    tralbum: payload?.tralbum ?? null,
    band: payload?.band ?? null,
    page: payload?.page ?? null,
    fan: payload?.fan ?? null,
    collection: payload?.collection ?? null,
    wishlist: payload?.wishlist ?? null,
    bc: payload?.bc ?? null,
    ts
  };
}

export function upsertApiIdentityHint(payload: {
  bandId?: unknown;
  tralbumId?: unknown;
  tralbumType?: unknown;
  trackId?: unknown;
  url?: unknown;
}): void {
  const bandId = String(payload?.bandId ?? '').trim();
  const tralbumId = String(payload?.tralbumId ?? '').trim();
  const tralbumTypeRaw = String(payload?.tralbumType ?? '').trim().toLowerCase();
  const tralbumType: 'a' | 't' | '' =
    tralbumTypeRaw === 'a' || tralbumTypeRaw === 'album'
      ? 'a'
      : tralbumTypeRaw === 't' || tralbumTypeRaw === 'track'
        ? 't'
        : '';
  const url = String(payload?.url ?? '');
  const trackId = String(payload?.trackId ?? '').trim();

  if (!bandId || !tralbumId) {
    return;
  }

  const now = Date.now();
  const key = `${bandId}:${tralbumId}:${tralbumType || '-'}:${trackId || '-'}`;
  const existingIndex = state.apiIdentityHints.findIndex(
    (hint) => `${hint.bandId}:${hint.tralbumId}:${hint.tralbumType || '-'}:${hint.trackId || '-'}` === key
  );

  const next: ApiIdentityHint = {
    bandId,
    tralbumId,
    tralbumType,
    trackId: trackId || undefined,
    url,
    ts: now
  };

  if (existingIndex >= 0) {
    state.apiIdentityHints[existingIndex] = next;
  } else {
    state.apiIdentityHints.push(next);
  }

  const cutoff = now - API_HINT_RETENTION_MS;
  state.apiIdentityHints = state.apiIdentityHints
    .filter((hint) => hint.ts >= cutoff)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_API_HINTS);
}

export function setLatestDiscoverAudioState(payload: {
  src?: unknown;
  paused?: unknown;
  ended?: unknown;
  currentTimeSec?: unknown;
  durationSec?: unknown;
  volume?: unknown;
  muted?: unknown;
}): void {
  const src = String(payload?.src ?? '').trim();
  const paused = Boolean(payload?.paused);
  const ended = Boolean(payload?.ended);
  const currentTimeSecRaw = Number(payload?.currentTimeSec ?? 0);
  const durationSecRaw = Number(payload?.durationSec ?? 0);
  const volumeRaw = Number(payload?.volume ?? 1);
  state.latestDiscoverAudioState = {
    src,
    paused,
    ended,
    currentTimeSec: Number.isFinite(currentTimeSecRaw) ? currentTimeSecRaw : 0,
    durationSec: Number.isFinite(durationSecRaw) ? durationSecRaw : 0,
    volume: Number.isFinite(volumeRaw) ? Math.max(0, Math.min(1, volumeRaw)) : 1,
    muted: Boolean(payload?.muted),
    ts: Date.now()
  };
}

export function setLatestDiscoverAudioEnded(payload: {
  src?: unknown;
  currentTimeSec?: unknown;
  durationSec?: unknown;
}): void {
  const src = String(payload?.src ?? '').trim();
  if (!src) {
    return;
  }
  const currentTimeSecRaw = Number(payload?.currentTimeSec ?? 0);
  const durationSecRaw = Number(payload?.durationSec ?? 0);
  state.latestDiscoverAudioEnded = {
    src,
    currentTimeSec: Number.isFinite(currentTimeSecRaw) ? currentTimeSecRaw : 0,
    durationSec: Number.isFinite(durationSecRaw) ? durationSecRaw : 0,
    ts: Date.now()
  };
}

export function setLatestOwnedPlaybackHostState(payload: {
  status?: unknown;
  phase?: unknown;
  engine?: unknown;
  detail?: unknown;
  currentSrc?: unknown;
  playing?: unknown;
  detachedReady?: unknown;
  lastCommand?: unknown;
  lastCommandDetail?: unknown;
  lastCommandAt?: unknown;
  lastAudioEvent?: unknown;
  lastAudioEventDetail?: unknown;
  lastAudioEventAt?: unknown;
  trackedAudioCount?: unknown;
  knownAudioCount?: unknown;
  playingAudioCount?: unknown;
  activeSrc?: unknown;
  playingSrcs?: unknown;
}): void {
  const statusRaw = String(payload?.status ?? '').trim().toLowerCase();
  const status: OwnedPlaybackHostState['status'] =
    statusRaw === 'ready' || statusRaw === 'error' ? statusRaw : 'booting';
  const trackedAudioCountRaw = Number(payload?.trackedAudioCount ?? 0);
  const knownAudioCountRaw = Number(payload?.knownAudioCount ?? 0);
  const playingAudioCountRaw = Number(payload?.playingAudioCount ?? 0);
  const lastCommandAtRaw = Number(payload?.lastCommandAt ?? 0);
  const lastAudioEventAtRaw = Number(payload?.lastAudioEventAt ?? 0);
  const playingSrcsRaw = Array.isArray(payload?.playingSrcs) ? payload.playingSrcs : [];
  state.latestOwnedPlaybackHostState = {
    status,
    phase: String(payload?.phase ?? '').trim() || 'unknown',
    engine: String(payload?.engine ?? '').trim() || 'unknown',
    detail: String(payload?.detail ?? '').trim() || '-',
    currentSrc: String(payload?.currentSrc ?? '').trim(),
    playing: Boolean(payload?.playing),
    detachedReady: Boolean(payload?.detachedReady),
    lastCommand: String(payload?.lastCommand ?? '').trim() || '-',
    lastCommandDetail: String(payload?.lastCommandDetail ?? '').trim() || '-',
    lastCommandAt: Number.isFinite(lastCommandAtRaw) ? Math.max(0, Math.floor(lastCommandAtRaw)) : 0,
    lastAudioEvent: String(payload?.lastAudioEvent ?? '').trim() || '-',
    lastAudioEventDetail: String(payload?.lastAudioEventDetail ?? '').trim() || '-',
    lastAudioEventAt: Number.isFinite(lastAudioEventAtRaw) ? Math.max(0, Math.floor(lastAudioEventAtRaw)) : 0,
    trackedAudioCount: Number.isFinite(trackedAudioCountRaw) ? Math.max(0, Math.floor(trackedAudioCountRaw)) : 0,
    knownAudioCount: Number.isFinite(knownAudioCountRaw) ? Math.max(0, Math.floor(knownAudioCountRaw)) : 0,
    playingAudioCount: Number.isFinite(playingAudioCountRaw) ? Math.max(0, Math.floor(playingAudioCountRaw)) : 0,
    activeSrc: String(payload?.activeSrc ?? '').trim(),
    playingSrcs: playingSrcsRaw.map((value) => String(value ?? '').trim()).filter(Boolean).slice(0, 6),
    ts: Date.now()
  };
}

export function getLatestPageGlobals(maxAgeMs = Number.POSITIVE_INFINITY): PageGlobals | null {
  if (!state.latestGlobals) {
    return null;
  }
  if (!Number.isFinite(maxAgeMs)) {
    return state.latestGlobals;
  }
  return Date.now() - state.latestGlobals.ts <= maxAgeMs ? state.latestGlobals : null;
}

export function getLatestObservedDiscoverPayload(maxAgeMs = 30_000): unknown | null {
  if (!state.latestPayload) {
    return null;
  }
  return Date.now() - state.latestPayload.ts <= maxAgeMs ? state.latestPayload.data : null;
}

export function getLatestOwnedPlaybackHostState(maxAgeMs = 15_000): OwnedPlaybackHostState | null {
  if (!state.latestOwnedPlaybackHostState) {
    return null;
  }
  return Date.now() - state.latestOwnedPlaybackHostState.ts <= maxAgeMs ? state.latestOwnedPlaybackHostState : null;
}

export function getLatestObservedDiscoverPayloadTrackMatch(
  trackIdRaw: string,
  maxAgeMs = 30_000
): DiscoverPayloadTrackMatch | null {
  const trackId = String(trackIdRaw || '').trim();
  if (!trackId) {
    return null;
  }
  const match = state.latestPayloadTrackMatchesByTrackId.get(trackId) || null;
  if (!match) {
    return null;
  }
  return Date.now() - match.ts <= Math.max(0, maxAgeMs) ? match : null;
}

export function getLatestObservedDiscoverSelection(maxAgeMs = 30_000): { url: string; ts: number } | null {
  if (!state.latestSelection) {
    return null;
  }
  return Date.now() - state.latestSelection.ts <= maxAgeMs ? state.latestSelection : null;
}

export function getRecentApiIdentityHints(maxAgeMs = 5 * 60 * 1000): ApiIdentityHint[] {
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  return state.apiIdentityHints.filter((hint) => hint.ts >= cutoff);
}

export function getLatestObservedDiscoverAudioState(maxAgeMs = 30_000): DiscoverAudioState | null {
  if (!state.latestDiscoverAudioState) {
    return null;
  }
  return Date.now() - state.latestDiscoverAudioState.ts <= maxAgeMs ? state.latestDiscoverAudioState : null;
}

export function getLatestObservedDiscoverAudioEnded(maxAgeMs = 30_000): DiscoverAudioEndedEvent | null {
  if (!state.latestDiscoverAudioEnded) {
    return null;
  }
  return Date.now() - state.latestDiscoverAudioEnded.ts <= maxAgeMs ? state.latestDiscoverAudioEnded : null;
}

export function setPendingLikesMutation(requestId: string, pending: PendingLikesMutation): void {
  pendingLikesMutations.set(requestId, pending);
}

export function takePendingLikesMutation(requestId: string): PendingLikesMutation | null {
  const pending = pendingLikesMutations.get(requestId) || null;
  if (pending) {
    pendingLikesMutations.delete(requestId);
  }
  return pending;
}

export function clearPendingLikesMutation(requestId: string): void {
  pendingLikesMutations.delete(requestId);
}
