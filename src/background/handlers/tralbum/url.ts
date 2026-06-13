export function normalizeUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) {
    return '';
  }

  try {
    return new URL(value).toString();
  } catch {
    return '';
  }
}

export function isLikelyReleaseUrl(raw: string): boolean {
  const value = normalizeUrl(raw);
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return false;
    }

    return /\/(album|track)\//i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isBandcampUrl(raw: string): boolean {
  const value = normalizeUrl(raw);
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.hostname === 'bandcamp.com' || parsed.hostname.endsWith('.bandcamp.com');
  } catch {
    return false;
  }
}

export function extractCanonicalReleaseUrlFromHtml(html: string, baseUrl: string): string {
  const source = String(html || '');
  if (!source) {
    return '';
  }

  const patterns = [
    /<link[^>]*rel=["']canonical["'][^>]*href=(["'])([\s\S]*?)\1[^>]*>/i,
    /<meta[^>]*property=["']og:url["'][^>]*content=(["'])([\s\S]*?)\1[^>]*>/i,
    /<meta[^>]*content=(["'])([\s\S]*?)\1[^>]*property=["']og:url["'][^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const rawHref = String(match?.[2] || '').trim();
    if (!rawHref) {
      continue;
    }

    try {
      const resolved = new URL(rawHref, baseUrl).toString();
      if (isLikelyReleaseUrl(resolved)) {
        return resolved;
      }
    } catch {
      // Ignore malformed canonical values.
    }
  }

  return '';
}

export function parseOriginFromUrl(urlRaw: string): string {
  try {
    const parsed = new URL(urlRaw);
    return parsed.origin;
  } catch {
    return 'https://bandcamp.com';
  }
}
