import type { LikeState } from '@/shared/types';
import type { LikeIdentityInput } from '@/content/likes/state';
import type { EndpointSnapshot } from '@/content/likes/inventory-utils';
import { buildFocusTruthKey, snapshotContainsIdentity } from '@/content/likes/inventory-helpers';

export type FocusedTruthLikeState = Exclude<LikeState, 'disliked'>;

export interface FocusedTruthState {
  albumKey: string;
  albumState: FocusedTruthLikeState;
  trackStates: Record<string, FocusedTruthLikeState>;
}

export function createEmptyFocusedTruthState(): FocusedTruthState {
  return {
    albumKey: '',
    albumState: 'unknown',
    trackStates: {}
  };
}

export function clearFocusedTruthState(target: FocusedTruthState): void {
  target.albumKey = '';
  target.albumState = 'unknown';
  target.trackStates = {};
}

function resolveFocusedState(
  identity: LikeIdentityInput | null,
  wishlistSnapshot: EndpointSnapshot,
  collectionSnapshot: EndpointSnapshot
): FocusedTruthLikeState {
  if (!identity) {
    return 'unknown';
  }
  if (snapshotContainsIdentity(collectionSnapshot, identity)) {
    return 'bought';
  }
  if (snapshotContainsIdentity(wishlistSnapshot, identity)) {
    return 'liked';
  }
  return 'unknown';
}

export function setFocusedTruthState(input: {
  target: FocusedTruthState;
  albumIdentity: LikeIdentityInput | null;
  trackIdentities: LikeIdentityInput[];
  wishlistSnapshot: EndpointSnapshot;
  collectionSnapshot: EndpointSnapshot;
}): void {
  const {
    target,
    albumIdentity,
    trackIdentities,
    wishlistSnapshot,
    collectionSnapshot
  } = input;

  clearFocusedTruthState(target);

  const albumKey = buildFocusTruthKey(albumIdentity);
  if (albumKey) {
    target.albumKey = albumKey;
    target.albumState = resolveFocusedState(albumIdentity, wishlistSnapshot, collectionSnapshot);
  }

  const nextTrackStates: Record<string, FocusedTruthLikeState> = {};
  trackIdentities.forEach((identity) => {
    const truthKey = buildFocusTruthKey(identity);
    if (!truthKey || nextTrackStates[truthKey]) {
      return;
    }
    nextTrackStates[truthKey] = resolveFocusedState(identity, wishlistSnapshot, collectionSnapshot);
  });
  target.trackStates = nextTrackStates;
}

export function readFocusedAlbumTruth(
  target: FocusedTruthState,
  albumIdentity: LikeIdentityInput | null
): FocusedTruthLikeState {
  if (!albumIdentity) {
    return 'unknown';
  }
  return buildFocusTruthKey(albumIdentity) === target.albumKey ? target.albumState : 'unknown';
}

export function readFocusedTrackTruth(
  target: FocusedTruthState,
  trackIdentity: LikeIdentityInput | null
): FocusedTruthLikeState {
  if (!trackIdentity) {
    return 'unknown';
  }
  return target.trackStates[buildFocusTruthKey(trackIdentity)] || 'unknown';
}

export function matchesFocusedAlbumTruthTarget(
  target: FocusedTruthState,
  albumIdentity: LikeIdentityInput | null
): boolean {
  if (!albumIdentity) {
    return false;
  }
  const truthKey = buildFocusTruthKey(albumIdentity);
  return Boolean(truthKey && truthKey === target.albumKey);
}
