import type { LikeIdentity, LikeMutationAction, LikeState, LikesDebugSnapshot } from '@/shared/types';
import { normalizeLikeId } from '@/content/likes/state';
import {
  resolveLikeMutationPreflight,
  toggleWishlistItemPhase1StatusOnly,
  type LikeMutationResult
} from '@/content/likes/mutations';
import { evaluateLikeMutationGate } from '@/content/likes/mutation-gate';
import {
  patchLikeMutationDebug,
  pushLikeProcessEvent,
  resetLikeMutationDebug,
  setLikeMutationAction,
  setLikeMutationGate
} from '@/content/likes/mutation-debug';

export interface LikeMutationControllerOptions {
  context: string;
  likesDebug: LikesDebugSnapshot;
  writesEnabled?: boolean;
  cooldownMs?: number;
  render?: () => void;
}

export interface RunLikeMutationInput {
  target: 'album' | 'track';
  albumState: LikeState;
  targetState: LikeState;
  identity: LikeIdentity | null;
  syncLoading: boolean;
  syncError: boolean;
  explicitTrackLiked?: boolean;
}

export interface RunLikeMutationResult {
  ok: boolean;
  blocked: boolean;
  reasonCode: string;
  action: LikeMutationAction;
}

function buildMutationKey(target: 'album' | 'track', identity: LikeIdentity | null): string {
  const itemId = normalizeLikeId(identity?.itemId || '');
  if (!itemId) {
    return `${target}:missing`;
  }
  return `${target}:${itemId}`;
}

function resolveAction(input: RunLikeMutationInput): MutationAction {
  if (input.target === 'track') {
    if (typeof input.explicitTrackLiked === 'boolean') {
      return input.explicitTrackLiked ? 'uncollect' : 'collect';
    }
    return input.targetState === 'liked' ? 'uncollect' : 'collect';
  }
  return input.targetState === 'liked' ? 'uncollect' : 'collect';
}

export class LikeMutationController {
  private readonly context: string;
  private readonly likesDebug: LikesDebugSnapshot;
  private readonly writesEnabled: boolean;
  private readonly cooldownMs: number;
  private readonly render?: () => void;
  private readonly inFlightKeys = new Set<string>();
  private inFlightCount = 0;
  private readonly keyLastAt = new Map<string, number>();

  constructor(options: LikeMutationControllerOptions) {
    this.context = String(options.context || 'unknown');
    this.likesDebug = options.likesDebug;
    this.writesEnabled = Boolean(options.writesEnabled);
    this.cooldownMs = Math.max(0, Number(options.cooldownMs || 1000));
    this.render = options.render;

    patchLikeMutationDebug(this.likesDebug, {
      enabled: this.writesEnabled
    });
  }

