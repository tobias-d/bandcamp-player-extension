import { isReleaseContext, readTrackIdFromUrl } from '@/content/metadata/common';
import { getLikelyCurrentSrc } from '@/content/metadata/extractor/audio';
import type { ReleaseIdentity } from '@/content/metadata/release';
import { releaseKey } from '@/content/metadata/identity';

export function addIdentity(identities: ReleaseIdentity[], seen: Set<string>, identity: ReleaseIdentity | null): void {
  if (!identity) {
    return;
  }
  const key = releaseKey(identity);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  identities.push(identity);
}

export function addIdentityWithRootTypeVariants(
  identities: ReleaseIdentity[],
  seen: Set<string>,
  identity: ReleaseIdentity | null
): void {
  if (!identity) {
    return;
  }
  addIdentity(identities, seen, identity);
  if (isReleaseContext()) {
    return;
  }
  const altType: 'a' | 't' = identity.tralbumType === 'a' ? 't' : 'a';
  addIdentity(identities, seen, {
    bandId: identity.bandId,
    tralbumId: identity.tralbumId,
    tralbumType: altType
  });
}

export function addDomIdentityWithLinkedPreference(
  identities: ReleaseIdentity[],
  seen: Set<string>,
  identity: ReleaseIdentity | null,
  linkedReleaseUrl: string
): void {
  if (!identity) {
    return;
  }
  const linkedIsAlbum = linkedReleaseUrl.includes('/album/');
  const linkedIsTrack = linkedReleaseUrl.includes('/track/');
  const activeTrackId = readTrackIdFromUrl(getLikelyCurrentSrc());
  const domIsTrackScoped =
    identity.tralbumType === 't' &&
    Boolean(activeTrackId) &&
    identity.tralbumId === activeTrackId;
  if (!isReleaseContext() && linkedIsAlbum && identity.tralbumType === 't') {
    if (!domIsTrackScoped) {
      addIdentity(identities, seen, {
        bandId: identity.bandId,
        tralbumId: identity.tralbumId,
        tralbumType: 'a'
      });
    }
    addIdentity(identities, seen, identity);
    return;
  }
  if (!isReleaseContext() && linkedIsTrack && identity.tralbumType === 'a') {
    addIdentity(identities, seen, {
      bandId: identity.bandId,
      tralbumId: identity.tralbumId,
      tralbumType: 't'
    });
    addIdentity(identities, seen, identity);
    return;
  }
  addIdentityWithRootTypeVariants(identities, seen, identity);
}

export function prioritizeByLinkedRelease(identities: ReleaseIdentity[], linkedReleaseUrl: string): ReleaseIdentity[] {
  if (!identities.length) {
    return identities;
  }
  if (linkedReleaseUrl.includes('/album/')) {
    const albums = identities.filter((identity) => identity.tralbumType === 'a');
    const tracks = identities.filter((identity) => identity.tralbumType === 't');
    return [...albums, ...tracks];
  }
  if (linkedReleaseUrl.includes('/track/')) {
    const tracks = identities.filter((identity) => identity.tralbumType === 't');
    const albums = identities.filter((identity) => identity.tralbumType === 'a');
    return [...tracks, ...albums];
  }
  return identities;
}

export function narrowRootProbeCandidates(
  identities: ReleaseIdentity[],
  domIdentity: ReleaseIdentity | null,
  linkedReleaseUrl: string,
  rootProbeCandidateCap: number,
  rootProbeDomPriorityCap: number
): ReleaseIdentity[] {
  const prioritized = prioritizeByLinkedRelease(identities, linkedReleaseUrl);
  if (!prioritized.length) {
    return prioritized;
  }

  if (!domIdentity) {
    return prioritized.slice(0, rootProbeCandidateCap);
  }

  const domMatches = prioritized.filter(
    (identity) => identity.bandId === domIdentity.bandId && identity.tralbumId === domIdentity.tralbumId
  );
  if (!domMatches.length) {
    return prioritized.slice(0, rootProbeCandidateCap);
  }

  const domSet = new Set(domMatches.map((identity) => releaseKey(identity)));
  const remainder = prioritized.filter((identity) => !domSet.has(releaseKey(identity)));
  return [...domMatches, ...remainder].slice(0, rootProbeDomPriorityCap);
}
