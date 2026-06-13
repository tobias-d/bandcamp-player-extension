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

export function normalizeUrl(value: unknown): string {
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

export function toId(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const match = raw.match(/\d+/);
  return match?.[0] ?? '';
}

export function toType(value: unknown): 'a' | 't' | '' {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'a' || raw === 'album') {
    return 'a';
  }
  if (raw === 't' || raw === 'track') {
    return 't';
  }
  return '';
}
