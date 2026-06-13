import type { ReleaseIdentity } from '@/content/metadata/release';
import {
  fetchTralbumForIdentity as fetchTralbumForIdentityWithGuards,
  type FetchTralbumForIdentity
} from '@/content/metadata/extractor/api/fetch';

export function createRootGuardedFetchTralbum(
  isCurrentRootTrack: (trackId: string) => boolean,
  isCurrentRootGeneration: (trackId: string, generation: number) => boolean,
  getApiGlobalBackoffUntil: () => number,
  setApiGlobalBackoffUntil: (ts: number) => void
): FetchTralbumForIdentity {
  return (
    identity: ReleaseIdentity | null,
    requestUrl = '',
    currentTrackId = '',
    rootGeneration = -1
  ) => {
    return fetchTralbumForIdentityWithGuards(identity, {
      requestUrl,
      currentTrackId,
      rootGeneration,
      allowHtmlFallback: !identity,
      isCurrentRootTrack,
      isCurrentRootGeneration,
      getApiGlobalBackoffUntil,
      setApiGlobalBackoffUntil
    });
  };
}
