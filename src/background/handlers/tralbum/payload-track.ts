import type { PayloadTrackQuality } from '@/background/handlers/tralbum/payload-types';
import { asRecord, asTrackArray } from '@/background/handlers/tralbum/identity';

// A payload is "covered" for a field once at least 60% of its tracks carry it.
// ceil(0.6 * count) is always <= count for count >= 1, so no clamp is needed.
export function minExpectedCoverage(trackCount: number): number {
  return Math.ceil(trackCount * 0.6);
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
    return numeric[0] * 60 + numeric[1];
  }
  return numeric[0] * 3600 + numeric[1] * 60 + numeric[2];
}

// Bandcamp durations are seconds; only *_ms / ms / milliseconds keys are
// milliseconds. Tagging each key with its unit avoids guessing from magnitude,
// which mis-scaled short clips with explicit ms fields (e.g. 15000ms read as
// 15000s) and long mixes over ~5.5h (read as ms and divided).
type DurationUnit = 'sec' | 'ms' | 'auto';

const NESTED_DURATION_KEYS: ReadonlyArray<readonly [string, DurationUnit]> = [
  ['duration', 'sec'],
  ['duration_sec', 'sec'],
  ['durationSecs', 'sec'],
  ['duration_seconds', 'sec'],
  ['duration_ms', 'ms'],
  ['durationMs', 'ms'],
  ['length', 'sec'],
  ['length_sec', 'sec'],
  ['track_duration', 'sec'],
  ['time', 'sec'],
  ['seconds', 'sec'],
  ['secs', 'sec'],
  ['sec', 'sec'],
  ['ms', 'ms'],
  ['milliseconds', 'ms'],
  ['value', 'auto']
];

function normalizeDurationNumber(value: number, unit: DurationUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (unit === 'ms') {
    return value / 1000;
  }
  if (unit === 'sec') {
    return value;
  }
  // Unit unknown (generic non-duration-named field): assume seconds, dividing
  // only implausibly large values as a milliseconds last resort.
  return value > 20_000 ? value / 1000 : value;
}

