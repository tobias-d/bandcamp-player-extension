export function describePayloadShape(payload: unknown): string {
  if (payload === null) {
    return 'null';
  }
  if (typeof payload !== 'object') {
    return typeof payload;
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).slice(0, 10);
  return keys.length ? keys.join(',') : '(no-keys)';
}

export function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? '';
}

export function normalizeArtist(value: string): string {
  return value.replace(/^by\s+/i, '').trim();
}

export function normalizeArtistKey(value: string): string {
  return normalizeArtist(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripLabelSuffix(value: string): string {
  let current = value.trim();
  while (current) {
    const next = current.replace(
      /(records?|recordings?|recs?|label|music|band|collective|crew|sounds?|sound)$/i,
      ''
    ).trim();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function readTrackCompositeTitle(track: unknown): string {
  const record = asRecord(track);
  if (!record) {
    return '';
  }
  return String(
    record['full_title'] ??
      record['fullTitle'] ??
      record['title_with_artist'] ??
      record['titleWithArtist'] ??
      record['display_title'] ??
      record['displayTitle'] ??
      ''
  ).trim();
}

export function extractArtistFromCompositeTitle(compositeTitleRaw: string, plainTitleRaw: string): string {
  const compositeTitle = compositeTitleRaw.trim();
  const plainTitle = plainTitleRaw.trim();
  if (!compositeTitle || !plainTitle) {
    return '';
  }
  const compositeLower = compositeTitle.toLowerCase();
  const plainLower = plainTitle.toLowerCase();
  if (!compositeLower.endsWith(plainLower)) {
    return '';
  }
  const prefix = compositeTitle
    .slice(0, compositeTitle.length - plainTitle.length)
    .replace(/[-–—:\s]+$/g, '')
    .trim();
  const normalized = normalizeArtist(prefix);
  const normalizedKey = normalizeArtistKey(normalized);
  if (!normalized || normalizedKey === 'various artists' || normalizedKey === 'va') {
    return '';
  }
  return normalized;
}

export function looksLikeHumanArtistValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length < 2 || trimmed.length > 120) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'n/a' || lower === 'unknown' || lower === 'none') {
    return false;
  }
  return true;
}

export function isReleaseContext(): boolean {
  const { hostname, pathname } = window.location;
  if (pathname.includes('/album/') || pathname.includes('/track/') || pathname.includes('/music')) {
    return true;
  }
  return hostname !== 'bandcamp.com';
}

export function getNestedUnknown(obj: Record<string, unknown> | null, ...path: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) {
      return undefined;
    }
    cursor = record[key];
  }
  return cursor;
}

export function getNestedString(obj: Record<string, unknown> | null, ...path: string[]): string {
  const value = getNestedUnknown(obj, ...path);
  return typeof value === 'string' ? value.trim() : '';
}

export function collectStringByKey(
  root: Record<string, unknown> | null,
  keyNames: string[],
  maxDepth = 5
): string[] {
  if (!root) {
    return [];
  }

  const wanted = new Set(keyNames.map((name) => name.toLowerCase()));
  const queue: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const seen = new Set<unknown>();
  const results: string[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }
    const { node, depth } = next;
    if (!node || typeof node !== 'object') {
      continue;
    }
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      if (wanted.has(key.toLowerCase()) && (typeof value === 'string' || typeof value === 'number')) {
        const trimmed = String(value).trim();
        if (trimmed.length > 0) {
          results.push(trimmed);
        }
      }
    }

    if (depth >= maxDepth) {
      continue;
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') {
        queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return results;
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function selectAlbumCandidate(
  candidates: string[],
  trackTitle: string,
  artistName: string,
  allowTrackTitleMatch: boolean
): string {
  const normalizedTrack = normalizeKey(trackTitle);
  const normalizedArtist = normalizeKey(artistName);

  for (const candidate of candidates) {
    const normalized = normalizeKey(candidate);
    if (!normalized) {
      continue;
    }
    if (!allowTrackTitleMatch && normalizedTrack && normalized === normalizedTrack) {
      continue;
    }
    if (normalizedArtist && normalized === normalizedArtist) {
      continue;
    }
    return candidate.trim();
  }
  return '';
}

export function toIdString(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const match = raw.match(/\d+/);
  return match?.[0] ?? '';
}

export function toTralbumType(value: unknown): 'a' | 't' | '' {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'a' || raw === 'album') {
    return 'a';
  }
  if (raw === 't' || raw === 'track') {
    return 't';
  }
  return '';
}

export function readTrackIdFromUrl(url: string): string {
  const queryMatch = url.match(/[?&]track_id=(\d{4,})/i);
  if (queryMatch?.[1]) {
    return queryMatch[1];
  }

  try {
    const parsed = new URL(url, window.location.href);
    const trackParam = parsed.searchParams.get('track_id');
    if (trackParam && /^\d{4,}$/.test(trackParam)) {
      return trackParam;
    }

    const streamPathMatch = parsed.pathname.match(/\/mp3-[^/]+\/(\d{6,})(?:\/|$)/i);
    if (streamPathMatch?.[1]) {
      return streamPathMatch[1];
    }

    // stream_redirect URLs use `track=TRACKID` (no underscore). Extract it
    // explicitly here so the fallback numeric scan below does not pick up
    // a timestamp or token value that appears earlier in the URL.
    if (/\/stream_redirect\b/.test(parsed.pathname)) {
      const redirectTrack = parsed.searchParams.get('track');
      if (redirectTrack && /^\d{4,}$/.test(redirectTrack)) {
        return redirectTrack;
      }
    }
  } catch {
    // Ignore malformed URLs.
  }

  return '';
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeStreamMatchKey(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw, window.location.href);
    const base = `${parsed.origin}${parsed.pathname}`.toLowerCase();
    const trackId = readTrackIdFromUrl(raw);
    if (trackId) {
      return `${base}?track_id=${trackId}`;
    }
    return base;
  } catch {
    const lower = raw.toLowerCase();
    const trackId = readTrackIdFromUrl(raw);
    if (trackId) {
      return `${lower}?track_id=${trackId}`;
    }
    return lower;
  }
}

export function normalizeReleaseUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    if (!/\/(album|track)\//i.test(parsed.pathname)) {
      return '';
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    const raw = String(url || '').trim();
    if (!raw || !/\/(album|track)\//i.test(raw)) {
      return '';
    }
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

export function isBandcampReleaseUrl(url: string): boolean {
  const normalized = normalizeReleaseUrl(url);
  if (!normalized) {
    return false;
  }
  try {
    const parsed = new URL(normalized, window.location.href);
    return parsed.hostname === 'bandcamp.com' || parsed.hostname.endsWith('.bandcamp.com');
  } catch {
    return false;
  }
}

export function isHttpsReleasePageUrl(url: string): boolean {
  const normalized = normalizeReleaseUrl(url);
  if (!normalized) {
    return false;
  }
  try {
    return new URL(normalized, window.location.href).protocol === 'https:';
  } catch {
    return false;
  }
}
