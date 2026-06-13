import { getRecentApiIdentityHints } from '@/content/discover/origin-bridge';
import { normalizeReleaseUrl, normalizeUrl } from '@/content/discover/metadata/normalize';
import type { DiscoverIdentity } from '@/content/discover/metadata/types';

export function pickApiIdentity(trackIdHint: string, releaseUrlHint: string): DiscoverIdentity | null {
  const trackId = String(trackIdHint || '').trim();
  const releaseUrl = normalizeReleaseUrl(releaseUrlHint);
  const hints = getRecentApiIdentityHints(5 * 60 * 1000).slice().sort((a, b) => b.ts - a.ts);
  if (!hints.length) {
    return null;
  }

  const pickFrom = (items: typeof hints): DiscoverIdentity | null => {
    for (const hint of items) {
      const bandId = String(hint.bandId || '').trim();
      const tralbumId = String(hint.tralbumId || '').trim();
      const tralbumType = hint.tralbumType === 't' ? 't' : 'a';
      if (!bandId || !tralbumId) {
        continue;
      }
      return {
        bandId,
        tralbumId,
        tralbumType,
        trackId: String(hint.trackId || '').trim(),
        url: normalizeReleaseUrl(hint.url) || normalizeUrl(hint.url)
      };
    }
    return null;
  };

  // The playing track id is the authoritative key. A release-url match is a
  // weaker association that can be wrong for custom-domain releases: a stale or
  // foreign hint can map the same release url to a different band/album. When we
  // know the track, only trust a hint that actually carries that track id; if
  // none exists yet, return null and let the authoritative discover API payload
  // resolve the identity, instead of locking onto a release-only identity whose
  // album may not even contain the current track.
  if (trackId) {
    return pickFrom(hints.filter((hint) => String(hint.trackId || '').trim() === trackId));
  }

  if (releaseUrl) {
    return pickFrom(hints.filter((hint) => normalizeReleaseUrl(hint.url) === releaseUrl));
  }

  return pickFrom(hints);
}
