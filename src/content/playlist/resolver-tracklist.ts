import type { PlaylistTrack, TrackReleaseDate } from '@/shared/types';
import { normalizeUrl, readTrackIdFromUrl } from '@/content/playlist/resolver-url';
import { isHttpsReleasePageUrl, normalizeReleaseUrl } from '@/content/metadata/common';

export interface TralbumRecord {
  current?: { title?: string };
  artist?: string;
  album_title?: string;
  albumTitle?: string;
  title?: string;
  trackinfo?: Array<Record<string, unknown>>;
  tracks?: Array<Record<string, unknown>>;
}

function normalizeBandcampPageUrl(value: unknown, requiredPath: 'album' | 'track', baseUrl = ''): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const candidate = baseUrl
    ? (() => {
        try {
          return new URL(raw, baseUrl).toString();
        } catch {
          return raw;
        }
      })()
    : raw;
  const normalized = normalizeReleaseUrl(candidate);
  if (!normalized || !normalized.includes(`/${requiredPath}/`)) {
    return '';
  }
  return isHttpsReleasePageUrl(normalized) ? normalized : '';
}

function firstBandcampPageUrl(requiredPath: 'album' | 'track', baseUrl: string, ...values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeBandcampPageUrl(value, requiredPath, baseUrl);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function readBandcampBaseUrl(record: Record<string, unknown> | null | undefined): string {
  if (!record) {
    return '';
  }
  const candidates = [
    record.url,
    record.link,
    record.item_url,
    record.itemUrl,
    record.title_link,
    record.titleLink,
    record.track_url,
    record.trackUrl,
    record.album_url,
    record.albumUrl,
    record.release_url,
    record.releaseUrl,
    record.tralbum_url,
    record.tralbumUrl,
    record.bandcamp_url,
    record.bandcampUrl
  ];
  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim();
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') {
        continue;
      }
      const normalized = normalizeReleaseUrl(parsed.toString());
      if (normalized && isHttpsReleasePageUrl(normalized)) {
        return normalized;
      }
    } catch {
      // Relative release URLs need an absolute Bandcamp URL from the same payload as their base.
    }
  }
  return '';
}

function readTrackPageUrl(
  trackRaw: Record<string, unknown>,
  secondary?: Record<string, unknown> | null,
  releasePageUrl = ''
): string {
  const baseUrl = readBandcampBaseUrl(trackRaw) || readBandcampBaseUrl(secondary) || releasePageUrl;
  return firstBandcampPageUrl(
    'track',
    baseUrl,
    trackRaw.title_link,
    trackRaw.titleLink,
    trackRaw.track_url,
    trackRaw.trackUrl,
    trackRaw.item_url,
    trackRaw.itemUrl,
    trackRaw.bandcamp_url,
    trackRaw.bandcampUrl,
    trackRaw.url,
    trackRaw.link,
    secondary?.title_link,
    secondary?.titleLink,
    secondary?.track_url,
    secondary?.trackUrl,
    secondary?.item_url,
    secondary?.itemUrl,
    secondary?.bandcamp_url,
    secondary?.bandcampUrl,
    secondary?.url,
    secondary?.link
  );
}

function readAlbumPageUrl(tralbumRecord: TralbumRecord | null): string {
  if (!tralbumRecord) {
    return '';
  }
  const values = tralbumRecord as Record<string, unknown>;
  const baseUrl = readBandcampBaseUrl(values);
  return firstBandcampPageUrl(
    'album',
    baseUrl,
    values.album_url,
    values.albumUrl,
    values.album_upsell_url,
    values.albumUpsellUrl,
    values.release_url,
    values.releaseUrl,
    values.tralbum_url,
    values.tralbumUrl,
    values.item_url,
    values.itemUrl,
    values.bandcamp_url,
    values.bandcampUrl,
    values.url,
    values.link
  );
}

export function resolveTralbumReleasePageUrl(
  tralbum: unknown,
  _primaryTrackinfo: Array<Record<string, unknown>> = [],
  _secondaryTrackinfo: Array<Record<string, unknown>> = []
): string {
  const tralbumRecord = asTralbumRecord(tralbum);
  const rootUrl = readAlbumPageUrl(tralbumRecord);
  if (rootUrl) {
    return rootUrl;
  }

  return normalizeBandcampPageUrl(window.location.href, 'album');
}