function parseDurationCandidate(candidate: unknown, unit: DurationUnit = 'auto', depth = 0): number {
  if (typeof candidate === 'number') {
    return normalizeDurationNumber(candidate, unit);
  }

  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text) {
      return 0;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric > 0) {
      return normalizeDurationNumber(numeric, unit);
    }
    const clock = parseClockDurationToSeconds(text);
    return clock > 0 ? clock : 0;
  }

  if (!candidate || typeof candidate !== 'object' || depth >= 3) {
    return 0;
  }

  const record = candidate as Record<string, unknown>;
  for (const [key, keyUnit] of NESTED_DURATION_KEYS) {
    const parsed = parseDurationCandidate(record[key], keyUnit, depth + 1);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

const TRACK_DURATION_KEYS: ReadonlyArray<readonly [string, DurationUnit]> = [
  ['duration', 'sec'],
  ['duration_sec', 'sec'],
  ['durationSecs', 'sec'],
  ['duration_seconds', 'sec'],
  ['duration_ms', 'ms'],
  ['durationMs', 'ms'],
  ['length', 'sec'],
  ['length_sec', 'sec'],
  ['track_duration', 'sec'],
  ['time', 'sec'],
  ['seconds', 'sec'],
  ['secs', 'sec']
];

const FILE_DURATION_KEYS: ReadonlyArray<readonly [string, DurationUnit]> = [
  ['duration', 'sec'],
  ['duration_ms', 'ms'],
  ['durationMs', 'ms']
];

function readDurationSec(track: Record<string, unknown>): number {
  const file = asRecord(track.file);
  for (const [key, unit] of TRACK_DURATION_KEYS) {
    const parsed = parseDurationCandidate(track[key], unit);
    if (parsed > 0) {
      return parsed;
    }
  }
  if (file) {
    for (const [key, unit] of FILE_DURATION_KEYS) {
      const parsed = parseDurationCandidate(file[key], unit);
      if (parsed > 0) {
        return parsed;
      }
    }
  }

  for (const [key, value] of Object.entries(track)) {
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
    const unit: DurationUnit = normalizedKey.includes('ms') || normalizedKey.includes('millisecond') ? 'ms' : 'auto';
    const parsed = parseDurationCandidate(value, unit);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function hasDurationLikeValue(track: Record<string, unknown>): boolean {
  return readDurationSec(track) > 0;
}

function hasStreamLikeValue(track: Record<string, unknown>): boolean {
  const file = asRecord(track.file);
  const streaming = track['streaming_url'] ?? track['streamingUrl'];
  const stream = String(file?.['mp3-128'] ?? file?.['mp3-v0'] ?? file?.['mp3-320'] ?? '').trim();
  if (stream.length > 0) {
    return true;
  }
  if (typeof streaming === 'string') {
    return streaming.trim().length > 0;
  }
  if (streaming && typeof streaming === 'object') {
    const record = streaming as Record<string, unknown>;
    const nested = String(record['mp3-128'] ?? record['mp3-v0'] ?? record['mp3-320'] ?? '').trim();
    return nested.length > 0;
  }
  return false;
}

function isDirectStreamUrl(url: string): boolean {
  const normalized = String(url || '').trim();
  if (!normalized) {
    return false;
  }
  return !/\/stream_redirect\b/i.test(normalized);
}

function hasDirectStreamLikeValue(track: Record<string, unknown>): boolean {
  const file = asRecord(track.file);
  const streaming = track['streaming_url'] ?? track['streamingUrl'];
  const stream = String(file?.['mp3-128'] ?? file?.['mp3-v0'] ?? file?.['mp3-320'] ?? '').trim();
  if (isDirectStreamUrl(stream)) {
    return true;
  }
  if (typeof streaming === 'string') {
    return isDirectStreamUrl(streaming.trim());
  }
  if (streaming && typeof streaming === 'object') {
    const record = streaming as Record<string, unknown>;
    const nested = String(record['mp3-128'] ?? record['mp3-v0'] ?? record['mp3-320'] ?? '').trim();
    return isDirectStreamUrl(nested);
  }
  return false;
}

function scoreTrackArray(tracklist: Array<Record<string, unknown>>): PayloadTrackQuality {
  if (tracklist.length === 0) {
    return {
      trackCount: 0,
      tracksWithDuration: 0,
      tracksWithStream: 0,
      tracksWithDirectStream: 0,
      score: -1
    };
  }

  const durationCount = tracklist.filter(hasDurationLikeValue).length;
  const streamCount = tracklist.filter(hasStreamLikeValue).length;
  const directStreamCount = tracklist.filter(hasDirectStreamLikeValue).length;
  const directStreamCoverage = directStreamCount / tracklist.length;
  const streamCoverage = streamCount / tracklist.length;
  const durationCoverage = durationCount / tracklist.length;
  return {
    trackCount: tracklist.length,
    tracksWithDuration: durationCount,
    tracksWithStream: streamCount,
    tracksWithDirectStream: directStreamCount,
    // Prefer arrays with routable stream URLs; track count alone is not enough
    // for transport control reliability on feed/collection pages.
    // Direct stream URLs beat tokenized /stream_redirect URLs because runtime
    // prewarm and takeover need a stable fetch target.
    score:
      Math.round(directStreamCoverage * 10_000_000) +
      Math.round(streamCoverage * 1_000_000) +
      Math.round(durationCoverage * 100_000) +
      directStreamCount * 10_000 +
      streamCount * 1_000 +
      durationCount * 100 +
      tracklist.length
  };
}

function buildTrackQuality(record: Record<string, unknown>): PayloadTrackQuality {
  const trackinfo = asTrackArray(record['trackinfo']);
  const tracks = asTrackArray(record['tracks']);
  const scoredTrackinfo = scoreTrackArray(trackinfo);
  const scoredTracks = scoreTrackArray(tracks);
  const primary = scoredTracks.score > scoredTrackinfo.score ? scoredTracks : scoredTrackinfo;
  if (primary.trackCount === 0) {
    return {
      trackCount: 0,
      tracksWithDuration: 0,
      tracksWithStream: 0,
      tracksWithDirectStream: 0,
      score: -1
    };
  }

  const hasBothArrays = trackinfo.length > 0 && tracks.length > 0 ? 1 : 0;
  return {
    trackCount: primary.trackCount,
    tracksWithDuration: primary.tracksWithDuration,
    tracksWithStream: primary.tracksWithStream,
    tracksWithDirectStream: primary.tracksWithDirectStream,
    score: primary.score + hasBothArrays
  };
}

function firstNonEmptyString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = String(record[key] ?? '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function scoreMetadataQuality(record: Record<string, unknown>): number {
  const albumLike = firstNonEmptyString(record, [
    'album_title',
    'albumTitle',
    'release_title',
    'releaseTitle',
    'item_title',
    'itemTitle'
  ]);
  const artistLike = firstNonEmptyString(record, ['artist', 'tralbum_artist', 'band_name', 'bandName']);
  const titleLike = firstNonEmptyString(record, ['title', 'name']);

  let score = 0;
  if (albumLike) {
    // Prefer payloads that carry release-level album metadata when track quality is comparable.
    score += 50_000;
  }
  if (artistLike) {
    score += 8_000;
  }
  if (titleLike) {
    score += 800;
  }
  return score;
}

function scoreTrackRecord(record: Record<string, unknown>): number {
  const trackQuality = buildTrackQuality(record);
  if (trackQuality.score < 0) {
    return -1;
  }
  return trackQuality.score + scoreMetadataQuality(record);
}

function findBestTrackRecord(payload: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  let scanned = 0;
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;

  while (queue.length > 0 && scanned < 10_000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }

    visited.add(node);
    scanned += 1;

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    const score = scoreTrackRecord(record);
    if (score > bestScore) {
      bestScore = score;
      best = record;
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return best;
}

export function hasTrackArrays(payload: unknown): boolean {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  let scanned = 0;

  while (queue.length > 0 && scanned < 5000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }

    visited.add(node);
    scanned += 1;

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    if (Array.isArray(record['trackinfo']) || Array.isArray(record['tracks'])) {
      return true;
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return false;
}

export function normalizePayloadData(payload: unknown): unknown {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    return payload;
  }

  const bestTrackRecord = findBestTrackRecord(payloadRecord);
  if (bestTrackRecord) {
    return bestTrackRecord;
  }

  return payload;
}

export function getPayloadTrackQuality(payload: unknown): PayloadTrackQuality {
  const payloadRecord = asRecord(payload);
  if (!payloadRecord) {
    return {
      trackCount: 0,
      tracksWithDuration: 0,
      tracksWithStream: 0,
      tracksWithDirectStream: 0,
      score: -1
    };
  }

  const candidate = findBestTrackRecord(payloadRecord) ?? payloadRecord;
  return buildTrackQuality(candidate);
}
