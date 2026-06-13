import type { PageGlobals } from '@/shared/types';
import { isReleaseContext } from '@/content/metadata/common';
import type { ReleaseIdentity } from '@/content/metadata/release';
import { releaseKey, toReleaseIdentity } from '@/content/metadata/identity';
import {
  addDomIdentityWithLinkedPreference,
  addIdentity,
  narrowRootProbeCandidates
} from '@/content/metadata/extractor/candidate-utils';
import { collectApiHintCandidates } from '@/content/metadata/extractor/hints';

export function buildProbeCandidates({
  trackId,
  linkedReleaseUrl,
  globals,
  linkedAlbumIdentity,
  currentResolved,
  continueAlbumResolution,
  domIdentity,
  intent,
  rootProbeCandidateCap,
  rootProbeDomPriorityCap
}: {
  trackId: string;
  linkedReleaseUrl: string;
  globals: PageGlobals | null;
  linkedAlbumIdentity: ReleaseIdentity | null;
  currentResolved: ReleaseIdentity | null;
  continueAlbumResolution: boolean;
  domIdentity: ReleaseIdentity | null;
  intent: 'metadata' | 'playlist';
  rootProbeCandidateCap: number;
  rootProbeDomPriorityCap: number;
}): { candidates: ReleaseIdentity[] } {
  const releaseContext = isReleaseContext();
  const seen = new Set<string>();
  let candidates: ReleaseIdentity[] = [];
  const apiHintCandidates = collectApiHintCandidates(trackId, linkedReleaseUrl);
  if (releaseContext) {
    addDomIdentityWithLinkedPreference(candidates, seen, domIdentity, linkedReleaseUrl);
    apiHintCandidates.forEach((identity) => {
      addIdentity(candidates, seen, identity);
    });
    addIdentity(candidates, seen, linkedAlbumIdentity);
    addIdentity(candidates, seen, currentResolved);
    addIdentity(candidates, seen, toReleaseIdentity(globals));
  } else {
    addDomIdentityWithLinkedPreference(candidates, seen, domIdentity, linkedReleaseUrl);
    addIdentity(candidates, seen, currentResolved);
    addIdentity(candidates, seen, linkedAlbumIdentity);
    addIdentity(candidates, seen, toReleaseIdentity(globals));
    apiHintCandidates.forEach((identity) => {
      addIdentity(candidates, seen, identity);
    });
  }

  if (!releaseContext) {
    candidates = narrowRootProbeCandidates(
      candidates,
      domIdentity,
      linkedReleaseUrl,
      rootProbeCandidateCap,
      rootProbeDomPriorityCap
    );
    if (trackId) {
      candidates = candidates.filter((identity) => {
        if (identity.tralbumType !== 'a') {
          return true;
        }
        return identity.tralbumId !== trackId;
      });
    }
  }

  if (continueAlbumResolution) {
    candidates = candidates.filter((identity) => identity.tralbumType === 'a');
    const preferredBandId = currentResolved?.bandId || domIdentity?.bandId || linkedAlbumIdentity?.bandId || '';
    if (preferredBandId) {
      const bandAlbumMatches = candidates.filter(
        (identity) => identity.bandId === preferredBandId && identity.tralbumType === 'a'
      );
      if (bandAlbumMatches.length > 0) {
        candidates = bandAlbumMatches;
      }
    }
    if (!candidates.length && trackId && preferredBandId) {
      addIdentity(candidates, seen, {
        bandId: preferredBandId,
        tralbumId: trackId,
        tralbumType: 'a'
      });
    }
  }

  if (trackId) {
    if (!releaseContext) {
      // Non-release pages: always try exact current track identity first, then album.
      const trackFirst = candidates.filter((identity) => identity.tralbumType === 't' && identity.tralbumId === trackId);
      const seenTrack = new Set(trackFirst.map((identity) => releaseKey(identity)));
      const remainder = candidates.filter((identity) => !seenTrack.has(releaseKey(identity)));
      candidates = [...trackFirst, ...remainder];
    } else if (intent === 'metadata') {
      const linkedIsAlbum = linkedReleaseUrl.includes('/album/');
      if (linkedIsAlbum) {
        const albumFirst = candidates.filter((identity) => identity.tralbumType === 'a');
        const seenAlbum = new Set(albumFirst.map((identity) => releaseKey(identity)));
        const remainder = candidates.filter((identity) => !seenAlbum.has(releaseKey(identity)));
        candidates = [...albumFirst, ...remainder];
      } else {
        const trackFirst = candidates.filter((identity) => identity.tralbumType === 't' && identity.tralbumId === trackId);
        const seenTrack = new Set(trackFirst.map((identity) => releaseKey(identity)));
        const remainder = candidates.filter((identity) => !seenTrack.has(releaseKey(identity)));
        candidates = [...trackFirst, ...remainder];
      }
    }
  }

  return { candidates };
}

export function addDiscoverTrackOnlyCandidate(
  candidates: ReleaseIdentity[],
  hintedBandId: string,
  trackId: string
): ReleaseIdentity[] {
  if (!hintedBandId || !trackId) {
    return candidates;
  }
  const hintedIdentity: ReleaseIdentity = {
    bandId: hintedBandId,
    tralbumId: trackId,
    tralbumType: 't'
  };
  if (candidates.some((identity) => releaseKey(identity) === releaseKey(hintedIdentity))) {
    return candidates;
  }
  return [...candidates, hintedIdentity];
}
