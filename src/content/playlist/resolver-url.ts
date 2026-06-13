export function readTrackIdFromUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, window.location.href);
    const byQuery = String(parsed.searchParams.get('track_id') || parsed.searchParams.get('id') || '').trim();
    if (/^\d{4,}$/.test(byQuery)) {
      return byQuery;
    }

    const streamPath = parsed.pathname.match(/\/mp3-(?:128|v0|320)\/(\d{6,})/i);
    if (streamPath?.[1]) {
      return streamPath[1];
    }

    const numericTail = parsed.pathname.match(/\/(\d{6,})(?:\/)?$/);
    if (numericTail?.[1]) {
      return numericTail[1];
    }

    // stream_redirect URLs carry the track ID in the `track=` param. Check
    // this before the fallback numeric scan so timestamps and tokens that
    // appear earlier in the query string are not mistaken for a track ID.
    if (/\/stream_redirect\b/.test(parsed.pathname)) {
      const redirectTrack = parsed.searchParams.get('track');
      if (redirectTrack && /^\d{4,}$/.test(redirectTrack)) {
        return redirectTrack;
      }
    }
  } catch {
    // Ignore malformed URLs.
  }

  const fallback = raw.match(/(\d{6,})/g);
  return fallback?.[0] ?? '';
}

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function resolveStreamContentId(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    const match = parsed.pathname.match(/\/mp3-(?:128|v0|320)\/(\d{6,})/i);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Ignore malformed URL.
  }
  return readTrackIdFromUrl(url);
}
