import { getLatestPageGlobals } from '@/content/discover/origin-bridge';
import { isReleaseContext, readTrackIdFromUrl } from '@/content/metadata/common';
import { getNowPlayingLinkedReleaseUrl } from '@/content/metadata/release';
import { getResolvedIdentityForTrack } from '@/content/metadata/extractor/probe-state';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import {
  getCachedApiTralbum,
  getValidCachedApiEntry,
  isCurrentRootTrack,
  noteActiveRootTrack
} from '@/content/metadata/extractor/api/probe';
import { getTrackList, tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import { releaseKey } from '@/content/metadata/identity';
import {
  apiInFlightByRelease,
  lastProbeStateByTrackId,
  nextProbeAtByTrackId,
  parentAlbumProbeRetryCount,
  parentAlbumProbesByTrackId,
  parentAlbumRetryTimersByTrackId
} from '@/content/metadata/extractor/state';

export function getRootPlaylistProbeStatus(currentSrc = ''): {
  pending: boolean;
  nextCheckMs: number;
  reason: string;
} {
  const sourceUrl = currentSrc || getLikelyCurrentSrc();
  const trackId = readTrackIdFromUrl(sourceUrl);
  if (!trackId) {
    return { pending: false, nextCheckMs: 0, reason: 'no-track' };
  }
  if (isReleaseContext()) {
    return { pending: false, nextCheckMs: 0, reason: 'release-context' };
  }
  if (!isCurrentRootTrack(trackId)) {
    return { pending: false, nextCheckMs: 0, reason: 'stale-track' };
  }

  const now = Date.now();
  const linkedReleaseUrl = getNowPlayingLinkedReleaseUrl();
  const wantsAlbumLinkedRelease = linkedReleaseUrl.includes('/album/');
  const resolvedIdentity = getResolvedIdentityForTrack(trackId);
  const resolvedCached = resolvedIdentity ? getValidCachedApiEntry(resolvedIdentity)?.tralbum ?? null : null;
  const effectiveCached = getCachedApiTralbum(getLatestPageGlobals(), sourceUrl);

  const resolvedTracks = resolvedCached ? getTrackList(resolvedCached) : [];
  const resolvedMatches = resolvedCached ? tralbumMatchesCurrentTrack(resolvedCached, trackId, sourceUrl) : false;
  const effectiveTracks = effectiveCached ? getTrackList(effectiveCached) : [];
  const effectiveMatches = effectiveCached ? tralbumMatchesCurrentTrack(effectiveCached, trackId, sourceUrl) : false;
  if (effectiveMatches && effectiveTracks.length > 1) {
    return { pending: false, nextCheckMs: 0, reason: 'full-playlist-cached' };
  }
  if (effectiveMatches && effectiveTracks.length > 0) {
    if (!wantsAlbumLinkedRelease) {
      return { pending: false, nextCheckMs: 0, reason: 'single-track-release' };
    }
    if (resolvedIdentity?.tralbumType === 'a') {
      return { pending: false, nextCheckMs: 0, reason: 'single-track-album' };
    }
  }

  const lastState = lastProbeStateByTrackId.get(trackId) ?? '';
  const terminalState =
    lastState === 'probe-exhausted' ||
    lastState === 'no-candidates' ||
    lastState === 'root-no-trackid' ||
    lastState === 'root-cutover' ||
    lastState === 'root-stale-track';

  const nextProbeAt = nextProbeAtByTrackId.get(trackId) ?? 0;
  if (nextProbeAt > now) {
    const isDiscover = window.location.pathname.startsWith('/discover');
    const minCheckMs = isDiscover ? 80 : 250;
    const maxCheckMs = isDiscover ? 2000 : 4000;
    return {
      pending: true,
      nextCheckMs: Math.max(minCheckMs, Math.min(maxCheckMs, nextProbeAt - now + 80)),
      reason: 'probe-wait'
    };
  }

  const parentTimers = parentAlbumRetryTimersByTrackId.get(trackId);
  if (parentTimers && parentTimers.size > 0) {
    return { pending: true, nextCheckMs: 350, reason: 'parent-retry-timer' };
  }

  const parentProbes = parentAlbumProbesByTrackId.get(trackId);
  if (parentProbes && parentProbes.size > 0) {
    return { pending: true, nextCheckMs: 450, reason: 'parent-probe' };
  }

  for (const key of parentAlbumProbeRetryCount.keys()) {
    if (key.startsWith(`${trackId}:`)) {
      return { pending: true, nextCheckMs: 500, reason: 'parent-retry' };
    }
  }

  if (resolvedIdentity && apiInFlightByRelease.has(releaseKey(resolvedIdentity))) {
    return { pending: true, nextCheckMs: 300, reason: 'api-inflight' };
  }

  if (
    lastState === 'probe-target' ||
    lastState === 'probe-wait' ||
    lastState === 'probe-settle' ||
    lastState === 'root-track-single'
  ) {
    return { pending: true, nextCheckMs: 550, reason: lastState };
  }

  if (terminalState) {
    return { pending: false, nextCheckMs: 0, reason: lastState };
  }

  if (wantsAlbumLinkedRelease) {
    const discoverFastCheckMs = 220;
    const defaultCheckMs = 700;
    const nextCheckMs = window.location.pathname.startsWith('/discover') ? discoverFastCheckMs : defaultCheckMs;
    return { pending: true, nextCheckMs, reason: 'album-unresolved' };
  }

  return { pending: false, nextCheckMs: 0, reason: 'idle' };
}

export function notifyTrackSwitch(currentSrc = ''): void {
  const sourceUrl = currentSrc || getLikelyCurrentSrc();
  const trackId = readTrackIdFromUrl(sourceUrl);
  if (!trackId) {
    return;
  }
  noteActiveRootTrack(trackId);
}
