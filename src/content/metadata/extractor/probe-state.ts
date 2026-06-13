import { normalizeReleaseUrl } from '@/content/metadata/common';
import type { ReleaseIdentity } from '@/content/metadata/release';
import {
  PROBE_LOG_MIN_INTERVAL_MS,
  RELEASE_ALBUM_IDENTITY_TTL_MS,
  albumIdentityByReleaseUrl,
  ensureNextAllowedAtByKey,
  lastProbeStateByTrackId,
  lastProbeStateLogAtByTrackId,
  nextProbeAtByTrackId,
  parentAlbumProbeRetryCount,
  parentAlbumProbesByTrackId,
  parentAlbumRetryTimersByTrackId,
  resolvedIdentityByTrackId,
  strictDomProbeStateByTrackId,
  trackArtistNextProbeAtByTrackId,
  trackArtistProbeInFlightByTrackId,
  triedReleaseKeysByTrackId
} from '@/content/metadata/extractor/state';

export function getCachedAlbumIdentityForReleaseUrl(linkedReleaseUrl: string): ReleaseIdentity | null {
  const normalized = normalizeReleaseUrl(linkedReleaseUrl);
  if (!normalized || !normalized.includes('/album/')) {
    return null;
  }
  const entry = albumIdentityByReleaseUrl.get(normalized);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > RELEASE_ALBUM_IDENTITY_TTL_MS) {
    albumIdentityByReleaseUrl.delete(normalized);
    return null;
  }
  return entry.identity;
}

export function cacheAlbumIdentityForReleaseUrl(linkedReleaseUrl: string, identity: ReleaseIdentity | null): void {
  const normalized = normalizeReleaseUrl(linkedReleaseUrl);
  if (!normalized || !normalized.includes('/album/')) {
    return;
  }
  if (!identity || identity.tralbumType !== 'a') {
    return;
  }
  albumIdentityByReleaseUrl.set(normalized, {
    identity: {
      bandId: identity.bandId,
      tralbumId: identity.tralbumId,
      tralbumType: 'a'
    },
    ts: Date.now()
  });
  if (albumIdentityByReleaseUrl.size > 500) {
    const now = Date.now();
    for (const [key, value] of albumIdentityByReleaseUrl.entries()) {
      if (now - value.ts > RELEASE_ALBUM_IDENTITY_TTL_MS) {
        albumIdentityByReleaseUrl.delete(key);
      }
    }
  }
}

function normalizeProbeState(state: string): string {
  if (!state.startsWith('probe-wait:')) {
    return state;
  }
  return 'probe-wait';
}

export function logProbeState(trackIdRaw: string, state: string): void {
  const trackId = trackIdRaw || 'none';
  const normalizedState = normalizeProbeState(state);
  const now = Date.now();
  const previous = lastProbeStateByTrackId.get(trackId);
  const lastLoggedAt = lastProbeStateLogAtByTrackId.get(trackId) ?? 0;

  if (previous === normalizedState && now - lastLoggedAt < PROBE_LOG_MIN_INTERVAL_MS) {
    return;
  }

  if (previous === normalizedState) {
    return;
  }

  lastProbeStateByTrackId.set(trackId, normalizedState);
  lastProbeStateLogAtByTrackId.set(trackId, now);
}

export function getResolvedIdentityForTrack(trackId: string): ReleaseIdentity | null {
  if (!trackId) {
    return null;
  }
  return resolvedIdentityByTrackId.get(trackId) ?? null;
}

export function getLastProbeStateForTrack(trackId: string): string {
  if (!trackId) {
    return '-';
  }
  return lastProbeStateByTrackId.get(trackId) ?? '-';
}

export function logStrictDomProbeState(trackIdRaw: string, state: string): void {
  const trackId = trackIdRaw || 'none';
  strictDomProbeStateByTrackId.set(trackId, state || '-');
}

