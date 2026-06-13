import type { LikeIdentity, LikeState } from '@/shared/types';
import { normalizeLikeId } from '@/content/likes/state';

export interface LikeMutationGateInput {
  writesEnabled: boolean;
  target: 'album' | 'track';
  action: 'collect' | 'uncollect';
  albumState: LikeState;
  targetState: LikeState;
  identity: LikeIdentity | null;
  syncLoading: boolean;
  syncError: boolean;
  inFlight: boolean;
  cooldownMsRemaining: number;
  hasFanId: boolean;
  hasCrumb: boolean;
  contextFamily?: string;
}

export interface LikeMutationGateDecision {
  allowed: boolean;
  reasonCode: string;
}

function resolveBoughtReason(target: 'album' | 'track'): string {
  return target === 'album' ? 'blocked_bought_album' : 'blocked_track_bought';
}

export function resolveBoughtStateBlock(
  target: 'album' | 'track',
  albumState: LikeState,
  targetState: LikeState
): LikeMutationGateDecision | null {
  if (albumState === 'bought') {
    return {
      allowed: false,
      reasonCode: target === 'album' ? 'blocked_bought_album' : 'blocked_album_bought'
    };
  }
  if (targetState === 'bought') {
    return {
      allowed: false,
      reasonCode: resolveBoughtReason(target)
    };
  }
  return null;
}

export function evaluateLikeMutationGate(input: LikeMutationGateInput): LikeMutationGateDecision {
  if (String(input.contextFamily || '').trim().toLowerCase() === 'recommendations') {
    return { allowed: false, reasonCode: 'blocked_recommendations_context' };
  }
  if (!input.writesEnabled) {
    return { allowed: false, reasonCode: 'writes-disabled' };
  }
  if (input.inFlight) {
    return { allowed: false, reasonCode: 'blocked_in_flight' };
  }
  if (input.cooldownMsRemaining > 0) {
    return { allowed: false, reasonCode: 'blocked_cooldown' };
  }
  if (!input.identity) {
    return { allowed: false, reasonCode: 'blocked_identity_missing' };
  }
  const itemId = normalizeLikeId(input.identity.itemId);
  if (!itemId) {
    return { allowed: false, reasonCode: 'blocked_missing_item_id' };
  }
  if (!input.hasFanId) {
    return { allowed: false, reasonCode: 'blocked_missing_fan_id' };
  }
  if (!input.hasCrumb) {
    return { allowed: false, reasonCode: 'blocked_missing_crumb' };
  }
  const boughtBlock = resolveBoughtStateBlock(input.target, input.albumState, input.targetState);
  if (boughtBlock) {
    return boughtBlock;
  }
  if (input.target === 'track' && input.action === 'uncollect' && input.albumState === 'liked') {
    return { allowed: false, reasonCode: 'blocked_track_uncollect_album_liked' };
  }
  if (input.syncLoading) {
    return { allowed: false, reasonCode: 'blocked_state_unresolved' };
  }
  if (input.syncError && input.targetState === 'unknown') {
    return { allowed: false, reasonCode: 'blocked_state_unresolved' };
  }
  return { allowed: true, reasonCode: 'allowed' };
}
