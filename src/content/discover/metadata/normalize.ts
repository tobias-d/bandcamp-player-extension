export function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeTextKey(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

export function normalizeReleaseUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw, window.location.href);
    if (!/\/(album|track)\//i.test(parsed.pathname)) {
      return '';
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return '';
  }
}

// Discover keeps the FULL URL (query + hash) — deliberately different from the
// canonical normalizeUrl in @/utils/url, which drops the query and returns only
// origin+pathname. Discover stream URLs carry the track id / token in the query,
// so they must survive. Distinct name so the two are never merged by mistake.
export function normalizeFullUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw, window.location.href).toString();
  } catch {
    return '';
  }
}

export function readTrackIdFromUrl(url: string): string {
  const raw = String(url || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, window.location.href);
    const streamPathMatch = parsed.pathname.match(/\/mp3-(?:128|v0|320)\/(\d{6,})(?:\/|$)/i);
    if (streamPathMatch?.[1]) {
      return streamPathMatch[1];
    }
    const trackParam = parsed.searchParams.get('track_id') || parsed.searchParams.get('id');
    if (trackParam && /^\d{4,}$/.test(trackParam)) {
      return trackParam;
    }
  } catch {
    // Ignore malformed URLs.
  }

  const pathMatch = raw.match(/(\d{6,})/g);
  if (!pathMatch?.length) {
    return '';
  }
  return pathMatch[0] ?? '';
}

// Byte-identical to the metadata-layer helpers; re-export the canonical ones so
// discover's id/type parsing can't drift from the rest of the content layer.
export { toIdString as toId, toTralbumType as toType } from '@/content/metadata/common';