export function getLastStrictDomProbeStateForTrack(trackId: string): string {
  if (!trackId) {
    return '-';
  }
  return strictDomProbeStateByTrackId.get(trackId) ?? '-';
}

export function upsertResolvedIdentityForTrack(trackId: string, identity: ReleaseIdentity | null): void {
  if (!trackId || !identity) {
    return;
  }
  const normalizedBandId = String(identity.bandId || '').trim();
  const normalizedTralbumId = String(identity.tralbumId || '').trim();
  const normalizedType = identity.tralbumType === 'a' ? 'a' : identity.tralbumType === 't' ? 't' : '';
  if (!normalizedBandId || !normalizedTralbumId || !normalizedType) {
    return;
  }
  resolvedIdentityByTrackId.set(trackId, {
    bandId: normalizedBandId,
    tralbumId: normalizedTralbumId,
    tralbumType: normalizedType
  });
}

export function markTriedRelease(trackId: string, key: string): void {
  if (!trackId) {
    return;
  }
  const existing = triedReleaseKeysByTrackId.get(trackId) ?? new Set<string>();
  existing.add(key);
  triedReleaseKeysByTrackId.set(trackId, existing);
}

export function clearTriedReleases(trackId: string): void {
  if (!trackId) {
    return;
  }
  triedReleaseKeysByTrackId.delete(trackId);
  parentAlbumProbesByTrackId.delete(trackId);
  for (const key of parentAlbumProbeRetryCount.keys()) {
    if (key.startsWith(`${trackId}:`)) {
      parentAlbumProbeRetryCount.delete(key);
    }
  }
  const timers = parentAlbumRetryTimersByTrackId.get(trackId);
  if (timers) {
    timers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    parentAlbumRetryTimersByTrackId.delete(trackId);
  }
}

export function registerParentAlbumRetryTimer(trackId: string, timerId: number): void {
  if (!trackId) {
    return;
  }
  const timers = parentAlbumRetryTimersByTrackId.get(trackId) ?? new Set<number>();
  timers.add(timerId);
  parentAlbumRetryTimersByTrackId.set(trackId, timers);
}

export function pruneTrackScopedState(activeTrackId: string): void {
  if (!activeTrackId) {
    return;
  }
  const pruneByKey = (map: Map<string, unknown>): void => {
    for (const key of map.keys()) {
      if (key !== activeTrackId) {
        map.delete(key);
      }
    }
  };

  pruneByKey(resolvedIdentityByTrackId as unknown as Map<string, unknown>);
  pruneByKey(triedReleaseKeysByTrackId as unknown as Map<string, unknown>);
  pruneByKey(nextProbeAtByTrackId as unknown as Map<string, unknown>);
  pruneByKey(lastProbeStateByTrackId as unknown as Map<string, unknown>);
  pruneByKey(lastProbeStateLogAtByTrackId as unknown as Map<string, unknown>);
  pruneByKey(strictDomProbeStateByTrackId as unknown as Map<string, unknown>);
  pruneByKey(parentAlbumProbesByTrackId as unknown as Map<string, unknown>);
  pruneByKey(trackArtistNextProbeAtByTrackId as unknown as Map<string, unknown>);
  pruneByKey(trackArtistProbeInFlightByTrackId as unknown as Map<string, unknown>);

  for (const key of parentAlbumProbeRetryCount.keys()) {
    if (!key.startsWith(`${activeTrackId}:`)) {
      parentAlbumProbeRetryCount.delete(key);
    }
  }

  for (const [trackId, timers] of parentAlbumRetryTimersByTrackId.entries()) {
    if (trackId === activeTrackId) {
      continue;
    }
    timers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    parentAlbumRetryTimersByTrackId.delete(trackId);
  }

  for (const [key] of ensureNextAllowedAtByKey.entries()) {
    const keyTrackId = key.split('|', 1)[0] ?? '';
    if (keyTrackId && keyTrackId !== '-' && keyTrackId !== activeTrackId) {
      ensureNextAllowedAtByKey.delete(key);
    }
  }
}