export function asTralbumRecord(value: unknown): TralbumRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as TralbumRecord;
}

export function getTrackLists(tralbum: unknown): {
  primary: Array<Record<string, unknown>>;
  secondary: Array<Record<string, unknown>>;
} {
  const tralbumRecord = asTralbumRecord(tralbum);
  if (!tralbumRecord) {
    return { primary: [], secondary: [] };
  }
  const trackinfo = Array.isArray(tralbumRecord.trackinfo) ? tralbumRecord.trackinfo : [];
  const tracks = Array.isArray(tralbumRecord.tracks) ? tralbumRecord.tracks : [];
  if (trackinfo.length > 0 && tracks.length > 0 && trackinfo !== tracks) {
    const trackinfoScore = scoreTracklistForPlayback(trackinfo);
    const tracksScore = scoreTracklistForPlayback(tracks);
    if (tracksScore > trackinfoScore) {
      return { primary: tracks, secondary: trackinfo };
    }
    return { primary: trackinfo, secondary: tracks };
  }
  if (trackinfo.length > 0) {
    return { primary: trackinfo, secondary: [] };
  }
  if (tracks.length > 0) {
    return { primary: tracks, secondary: [] };
  }
  return { primary: [], secondary: [] };
}

function parseClockDurationToSeconds(value: string): number {
  const text = value.trim();
  if (!text) {
    return 0;
  }
  const parts = text.split(':').map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part.length === 0)) {
    return 0;
  }
  const numeric = parts.map((part) => Number(part));
  if (numeric.some((part) => !Number.isFinite(part) || part < 0)) {
    return 0;
  }
  if (parts.length === 2) {
    const [minutes, seconds] = numeric;
    return minutes * 60 + seconds;
  }
  const [hours, minutes, seconds] = numeric;
  return hours * 3600 + minutes * 60 + seconds;
}

function readStreamUrlFromTrack(trackRaw: Record<string, unknown>): string {
  const isLikelyStreamUrl = (value: unknown): value is string => {
    if (typeof value !== 'string') {
      return false;
    }
    const raw = value.trim();
    if (!raw) {
      return false;
    }
    if (/^https?:\/\//i.test(raw) === false) {
      return false;
    }
    return (
      /stream_redirect/i.test(raw) ||
      /\/stream/i.test(raw) ||
      /\.mp3(\?|$)/i.test(raw) ||
      /\.m4a(\?|$)/i.test(raw) ||
      /\.ogg(\?|$)/i.test(raw)
    );
  };

  const readNestedStream = (candidate: unknown, depth = 0): string => {
    if (!candidate || depth > 3) {
      return '';
    }
    if (isLikelyStreamUrl(candidate)) {
      return candidate.trim();
    }
    if (typeof candidate !== 'object') {
      return '';
    }

    const record = candidate as Record<string, unknown>;
    // Prefer mp3-v0 when present: the authenticated TralbumAPI exposes per-track
    // v0 URLs for owned albums, so an owned album streams entirely in v0 (better
    // quality). v0 is absent for non-owned tracks, so they fall back to mp3-128
    // (the universal encoding) — no ownership gating needed.
    const preferredKeys = [
      'mp3-v0',
      'mp3-128',
      'mp3-320',
      'mp3v0',
      'mp3128',
      'mp3320',
      'stream_url',
      'streamUrl',
      'streaming_url',
      'streamingUrl',
      'url',
      'href',
      'src'
    ];

    for (const key of preferredKeys) {
      const value = record[key];
      if (!value) {
        continue;
      }
      const resolved = readNestedStream(value, depth + 1);
      if (resolved) {
        return resolved;
      }
    }

    for (const value of Object.values(record)) {
      const resolved = readNestedStream(value, depth + 1);
      if (resolved) {
        return resolved;
      }
    }
    return '';
  };

  const file = (trackRaw.file ?? null) as Record<string, unknown> | null;
  const streaming = (trackRaw.streaming_url ?? trackRaw.streamingUrl ?? null) as
    | string
    | Record<string, unknown>
    | null;
  if (file && typeof file === 'object') {
    const fromFile = readNestedStream(file);
    if (fromFile) {
      return fromFile;
    }
  }
  if (typeof streaming === 'string') {
    const raw = streaming.trim();
    if (raw) {
      return raw;
    }
  }
  if (streaming && typeof streaming === 'object') {
    const fromObject = readNestedStream(streaming);
    if (fromObject) {
      return fromObject;
    }
  }
  const fallbackCandidates: unknown[] = [
    trackRaw.stream_url,
    trackRaw.streamUrl,
    trackRaw.stream,
    trackRaw.audio,
    trackRaw.audio_url,
    trackRaw.audioUrl,
    trackRaw.preview_url,
    trackRaw.previewUrl,
    trackRaw.url
  ];
  for (const candidate of fallbackCandidates) {
    const fromCandidate = readNestedStream(candidate);
    if (fromCandidate) {
      return fromCandidate;
    }
  }
  return '';
}

