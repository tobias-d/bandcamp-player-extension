// NOTE: This is the *forgiving* track-id reader (numeric-tail + loose digit
// scan + `id` param) used by the playlist/discover layers to match as many URL
// shapes as possible. The metadata layer deliberately uses a STRICTER reader
// (src/content/metadata/common.ts) that omits the loose scan so a timestamp or
// token can never be mistaken for a track id during identity resolution. Do not
// merge the two into one without re-validating identity strictness.
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

export { normalizeUrl } from '@/utils/url';

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
