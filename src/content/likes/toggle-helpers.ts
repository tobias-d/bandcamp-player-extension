import type {
  LikeIdentity,
  LikeMutationAction,
  LikeState
} from '@/shared/types';
import type { LikesStatusController } from '@/content/likes/inventory';

export function resolveLikeToggleAction(
  target: 'album' | 'track',
  albumState: LikeState,
  trackState: LikeState
): LikeMutationAction {
  const targetState = target === 'album' ? albumState : trackState;
  return targetState === 'liked' || targetState === 'bought' ? 'uncollect' : 'collect';
}

export function reverseLikeMutationAction(action: LikeMutationAction): LikeMutationAction {
  return action === 'collect' ? 'uncollect' : 'collect';
}

export function applyOptimisticLikeMutation(input: {
  likesController: LikesStatusController;
  action: LikeMutationAction;
  target: 'album' | 'track';
  identity: LikeIdentity | null;
}): boolean {
  if (!input.identity) {
    return false;
  }
  return input.likesController.applyMutationDelta({
    action: input.action,
    target: input.target,
    identity: input.identity
  });
}

export function finalizeLocalLikeMutation(input: {
  likesController: LikesStatusController;
  action: LikeMutationAction;
  target: 'album' | 'track';
  identity: LikeIdentity | null;
  appliedOptimisticUi: boolean;
  resetReason: string;
}): void {
  const {
    likesController,
    action,
    target,
    identity,
    appliedOptimisticUi,
    resetReason
  } = input;
  likesController.resetMutationViewCachesForIdentity({
    reason: resetReason,
    target,
    identity
  });
  if (!appliedOptimisticUi && identity) {
    likesController.applyMutationDelta({
      action,
      target,
      identity
    });
  }
}

export function rollbackOptimisticLikeMutation(input: {
  likesController: LikesStatusController;
  action: LikeMutationAction;
  target: 'album' | 'track';
  identity: LikeIdentity | null;
  resetReason: string;
}): void {
  const { likesController, action, target, identity, resetReason } = input;
  if (!identity) {
    return;
  }
  likesController.applyMutationDelta({
    action: reverseLikeMutationAction(action),
    target,
    identity
  });
  likesController.resetMutationViewCachesForIdentity({
    reason: resetReason,
    target,
    identity
  });
}