function parseDurationCandidate(candidate: unknown, depth = 0): number {
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    const numeric = candidate > 20_000 ? candidate / 1000 : candidate;
    return numeric > 0 ? numeric : 0;
  }

  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text) {
      return 0;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 20_000 ? numeric / 1000 : numeric;
    }
    const clockValue = parseClockDurationToSeconds(text);
    return clockValue > 0 ? clockValue : 0;
  }

  if (!candidate || typeof candidate !== 'object' || depth >= 3) {
    return 0;
  }

  const candidateRecord = candidate as Record<string, unknown>;
  const nestedCandidates: unknown[] = [
    candidateRecord.duration,
    candidateRecord.duration_sec,
    candidateRecord.durationSecs,
    candidateRecord.duration_seconds,
    candidateRecord.duration_ms,
    candidateRecord.durationMs,
    candidateRecord.length,
    candidateRecord.length_sec,
    candidateRecord.track_duration,
    candidateRecord.time,
    candidateRecord.seconds,
    candidateRecord.secs,
    candidateRecord.sec,
    candidateRecord.ms,
    candidateRecord.milliseconds,
    candidateRecord.value
  ];

  for (const nested of nestedCandidates) {
    const value = parseDurationCandidate(nested, depth + 1);
    if (value > 0) {
      return value;
    }
  }

  return 0;
}

function readDurationSec(trackRaw: Record<string, unknown>): number {
  const file = (trackRaw.file ?? null) as Record<string, unknown> | null;
  const fileDuration = file && typeof file === 'object' ? file.duration : null;
  const candidates: unknown[] = [
    trackRaw.duration,
    trackRaw.duration_sec,
    trackRaw.durationSecs,
    trackRaw.duration_seconds,
    trackRaw.duration_ms,
    trackRaw.durationMs,
    trackRaw.length,
    trackRaw.length_sec,
    trackRaw.track_duration,
    trackRaw.time,
    trackRaw.seconds,
    trackRaw.secs,
    fileDuration,
    file?.duration_ms,
    file?.durationMs
  ];

  for (const candidate of candidates) {
    const resolved = parseDurationCandidate(candidate);
    if (resolved > 0) {
      return resolved;
    }
  }

  for (const [key, value] of Object.entries(trackRaw)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const looksDurationLike =
      normalizedKey === 'time' ||
      normalizedKey === 'length' ||
      normalizedKey === 'seconds' ||
      normalizedKey === 'secs' ||
      normalizedKey.includes('duration');
    if (!looksDurationLike) {
      continue;
    }
    const resolved = parseDurationCandidate(value);
    if (resolved > 0) {
      return resolved;
    }
  }

  return 0;
}

