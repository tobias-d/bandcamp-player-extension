import type { PayloadTrackQuality } from '@/background/handlers/tralbum/payload-types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asTrackArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>;
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
    const clock = parseClockDurationToSeconds(text);
    return clock > 0 ? clock : 0;
  }

  if (!candidate || typeof candidate !== 'object' || depth >= 3) {
    return 0;
  }

  const record = candidate as Record<string, unknown>;
  const nestedCandidates: unknown[] = [
    record.duration,
    record.duration_sec,
    record.durationSecs,
    record.duration_seconds,
    record.duration_ms,
    record.durationMs,
    record.length,
    record.length_sec,
    record.track_duration,
    record.time,
    record.seconds,
    record.secs,
    record.sec,
    record.ms,
    record.milliseconds,
    record.value
  ];

  for (const nested of nestedCandidates) {
    const parsed = parseDurationCandidate(nested, depth + 1);
    if (parsed > 0) {
      return parsed;
    }
  }

  return 0;
}

function readDurationSec(track: Record<string, unknown>): number {
  const file = asRecord(track.file);
  const candidates: unknown[] = [
    track.duration,
    track.duration_sec,
    track.durationSecs,
    track.duration_seconds,
    track.duration_ms,
    track.durationMs,
    track.length,
    track.length_sec,
    track.track_duration,
    track.time,
    track.seconds,
    track.secs,
    file?.duration,
    file?.duration_ms,
    file?.durationMs
  ];

  for (const candidate of candidates) {
    const parsed = parseDurationCandidate(candidate);
    if (parsed > 0) {
      return parsed;
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
    const parsed = parseDurationCandidate(value);
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
  return stream.length > 0;
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
