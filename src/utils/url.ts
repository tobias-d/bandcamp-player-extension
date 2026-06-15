// Canonical content-side URL normalizer: origin + pathname, lowercased, query
// and hash dropped. Shared so the playlist and metadata layers key URL-equality
// maps identically (they previously held byte-identical private copies that
// could drift). Content-only — relies on window.location.href for relative URLs.
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${parsed.origin}${parsed.pathname}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
