import type { LikeIdentity, LikeState, PlaylistTrack } from '@/shared/types';
import {
  type LikeIdentityInput,
  normalizeLikeId,
  toCanonicalLikeUrl
} from '@/content/likes/state';

export function isRootNonDiscoverContext(contextFamily: string): boolean {
  const normalized = String(contextFamily || '').trim().toLowerCase();
  return normalized === 'feed' || normalized === 'recommendations' || normalized === 'fan-root';
}

export function buildFocusTruthKey(identity: LikeIdentityInput | null | undefined): string {
  if (!identity) {
    return '';
  }
  const itemType = identity.itemType === 'track' ? 'track' : 'album';
  const itemId = normalizeLikeId(identity.itemId || '');
  if (itemId) {
    return `${itemType}:id=${itemId}`;
  }
  const primaryUrl = identity.urls
    .map((url) => toCanonicalLikeUrl(url))
    .find(Boolean);
  if (primaryUrl) {
    return `${itemType}:u=${primaryUrl}`;
  }
  return '';
}

export function formatLikeIdentityForDebug(identity: LikeIdentity | LikeIdentityInput | null | undefined): string {
  if (!identity) {
    return 'none';
  }
  const itemId = normalizeLikeId(identity.itemId || '') || '-';
  const bandId = 'bandId' in identity ? normalizeLikeId(identity.bandId || '') || '-' : '-';
  const urls = 'urls' in identity
    ? identity.urls
    : [String(identity.pageUrl || '').trim()].filter(Boolean);
  const primaryUrl = toCanonicalLikeUrl(String(urls[0] || '')) || '-';
  return `${identity.itemType}:${itemId}:b=${bandId}:u=${primaryUrl}`;
}

export function summarizeTrackStateCounts(trackStates: Record<number, LikeState>, totalTracks: number): string {
  const counts: Record<LikeState, number> = {
    unknown: 0,
    disliked: 0,
    liked: 0,
    bought: 0
  };
  for (let index = 0; index < totalTracks; index += 1) {
    const state = trackStates[index] || 'unknown';
    counts[state] += 1;
  }
  return `u=${counts.unknown},d=${counts.disliked},l=${counts.liked},b=${counts.bought}`;
}

export function findActivePlaylistTrackIndex(playlistTracks: PlaylistTrack[]): number {
  const activeIndex = playlistTracks.findIndex((track) => Boolean(track?.isCurrent));
  if (activeIndex >= 0) {
    return activeIndex;
  }
  return playlistTracks.length > 0 ? 0 : -1;
}

export function formatPlaylistTrackForDebug(
  playlistTracks: PlaylistTrack[],
  trackStates: Record<number, LikeState>,
  index: number
): string {
  if (index < 0 || index >= playlistTracks.length) {
    return 'idx=-1:none';
  }
  const track = playlistTracks[index];
  const trackId = normalizeLikeId(track?.trackId || '') || toCanonicalLikeUrl(String(track?.pageUrl || '')) || '-';
  return `idx=${index}:id=${trackId}:state=${trackStates[index] || 'unknown'}`;
}

export function trackStatesEqual(
  left: Record<number, LikeState>,
  right: Record<number, LikeState>,
  totalTracks: number
): boolean {
  for (let index = 0; index < totalTracks; index += 1) {
    if ((left[index] || 'unknown') !== (right[index] || 'unknown')) {
      return false;
    }
  }
  return true;
}
