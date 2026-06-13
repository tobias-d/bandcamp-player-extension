import type { ReleaseIdentity } from '@/content/metadata/release';
import type { ApiCacheEntry, FetchIdentityResult } from '@/content/metadata/extractor/types';
import type { TrackReleaseDate } from '@/shared/types';

export const API_CACHE_TTL_MS = 15 * 60 * 1000;
export const API_MIN_REQUEST_INTERVAL_MS = 2_000;
export const API_RATE_BACKOFF_MS = 10 * 60 * 1000;
export const API_ERROR_BACKOFF_MS = 60_000;
export const API_LOCAL_LIMIT_BACKOFF_MS = 8_000;
export const API_PROBE_INTERVAL_MS = 700;
export const API_ENSURE_GLOBAL_INTERVAL_MS = 400;
export const API_ENSURE_KEY_INTERVAL_MS = 1_400;
export const RELEASE_ALBUM_IDENTITY_TTL_MS = 60 * 60 * 1000;
export const TRACK_ARTIST_CACHE_TTL_MS = 30 * 60 * 1000;
export const TRACK_ARTIST_PROBE_INTERVAL_MS = 5_000;
export const PARENT_ALBUM_MAX_RETRIES = 3;
export const PARENT_ALBUM_RETRY_DELAY_MS = API_MIN_REQUEST_INTERVAL_MS + 150;
export const ROOT_PROBE_CANDIDATE_CAP = 10;
export const ROOT_PROBE_DOM_PRIORITY_CAP = 6;
export const ROOT_PROBE_SETTLE_MS = 200;
export const PROBE_LOG_MIN_INTERVAL_MS = 1000;

export interface TrackMetadataIndexEntry {
  releaseKey: string;
  trackId: string;
  ts: number;
  completeness: number;
  trackCount: number;
  title?: { value: string; source: string };
  artist?: { value: string; source: string };
  album?: { value: string; source: string };
  releaseDate?: TrackReleaseDate;
}

export const apiCacheByRelease = new Map<string, ApiCacheEntry>();
export const apiInFlightByRelease = new Map<string, Promise<FetchIdentityResult>>();
export const apiLastAttemptByRelease = new Map<string, number>();
export const apiBackoffUntilByRelease = new Map<string, number>();
export const trackMetadataIndexByTrackId = new Map<string, TrackMetadataIndexEntry>();
export const trackMetadataCandidatesByTrackId = new Map<string, Map<string, TrackMetadataIndexEntry>>();
export const trackIdsByReleaseKey = new Map<string, Set<string>>();
export const resolvedIdentityByTrackId = new Map<string, ReleaseIdentity>();
export const triedReleaseKeysByTrackId = new Map<string, Set<string>>();
export const nextProbeAtByTrackId = new Map<string, number>();
export const lastProbeStateByTrackId = new Map<string, string>();
export const lastProbeStateLogAtByTrackId = new Map<string, number>();
export const strictDomProbeStateByTrackId = new Map<string, string>();
export const warnedUnexpectedPayloadByRelease = new Set<string>();
export const parentAlbumProbesByTrackId = new Map<string, Set<string>>();
export const parentAlbumProbeRetryCount = new Map<string, number>();
export const parentAlbumRetryTimersByTrackId = new Map<string, Set<number>>();
export const cachedTrackArtistByTrackId = new Map<string, { artist: string; source: string; ts: number }>();
export const trackArtistProbeInFlightByTrackId = new Map<string, Promise<void>>();
export const trackArtistNextProbeAtByTrackId = new Map<string, number>();
export const ensureNextAllowedAtByKey = new Map<string, number>();
export const albumIdentityByReleaseUrl = new Map<string, { identity: ReleaseIdentity; ts: number }>();

export function clearMetadataRuntimeCaches(): void {
  apiCacheByRelease.clear();
  apiInFlightByRelease.clear();
  apiLastAttemptByRelease.clear();
  apiBackoffUntilByRelease.clear();
  trackMetadataIndexByTrackId.clear();
  trackMetadataCandidatesByTrackId.clear();
  trackIdsByReleaseKey.clear();
  resolvedIdentityByTrackId.clear();
  triedReleaseKeysByTrackId.clear();
  nextProbeAtByTrackId.clear();
  lastProbeStateByTrackId.clear();
  lastProbeStateLogAtByTrackId.clear();
  strictDomProbeStateByTrackId.clear();
  warnedUnexpectedPayloadByRelease.clear();
  parentAlbumProbesByTrackId.clear();
  parentAlbumProbeRetryCount.clear();
  for (const timers of parentAlbumRetryTimersByTrackId.values()) {
    timers.forEach((timerId) => {
      window.clearTimeout(timerId);
    });
  }
  parentAlbumRetryTimersByTrackId.clear();
  cachedTrackArtistByTrackId.clear();
  trackArtistProbeInFlightByTrackId.clear();
  trackArtistNextProbeAtByTrackId.clear();
  ensureNextAllowedAtByKey.clear();
  albumIdentityByReleaseUrl.clear();
}
