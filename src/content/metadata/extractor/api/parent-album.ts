import { isReleaseContext, readTrackIdFromUrl } from '@/content/metadata/common';
import type { ReleaseIdentity } from '@/content/metadata/release';
import { releaseKey } from '@/content/metadata/identity';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import {
  extractParentAlbumIdentityFromTralbum,
  maybeCacheAlbumIdentityForLinkedRelease
} from '@/content/metadata/extractor/parent-album';
import {
  clearTriedReleases,
  registerParentAlbumRetryTimer
} from '@/content/metadata/extractor/probe-state';
import { getTrackList, tralbumMatchesCurrentTrack } from '@/content/metadata/extractor/tralbum-utils';
import type { ApiCacheEntry, TralbumLike } from '@/content/metadata/extractor/types';
import {
  API_MIN_REQUEST_INTERVAL_MS,
  PARENT_ALBUM_MAX_RETRIES,
  PARENT_ALBUM_RETRY_DELAY_MS,
  nextProbeAtByTrackId,
  parentAlbumProbeRetryCount,
  parentAlbumProbesByTrackId,
  resolvedIdentityByTrackId
} from '@/content/metadata/extractor/state';
import type { FetchTralbumForIdentity } from '@/content/metadata/extractor/api/fetch';

type GetValidCachedApiEntry = (identity: ReleaseIdentity) => ApiCacheEntry | null;

export function maybeExpandToParentAlbum(
  trackId: string,
  currentSrc: string,
  requestUrl: string,
  linkedReleaseUrl: string,
  baseIdentity: ReleaseIdentity | null,
  tralbum: TralbumLike,
  getValidCachedApiEntry: GetValidCachedApiEntry,
  fetchTralbumForIdentity: FetchTralbumForIdentity
): void {
  if (!trackId || isReleaseContext()) {
    return;
  }
  const activeTrackId = readTrackIdFromUrl(getLikelyCurrentSrc());
  if (activeTrackId && activeTrackId !== trackId) {
    return;
  }

  const tracks = getTrackList(tralbum);
  if (tracks.length !== 1) {
    return;
  }

  const candidates: ReleaseIdentity[] = [];
  const seen = new Set<string>();
  const addCandidate = (identity: ReleaseIdentity | null): void => {
    if (!identity) {
      return;
    }
    const key = releaseKey(identity);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(identity);
  };

  const parentIdentity = extractParentAlbumIdentityFromTralbum(tralbum, baseIdentity);
  addCandidate(parentIdentity);

  if (linkedReleaseUrl.includes('/album/') && baseIdentity && baseIdentity.tralbumType === 't') {
    addCandidate({
      bandId: baseIdentity.bandId,
      tralbumId: baseIdentity.tralbumId,
      tralbumType: 'a'
    });
  }

  if (!candidates.length) {
    return;
  }

  const probes = parentAlbumProbesByTrackId.get(trackId) ?? new Set<string>();
  parentAlbumProbesByTrackId.set(trackId, probes);

  const runProbe = (identity: ReleaseIdentity): void => {
    const liveTrackId = readTrackIdFromUrl(getLikelyCurrentSrc());
    if (liveTrackId && liveTrackId !== trackId) {
      return;
    }
    const probeKey = `${baseIdentity ? releaseKey(baseIdentity) : '-'}=>${releaseKey(identity)}`;
    const retryKey = `${trackId}:${probeKey}`;
    if (probes.has(probeKey)) {
      return;
    }
    probes.add(probeKey);

    const queueRetry = (): void => {
      const retryCount = parentAlbumProbeRetryCount.get(retryKey) ?? 0;
      if (retryCount >= PARENT_ALBUM_MAX_RETRIES) {
        probes.delete(probeKey);
        parentAlbumProbeRetryCount.delete(retryKey);
        return;
      }
      parentAlbumProbeRetryCount.set(retryKey, retryCount + 1);
      const timerId = window.setTimeout(() => {
        probes.delete(probeKey);
        runProbe(identity);
      }, PARENT_ALBUM_RETRY_DELAY_MS);
      registerParentAlbumRetryTimer(trackId, timerId);
    };

    const cached = getValidCachedApiEntry(identity);
    if (cached) {
      const cachedTracks = getTrackList(cached.tralbum);
      if (cachedTracks.length > 1 && tralbumMatchesCurrentTrack(cached.tralbum, trackId, currentSrc)) {
        resolvedIdentityByTrackId.set(trackId, identity);
        maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, cached.tralbum, identity);
        clearTriedReleases(trackId);
        nextProbeAtByTrackId.delete(trackId);
        parentAlbumProbeRetryCount.delete(retryKey);
      }
      return;
    }

    const request = fetchTralbumForIdentity(identity, requestUrl, trackId);
    if (!request) {
      queueRetry();
      return;
    }

    void request.then((result) => {
      if (!result.tralbum) {
        if (result.retryable) {
          queueRetry();
          return;
        }
        parentAlbumProbeRetryCount.delete(retryKey);
        return;
      }
      const resultTracks = getTrackList(result.tralbum);
      if (resultTracks.length <= 1) {
        parentAlbumProbeRetryCount.delete(retryKey);
        return;
      }
      if (tralbumMatchesCurrentTrack(result.tralbum, trackId, currentSrc)) {
        resolvedIdentityByTrackId.set(trackId, identity);
        maybeCacheAlbumIdentityForLinkedRelease(linkedReleaseUrl, result.tralbum, identity);
        clearTriedReleases(trackId);
        nextProbeAtByTrackId.delete(trackId);
        parentAlbumProbeRetryCount.delete(retryKey);
      }
    });
  };

  candidates.forEach((candidate, index) => {
    if (index === 0) {
      runProbe(candidate);
      return;
    }
    const timerId = window.setTimeout(() => {
      runProbe(candidate);
    }, API_MIN_REQUEST_INTERVAL_MS + index * 250);
    registerParentAlbumRetryTimer(trackId, timerId);
  });
}
