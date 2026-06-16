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

// Byte-identical to the metadata-layer helpers; re-export the canonical ones so
// discover's id/type parsing can't drift from the rest of the content layer.
export { toIdString as toId, toTralbumType as toType } from '@/content/metadata/common';