function findSecondaryTrack(
  primaryTrack: Record<string, unknown>,
  primaryIndex: number,
  secondaryTrackinfo: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  if (!secondaryTrackinfo.length) {
    return null;
  }

  const primaryTrackId = String(primaryTrack.track_id ?? primaryTrack.id ?? '').trim();
  if (primaryTrackId) {
    const byTrackId = secondaryTrackinfo.find((track) => String(track.track_id ?? track.id ?? '').trim() === primaryTrackId);
    if (byTrackId) {
      return byTrackId;
    }
  }

  const primaryStreamUrl = readStreamUrlFromTrack(primaryTrack);
  const normalizedPrimaryStream = normalizeUrl(primaryStreamUrl);
  if (normalizedPrimaryStream) {
    const byStream = secondaryTrackinfo.find((track) => {
      const stream = readStreamUrlFromTrack(track);
      return stream.length > 0 && normalizeUrl(stream) === normalizedPrimaryStream;
    });
    if (byStream) {
      return byStream;
    }
  }

  const primaryTitle = String(primaryTrack.title ?? '').trim().toLowerCase();
  if (primaryTitle) {
    const byTitle = secondaryTrackinfo.find((track) => String(track.title ?? '').trim().toLowerCase() === primaryTitle);
    if (byTitle) {
      return byTitle;
    }
  }

  return secondaryTrackinfo[primaryIndex] ?? null;
}

export function buildTrackRows(
  primaryTrackinfo: Array<Record<string, unknown>>,
  includePageUrl = false,
  secondaryTrackinfo: Array<Record<string, unknown>> = [],
  metadataHints: { artistName?: string; albumTitle?: string } = {},
  releasePageUrl = '',
  releaseDate?: TrackReleaseDate
): PlaylistTrack[] {
  const hintedArtist = String(metadataHints.artistName || '').trim();
  const hintedAlbum = String(metadataHints.albumTitle || '').trim();
  const firstNonEmpty = (...values: unknown[]): string => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) {
        return text;
      }
    }
    return '';
  };
  return primaryTrackinfo.map((trackRaw, index) => {
    const secondary = findSecondaryTrack(trackRaw, index, secondaryTrackinfo);
    const title = String(trackRaw.title ?? secondary?.title ?? `Track ${index + 1}`);
    const artistName = firstNonEmpty(
      trackRaw.artist,
      trackRaw.artist_name,
      trackRaw.artistName,
      trackRaw.band_name,
      trackRaw.bandName,
      secondary?.artist,
      secondary?.artist_name,
      secondary?.artistName,
      secondary?.band_name,
      secondary?.bandName,
      hintedArtist
    );
    const albumTitle = firstNonEmpty(
      trackRaw.album_title,
      trackRaw.albumTitle,
      trackRaw.release_title,
      secondary?.album_title,
      secondary?.albumTitle,
      secondary?.release_title,
      hintedAlbum
    );
    const durationSec = readDurationSec(trackRaw) || (secondary ? readDurationSec(secondary) : 0);
    const trackId = String(trackRaw.track_id ?? trackRaw.id ?? secondary?.track_id ?? secondary?.id ?? '');
    const streamUrl = readStreamUrlFromTrack(trackRaw) || (secondary ? readStreamUrlFromTrack(secondary) : '');
    const pageUrl = includePageUrl ? readTrackPageUrl(trackRaw, secondary, releasePageUrl) : '';

    return {
      index,
      title,
      artistName: artistName || undefined,
      albumTitle: albumTitle || undefined,
      ...(releaseDate ? { releaseDate } : {}),
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      isCurrent: false,
      trackId: trackId || readTrackIdFromUrl(streamUrl),
      streamUrl,
      pageUrl,
      cacheKey: trackId || streamUrl || pageUrl || `${index}`
    };
  });
}

function countTracksWithDuration(tracklist: Array<Record<string, unknown>>): number {
  return tracklist.reduce((count, trackRaw) => (readDurationSec(trackRaw) > 0 ? count + 1 : count), 0);
}

function countTracksWithStream(tracklist: Array<Record<string, unknown>>): number {
  return tracklist.reduce((count, trackRaw) => {
    const stream = readStreamUrlFromTrack(trackRaw);
    return stream ? count + 1 : count;
  }, 0);
}

function scoreTracklistForPlayback(tracklist: Array<Record<string, unknown>>): number {
  if (!tracklist.length) {
    return -1;
  }
  const streamCount = countTracksWithStream(tracklist);
  const durationCount = countTracksWithDuration(tracklist);
  const streamCoverage = streamCount / tracklist.length;
  const durationCoverage = durationCount / tracklist.length;
  // Match background normalization priority: stream coverage first.
  return (
    Math.round(streamCoverage * 1_000_000) +
    Math.round(durationCoverage * 100_000) +
    streamCount * 1_000 +
    durationCount * 100 +
    tracklist.length
  );
}
