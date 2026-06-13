import type { PlaylistState, PlaylistTrack } from '@/shared/types';
import type { DiscoverNowPlaying } from '@/content/discover/metadata';
import {
  findDirectionalPlayableIndex,
  isTrackPlayable
} from '@/content/playlist/track-navigation';
import { readTrackIdFromUrl, normalizeUrl } from '@/content/playlist/resolver';
import { buildTrackCacheKey } from '@/content/playlist/track-identity';

export function isApiMetadataSource(source: string): boolean {
  const value = String(source || '').trim();
  return (
    value.startsWith('TralbumAPI') ||
    value.startsWith('TralbumData') ||
    value.startsWith('ApiCache')
  );
}

export function hasDiscoverApiFastPathHints(nowPlaying: DiscoverNowPlaying): boolean {
  const trackId = readTrackIdFromUrl(String(nowPlaying.streamUrl || '').trim()) || String(nowPlaying.trackId || '').trim();
  if (!trackId) {
    return false;
  }
  const releaseUrl = String(nowPlaying.releaseUrl || '').trim();
  if (!releaseUrl) {
    return false;
  }
  return /^https?:\/\/[^/]+\/(album|track)\//i.test(releaseUrl);
}

export function readFetchGateReason(fetchGateDebug: string): string {
  const raw = String(fetchGateDebug || '').trim();
  if (!raw) {
    return 'none';
  }
  const match = raw.match(/\breason=([^\s]+)/);
  return match?.[1] ? String(match[1]).trim() : 'none';
}

const TIMED_FETCH_GATE_REASONS = new Set([
  'global-backoff',
  'message-failed',
  'min-interval',
  'release-backoff'
]);

export function readFetchGateRetryDelayMs(fetchGateDebug: string): number {
  const reason = readFetchGateReason(fetchGateDebug);
  if (!TIMED_FETCH_GATE_REASONS.has(reason)) {
    return 0;
  }
  const raw = String(fetchGateDebug || '').trim();
  const match = raw.match(/\bremain=(\d+)ms/);
  const remainingMs = match?.[1] ? Number.parseInt(match[1], 10) : 0;
  return Number.isFinite(remainingMs) && remainingMs > 0 ? remainingMs : 0;
}

export function buildDiscoverTrackKey(nowPlaying: DiscoverNowPlaying): string {
  const streamUrl = String(nowPlaying.streamUrl || '').trim();
  const releaseUrl = String(nowPlaying.releaseUrl || '').trim().toLowerCase();
  const streamTrackId = readTrackIdFromUrl(streamUrl);
  const trackId = String(nowPlaying.trackId || streamTrackId || nowPlaying.identity?.trackId || '').trim();

  let streamPath = '';
  if (streamUrl) {
    try {
      const parsed = new URL(streamUrl, window.location.href);
      streamPath = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    } catch {
      streamPath = streamUrl.toLowerCase();
    }
  }

  const identityKey = nowPlaying.identity
    ? [
        String(nowPlaying.identity.bandId || '').trim(),
        String(nowPlaying.identity.tralbumId || '').trim(),
        String(nowPlaying.identity.tralbumType || '').trim(),
        String(nowPlaying.identity.trackId || '').trim()
      ].join(':')
    : '';

  return [
    trackId || '-',
    releaseUrl || '-',
    identityKey || '-',
    streamPath || '-'
  ].join('|');
}

export function isDiscoverPlaylistUnresolved(source: string, playlist: PlaylistState): boolean {
  const normalizedSource = String(source || '').trim();
  if (!playlist.tracks.length) {
    return true;
  }
  if (!normalizedSource) {
    return true;
  }
  return normalizedSource.startsWith('none') || normalizedSource.includes('(stale-track)');
}

export function withCurrentPlaylistIndex(playlist: PlaylistState, nextIndex: number): PlaylistState {
  if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= playlist.tracks.length) {
    return playlist;
  }
  return {
    ...playlist,
    currentIndex: nextIndex,
    tracks: playlist.tracks.map((track, index) => ({
      ...track,
      isCurrent: index === nextIndex
    }))
  };
}

export { findDirectionalPlayableIndex, isTrackPlayable };

export function deriveSyntheticStreamUrl(currentSrc: string, targetTrackId: string): string {
  const trackId = String(targetTrackId || '').trim();
  const source = String(currentSrc || '').trim();
  if (!trackId) {
    return '';
  }

  if (source) {
    try {
      const parsed = new URL(source);
      parsed.searchParams.set('track_id', trackId);
      parsed.searchParams.delete('trackid');
      return parsed.toString();
    } catch {
      // Fall through to canonical stream template.
    }
  }

  return `https://bandcamp.com/stream_redirect?enc=mp3-128&track_id=${encodeURIComponent(trackId)}`;
}

export function resolveTrackCacheKey(track: PlaylistTrack): string {
  return (
    buildTrackCacheKey(track, String(track.streamUrl || '').trim(), {
      normalizeUrlForCache: normalizeUrl
    }) || ''
  );
}

export function mergeDiscoverPlaybackQuery(targetUrl: string, currentSrc: string): string {
  const targetRaw = String(targetUrl || '').trim();
  const currentRaw = String(currentSrc || '').trim();
  if (!targetRaw || !currentRaw) {
    return targetRaw;
  }

  try {
    const target = new URL(targetRaw, window.location.href);
    if (target.searchParams.toString()) {
      return target.toString();
    }
    const current = new URL(currentRaw, window.location.href);
    for (const key of ['p', 'ts', 't', 'token']) {
      const value = current.searchParams.get(key);
      if (value) {
        target.searchParams.set(key, value);
      }
    }
    return target.toString();
  } catch {
    return targetRaw;
  }
}