  public async runToggle(input: RunLikeMutationInput): Promise<RunLikeMutationResult> {
    const now = Date.now();
    const key = buildMutationKey(input.target, input.identity);
    const lastAt = this.keyLastAt.get(key) || 0;
    const cooldownMsRemaining = Math.max(0, this.cooldownMs - (now - lastAt));
    const inFlight = this.inFlightCount > 0;
    const action = resolveAction(input);
    const endpointPath = action === 'collect' ? '/collect_item_cb' : '/uncollect_item_cb';

    patchLikeMutationDebug(this.likesDebug, {
      target: input.target,
      action,
      key,
      inFlight,
      cooldownMsRemaining,
      endpointPath,
      requestOrigin: window.location.origin
    });
    pushLikeProcessEvent(this.likesDebug, 'click.received', `${this.context}:${input.target}:${key}`);

    // Reject a concurrent toggle synchronously, before any await. inFlightCount is
    // incremented just below (still synchronously), so a second rapid click on the
    // same heart reads inFlight=true here and bails instead of racing a second POST.
    // Previously the increment happened only after `await resolveLikeMutationPreflight`,
    // leaving a window where two clicks both passed the gate and fired collect+uncollect.
    if (inFlight) {
      setLikeMutationGate(this.likesDebug, 'blocked', 'blocked_in_flight');
      setLikeMutationAction(this.likesDebug, input.target, action, 'blocked', 'blocked_in_flight');
      pushLikeProcessEvent(this.likesDebug, 'gate.blocked', `${key}:blocked_in_flight`);
      this.render?.();
      return {
        ok: false,
        blocked: true,
        reasonCode: 'blocked_in_flight',
        action
      };
    }
    this.inFlightKeys.add(key);
    this.inFlightCount += 1;

    try {
    const preflight = await resolveLikeMutationPreflight(action, input.identity);
    const hasFanId = Boolean(preflight.details.fanId);
    const hasCrumb = Boolean(preflight.details.crumbPresent);
    const preflightAt = Date.now();
    patchLikeMutationDebug(this.likesDebug, {
      preflightAt,
      preflightReason: preflight.reasonCode || '-',
      identityItemId: preflight.details.identityItemId || '',
      identityItemType: preflight.details.identityItemType || '',
      identityBandId: preflight.details.identityBandId || '',
      identityPageUrl: preflight.details.identityPageUrl || '',
      pageHost: preflight.details.pageHost || '',
      targetHost: preflight.details.targetHost || '',
      sameHost: Boolean(preflight.details.sameHost),
      fanIdPresent: Boolean(preflight.details.fanId),
      fanIdValue: preflight.details.fanId || '',
      crumbPresent: Boolean(preflight.details.crumbPresent),
      crumbLength: Number(preflight.details.crumbLength || 0),
      crumbSource: preflight.details.crumbSource || '',
      requestPreview: preflight.details.requestPreview || '-',
      requestContextFamily: preflight.details.requestContextFamily || '',
      requestContextVariant: preflight.details.requestContextVariant || '',
      selectedOriginReason:
        preflight.details.requestContextFamily === 'release-pages' ? 'release-origin-context' : 'bandcamp-origin-context',
      responsePreview: '',
      transport: '',
      dispatchAt: 0,
      completedAt: 0,
      durationMs: 0
    });
    pushLikeProcessEvent(
      this.likesDebug,
      'gate.inputs',
      `item=${normalizeLikeId(input.identity?.itemId || '') ? '1' : '0'} fan=${hasFanId ? '1' : '0'} crumb=${hasCrumb ? '1' : '0'} source=${preflight.details.crumbSource || '-'}`
    );
    if (!preflight.ok) {
      const reasonCode = String(preflight.reasonCode || 'blocked_state_unresolved');
      setLikeMutationGate(this.likesDebug, 'blocked', reasonCode);
      setLikeMutationAction(this.likesDebug, input.target, action, 'blocked', reasonCode);
      pushLikeProcessEvent(this.likesDebug, 'gate.blocked', `${key}:${reasonCode}`);
      this.render?.();
      return {
        ok: false,
        blocked: true,
        reasonCode,
        action
      };
    }

    const gate = evaluateLikeMutationGate({
      writesEnabled: this.writesEnabled,
      target: input.target,
      action,
      albumState: input.albumState,
      targetState: input.targetState,
      identity: input.identity,
      syncLoading: input.syncLoading,
      syncError: input.syncError,
      inFlight: false,
      cooldownMsRemaining,
      hasFanId,
      hasCrumb,
      contextFamily: String(this.likesDebug.contextFamily || '').trim()
    });
    setLikeMutationGate(this.likesDebug, gate.allowed ? 'allowed' : 'blocked', gate.reasonCode);

    if (!gate.allowed) {
      setLikeMutationAction(this.likesDebug, input.target, action, 'blocked', gate.reasonCode);
      pushLikeProcessEvent(this.likesDebug, 'gate.blocked', `${key}:${gate.reasonCode}`);
      this.render?.();
      return {
        ok: false,
        blocked: true,
        reasonCode: gate.reasonCode,
        action
      };
    }

    this.keyLastAt.set(key, now);
    patchLikeMutationDebug(this.likesDebug, {
      inFlight: true,
      gate: 'allowed',
      reasonCode: 'allowed',
      cooldownMsRemaining: 0,
      dispatchAt: Date.now(),
      completedAt: 0,
      durationMs: 0
    });
    setLikeMutationAction(this.likesDebug, input.target, action, 'pending');
    pushLikeProcessEvent(this.likesDebug, 'request.dispatched', `${key}:${action}`);
    this.render?.();

    let result: LikeMutationResult;
    try {
      result = await toggleWishlistItemPhase1StatusOnly(action, input.identity, preflight.request);
    } catch (error) {
      result = {
        ok: false,
        reason: 'wishlist-mutation-failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
    const completedAt = Date.now();
    const dispatchAt = Number(this.likesDebug.mutation.dispatchAt || 0);
    const durationMs = dispatchAt > 0 ? Math.max(0, completedAt - dispatchAt) : 0;

    if (!result.ok) {
      const reasonCode = String(result.error || result.reason || 'wishlist-mutation-failed');
      const signature = `ep=${endpointPath} origin=${window.location.origin} via=${result.transport || '-'} status=${Number.isFinite(result.status) ? result.status : 0} reason=${result.reason || '-'}`;
      patchLikeMutationDebug(this.likesDebug, {
        inFlight: false,
        ok: false,
        status: 0,
        reasonCode,
        completedAt,
        durationMs,
        transport: result.transport || '-',
        responsePreview: signature
      });
      setLikeMutationAction(this.likesDebug, input.target, action, 'failed', reasonCode);
      pushLikeProcessEvent(this.likesDebug, 'request.failed', `${key}:${reasonCode}`);
      pushLikeProcessEvent(this.likesDebug, 'mutation.signature', signature);
      this.render?.();
      return {
        ok: false,
        blocked: false,
        reasonCode,
        action
      };
    }

    const signature = `ep=${endpointPath} origin=${window.location.origin} via=${result.transport || '-'} status=${Number.isFinite(result.status) ? result.status : 200} reason=${result.reason || '-'}`;
    patchLikeMutationDebug(this.likesDebug, {
      inFlight: false,
      ok: true,
      status: 200,
      reasonCode: 'mutation_request_success',
      completedAt,
      durationMs,
      transport: result.transport || '-',
      responsePreview: signature
    });
    setLikeMutationAction(this.likesDebug, input.target, action, 'ok');
    pushLikeProcessEvent(this.likesDebug, 'request.succeeded', `${key}:${action}`);
    pushLikeProcessEvent(this.likesDebug, 'mutation.signature', signature);
    this.render?.();
    return {
      ok: true,
      blocked: false,
      reasonCode: 'mutation_request_success',
      action
    };
    } finally {
      this.inFlightKeys.delete(key);
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    }
  }

  public reset(): void {
    this.inFlightKeys.clear();
    this.inFlightCount = 0;
    resetLikeMutationDebug(this.likesDebug);
  }

  public isUiLocked(): boolean {
    return this.inFlightCount > 0;
  }
}
type MutationAction = 'collect' | 'uncollect';
