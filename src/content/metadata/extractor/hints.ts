import { getRecentApiIdentityHints } from '@/content/discover/origin-bridge';
import {
  normalizeReleaseUrl,
  toIdString
} from '@/content/metadata/common';
import { releaseKey } from '@/content/metadata/identity';
import type { ReleaseIdentity } from '@/content/metadata/release';

export function collectApiHintCandidates(
  currentTrackId = '',
  linkedReleaseUrl = '',
  maxAgeMs = 5 * 60 * 1000
): ReleaseIdentity[] {
  const hints = getRecentApiIdentityHints(maxAgeMs);
  const seen = new Set<string>();
  const candidates: ReleaseIdentity[] = [];
  const normalizedLinkedRelease = normalizeReleaseUrl(linkedReleaseUrl);
  const trackBoundHints = currentTrackId
    ? hints.filter((hint) => String(hint.trackId ?? '') === currentTrackId)
    : [];
  const genericHints = hints.filter((hint) => !hint.trackId);
  const matchesLinkedRelease = (hint: { url: string }): boolean => {
    if (!normalizedLinkedRelease) {
      return false;
    }
    return normalizeReleaseUrl(hint.url) === normalizedLinkedRelease;
  };
  const trackBoundLinked = trackBoundHints.filter(matchesLinkedRelease);
  const genericLinked = genericHints.filter(matchesLinkedRelease);
  const orderedHints: typeof hints = [];
  const seenHintKeys = new Set<string>();
  const appendBucket = (bucket: typeof hints): void => {
    bucket
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .forEach((hint) => {
        const hintKey = [
          toIdString(hint.bandId),
          toIdString(hint.tralbumId),
          String(hint.tralbumType || '').trim(),
          String(hint.trackId || '').trim(),
          normalizeReleaseUrl(String(hint.url || ''))
        ].join(':');
        if (seenHintKeys.has(hintKey)) {
          return;
        }
        seenHintKeys.add(hintKey);
        orderedHints.push(hint);
      });
  };

  // Keep release-linked hints first so discover page switches are not starved by unrelated recent hints.
  appendBucket(trackBoundLinked);
  appendBucket(genericLinked);
  appendBucket(trackBoundHints);
  appendBucket(genericHints);
  appendBucket(hints);

  orderedHints
    .slice(0, 48)
    .forEach((hint) => {
      const bandId = toIdString(hint.bandId);
      const tralbumId = toIdString(hint.tralbumId);
      if (!bandId || !tralbumId) {
        return;
      }

      const typeCandidates: Array<'a' | 't'> =
        hint.tralbumType === 'a' || hint.tralbumType === 't' ? [hint.tralbumType] : ['a', 't'];

      typeCandidates.forEach((tralbumType) => {
        const identity: ReleaseIdentity = { bandId, tralbumId, tralbumType };
        const key = releaseKey(identity);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        candidates.push(identity);
      });
    });

  return candidates;
}
