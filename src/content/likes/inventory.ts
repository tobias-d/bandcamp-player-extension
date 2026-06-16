/**
 * Likes inventory — LikesStatusController class + sync machinery.
 *
 * Structure:
 *   1–99     Imports
 *   100–212  Module-level pure helpers
 *   213–900  LikesStatusController class — public API
 *            (readInventoryLikeState, resolveViewState, applyMutationDelta)
 *   900–1020 Sync eligibility checks
 *   1021–1230 sync() + runSync() — main sync orchestration
 *   1230–1750 Sync internals: token resolution, endpoint sync, pagination, rate limiting
 *   1752–1773 Exported helper functions
 */
import {
  createDefaultLikeEndpointAttempts,
  createDefaultLikeEndpointStatus,
  LIKES_FANCOLLECTION_MESSAGE_TIMEOUT_MS,
  LIKES_FANCOLLECTION_PAGE_SIZE,
  SHARED_LIKES_CACHE_MAX_AGE_MS
} from '@/shared/constants';
import type {
  FanEndpoint,
  LikeIdentity,
  LikeMutationAction,
  LikeState,
  LikesDebugSnapshot,
  PersistentBoughtLikesSnapshot,
  PlaylistTrack,
  SharedLikesCacheSnapshot,
} from '@/shared/types';
import { extractFanItemsPaging } from '@/content/metadata/extractor/summary';
import { createLogger } from '@/utils/debug';
import { resolveViewerFanId } from '@/content/likes/viewer-id';
import {
  canonicalizeLikeIdentityPageUrl,
  applyLikeStatesToPlaylist,
  applySerializedLikeInventory,
  buildLikeIdentity,
  buildLikeViewState as buildResolvedLikeViewState,
  createEmptyLikeInventorySets,
  getLikeInventoryCounts,
  isTrustedPlaylistLikeSource,
  mergeSerializedBoughtLikeInventory,
  type LikeIdentityInput,
  normalizeLikeId,
  serializeBoughtLikeInventorySets,
  serializeLikeInventorySets,
  toCanonicalLikeUrl
} from '@/content/likes/state';
import {
  type EndpointSnapshot,
  type EndpointSyncResult,
  albumLikeSessionKey,
  albumLikeSessionUrlKey,
  applyPayloadToSnapshot,
  applyAlbumDerivedTrackDisplay,
  buildSyntheticStartToken,
  clearInventorySets,
  endpointStatusIsComplete,
  maxLikeState,
  mergeLikeProcessEvents,
  replaceEndpointData,
  sendMessageWithTimeout,
  sleep,
  toBackoffMs,
  trackLikeSessionKey,
  createEmptyEndpointSnapshot
} from '@/content/likes/inventory-utils';
import type { PageContext } from '@/content/page-context';
import {
  isRootNonDiscoverContext,
  buildFocusTruthKey,
  formatLikeIdentityForDebug,
  summarizeTrackStateCounts,
  findActivePlaylistTrackIndex,
  formatPlaylistTrackForDebug,
  trackStatesEqual
} from '@/content/likes/inventory-helpers';
const logger = createLogger('LIKES');

export {
  resolveReleaseLikeIdentityFromGlobals
} from '@/content/likes/inventory-utils';

const SYNC_MIN_INTERVAL_MS = 60_000;
const ERROR_BACKOFF_MS = 30_000;
const ENDPOINT_DEFAULT_MAX_ATTEMPTS = 8;
const ENDPOINT_DEEP_COLLECTION_MAX_ATTEMPTS = 40;
const RAPID_ORIGIN_JUMP_BURST_LIMIT = 4;
const RAPID_ORIGIN_JUMP_WINDOW_MS = 5_000;
const RAPID_ORIGIN_JUMP_COOLDOWN_MS = 60_000;
const PAGE_REQUEST_SPACING_MS = 220;
const FAN_ID_RETRY_BACKOFF_MS = 1_200;
// Default for quick likes messages. Fan-collection endpoint calls use the
// longer pagination budget below so cold syncs can settle deterministically.
const MESSAGE_TIMEOUT_MS = 6_000;
const SYNC_STALL_TIMEOUT_MS = 45_000;
const MAX_LIKES_PROCESS_EVENTS = 120;
const PROCESS_OVERFLOW_WARN_INTERVAL_MS = 10_000;

let lastProcessOverflowWarnAt = 0;
const MUTATION_DEEP_SYNC_SUPPRESS_MS = SHARED_LIKES_CACHE_MAX_AGE_MS;
interface SyncInput {
  fanIdHint: string;
  fanSlugHint: string;
  contextFamily: string;
  contextVariant: string;
  force?: boolean;
  silent?: boolean;
  focusAlbumIdentity?: LikeIdentity | null;
  focusTrackIdentity?: LikeIdentity | null;
  focusTrackIdentities?: LikeIdentity[];
}

function hasCompleteEndpointCoverage(endpointStatus: {
  wishlist?: string;
  collection?: string;
}): boolean {
  return (
    endpointStatusIsComplete(String(endpointStatus.wishlist || '')) &&
    endpointStatusIsComplete(String(endpointStatus.collection || ''))
  );
}

function isCompleteSharedLikesSnapshot(snapshot: SharedLikesCacheSnapshot): boolean {
  return (
    String(snapshot.syncStatus || '') === 'success' &&
    hasCompleteEndpointCoverage(snapshot.endpointStatus)
  );
}

type SessionLikeOverlay = {
  albumState?: LikeState;
  trackStates: Map<number, LikeState>;
  trackHits: number;
};

type SyncFocusSummary = {
  albumIdentity: LikeIdentityInput | null;
  trackIdentities: LikeIdentityInput[];
};

export class LikesStatusController {
  private context: string;
  private contextFamily = '';
  private contextVariant = '';
  private readonly inventory = createEmptyLikeInventorySets();
  private readonly sessionAlbumStates = new Map<string, LikeState>();
  private readonly sessionTrackStates = new Map<string, LikeState>();
  private readonly strictAlbumIdentityByUrl = new Map<string, LikeIdentityInput>();
  private syncInFlight = false;
  private syncPromise: Promise<boolean> | null = null;
  private lastSyncTs = 0;
  private lastAttemptTs = 0;
  private nextRetryTs = 0;
  private fanSlug = '';
  private fanId = '';
  private syncStatus: LikesDebugSnapshot['syncStatus'] = 'idle';
  private syncReason = 'not-started';
  private lastError = '';
  private syncUiBlocking = true;
  private endpointStatus = createDefaultLikeEndpointStatus();
  private endpointAttempts = createDefaultLikeEndpointAttempts();
  private syncRunSeq = 0;
  private activeSyncRunSeq = 0;
  private activeSyncMode: 'deep' | 'none' = 'none';
  private syncStartedAt = 0;
  private syncLastProgressAt = 0;
  private lastMutationTs = 0;
  private sharedCacheUpdatedAt = 0;
  private persistentBoughtCacheUpdatedAt = 0;
  private persistentBoughtCacheHydratedFanId = '';
  private persistentBoughtCacheStatus = 'not-read';
  private persistentBoughtCacheLastReadAt = 0;
  private persistentBoughtCacheLastWriteAt = 0;
  private persistentBoughtCacheCounts = {
    collectionAlbumIds: 0,
    collectionTrackIds: 0,
    collectionAlbumUrls: 0,
    collectionTrackUrls: 0
  };
  private rapidOriginJumpCount = 0;
  private lastOriginJumpTs = 0;
  private rapidOriginJumpCooldownUntil = 0;
  private readonly processEvents: Array<{ ts: number; stage: string; detail: string }> = [];
  private lastResolveInputDebug = '';
  private lastResolveOutputDebug = '';
  constructor(context: string) {
    this.context = String(context || 'unknown');
  }

  public updateContext(
    context: string,
    contextFamily = this.contextFamily,
    contextVariant = this.contextVariant
  ): void {
    this.context = String(context || this.context || 'unknown').trim() || 'unknown';
    this.contextFamily = String(contextFamily || this.contextFamily || '').trim();
    this.contextVariant = String(contextVariant || this.contextVariant || '').trim();
  }

  private hasCompleteInventoryCoverage(): boolean {
    return this.syncStatus === 'success' && hasCompleteEndpointCoverage(this.endpointStatus);
  }

  private isSharedInventoryStale(now = Date.now()): boolean {
    return (
      this.hasCompleteInventoryCoverage() &&
      this.lastSyncTs > 0 &&
      now - this.lastSyncTs >= SHARED_LIKES_CACHE_MAX_AGE_MS
    );
  }

  private resolveDeepSyncTrigger(now = Date.now()): { reason: string; ageMs: number } {
    if (this.isSharedInventoryStale(now)) {
      return {
        reason: 'stale-shared-cache',
        ageMs: Math.max(0, now - this.lastSyncTs)
      };
    }
    if (this.isInventoryReady()) {
      return {
        reason: 'inventory-ready',
        ageMs: Math.max(0, now - this.lastSyncTs)
      };
    }
    if (this.syncStatus === 'success') {
      return {
        reason: 'follow-up-success',
        ageMs: Math.max(0, now - this.lastSyncTs)
      };
    }
    if (this.syncStatus === 'error') {
      return {
        reason: 'recover-from-error',
        ageMs: Math.max(0, now - this.lastSyncTs)
      };
    }
    return {
      reason: 'manual',
      ageMs: Math.max(0, now - this.lastSyncTs)
    };
  }

  private applySharedCacheSnapshot(snapshot: SharedLikesCacheSnapshot): boolean {
    const fanId = normalizeLikeId(snapshot.fanId || '');
    const updatedAt = Number(snapshot.updatedAt || 0);
    if (!fanId || !updatedAt || updatedAt <= this.sharedCacheUpdatedAt) {
      return false;
    }
    if (!isCompleteSharedLikesSnapshot(snapshot)) {
      return false;
    }

    applySerializedLikeInventory(this.inventory, snapshot.inventory);
    this.fanId = fanId;
    this.fanSlug = String(snapshot.fanSlug || '').trim().toLowerCase();
    this.syncStatus = 'success';
    this.syncReason = String(snapshot.syncReason || 'shared-cache');
    this.lastSyncTs = Math.max(0, Number(snapshot.lastSyncTs || 0));
    this.nextRetryTs = Math.max(0, Number(snapshot.nextRetryTs || 0));
    this.endpointStatus = {
      wishlist: String(snapshot.endpointStatus?.wishlist || 'n/a'),
      collection: String(snapshot.endpointStatus?.collection || 'n/a')
    };
    this.endpointAttempts = {
      wishlist: Math.max(0, Number(snapshot.endpointAttempts?.wishlist || 0)),
      collection: Math.max(0, Number(snapshot.endpointAttempts?.collection || 0))
    };
    this.lastError = '';
    this.sharedCacheUpdatedAt = updatedAt;
    this.pushProcessEvent(
      'shared.cache.apply',
      `fan=${fanId} updatedAt=${updatedAt} reason=${this.syncReason} w=${this.endpointStatus.wishlist} c=${this.endpointStatus.collection}`
    );
    return true;
  }

  private async hydrateFromSharedCache(fanId: string): Promise<boolean> {
    const normalizedFanId = normalizeLikeId(fanId || '');
    if (!normalizedFanId) {
      return false;
    }
    try {
      const response = await sendMessageWithTimeout<{
        ok?: boolean;
        snapshot?: SharedLikesCacheSnapshot | null;
      }>(
        {
          type: 'GET_SHARED_LIKES_CACHE',
          fanId: normalizedFanId
        },
        MESSAGE_TIMEOUT_MS
      );
      if (!response?.ok || !response.snapshot) {
        return false;
      }
      return this.applySharedCacheSnapshot(response.snapshot);
    } catch {
      this.pushProcessEvent('shared.cache.read', `fan=${normalizedFanId}:error`);
      return false;
    }
  }

  private applyPersistentBoughtCacheSnapshot(snapshot: PersistentBoughtLikesSnapshot): boolean {
    const fanId = normalizeLikeId(snapshot.fanId || '');
    const updatedAt = Number(snapshot.updatedAt || 0);
    if (!fanId || !updatedAt || updatedAt <= this.persistentBoughtCacheUpdatedAt) {
      return false;
    }

    mergeSerializedBoughtLikeInventory(this.inventory, snapshot.inventory);
    this.fanId = fanId;
    this.fanSlug = String(snapshot.fanSlug || this.fanSlug || '').trim().toLowerCase();
    this.persistentBoughtCacheUpdatedAt = updatedAt;
    this.persistentBoughtCacheHydratedFanId = fanId;
    this.persistentBoughtCacheStatus = 'hit';
    this.persistentBoughtCacheLastReadAt = Date.now();
    this.persistentBoughtCacheCounts = {
      collectionAlbumIds: Array.isArray(snapshot.inventory?.collectionAlbumIds) ? snapshot.inventory.collectionAlbumIds.length : 0,
      collectionTrackIds: Array.isArray(snapshot.inventory?.collectionTrackIds) ? snapshot.inventory.collectionTrackIds.length : 0,
      collectionAlbumUrls: Array.isArray(snapshot.inventory?.collectionAlbumUrls) ? snapshot.inventory.collectionAlbumUrls.length : 0,
      collectionTrackUrls: Array.isArray(snapshot.inventory?.collectionTrackUrls) ? snapshot.inventory.collectionTrackUrls.length : 0
    };
    this.pushProcessEvent(
      'bought.cache.apply',
      `fan=${fanId} updatedAt=${updatedAt} collectionAlbums=${this.inventory.collectionAlbumIds.size} collectionTracks=${this.inventory.collectionTrackIds.size}`
    );
    return true;
  }

  private async hydrateFromPersistentBoughtCache(fanId: string): Promise<boolean> {
    const normalizedFanId = normalizeLikeId(fanId || '');
    if (!normalizedFanId) {
      return false;
    }
    if (this.persistentBoughtCacheHydratedFanId === normalizedFanId) {
      return false;
    }
    this.persistentBoughtCacheLastReadAt = Date.now();
    try {
      const response = await sendMessageWithTimeout<{
        ok?: boolean;
        snapshot?: PersistentBoughtLikesSnapshot | null;
      }>(
        {
          type: 'GET_PERSISTENT_BOUGHT_LIKES_CACHE',
          fanId: normalizedFanId
        },
        MESSAGE_TIMEOUT_MS
      );
      this.persistentBoughtCacheHydratedFanId = normalizedFanId;
      if (!response?.ok || !response.snapshot) {
        this.persistentBoughtCacheStatus = 'miss';
        return false;
      }
      return this.applyPersistentBoughtCacheSnapshot(response.snapshot);
    } catch {
      this.persistentBoughtCacheStatus = 'read-error';
      this.pushProcessEvent('bought.cache.read', `fan=${normalizedFanId}:error`);
      return false;
    }
  }

  private publishSharedCache(reason: string): void {
    const fanId = normalizeLikeId(this.fanId || '');
    if (!fanId || !this.hasCompleteInventoryCoverage()) {
      return;
    }
    // Only publish complete inventory snapshots. Page-local focused matches stay
    // local so one surface does not overwrite the shared global inventory truth.
    const snapshot: SharedLikesCacheSnapshot = {
      fanId,
      fanSlug: this.fanSlug,
      syncStatus: 'success',
      syncReason: String(this.syncReason || reason || 'shared-cache'),
      lastSyncTs: this.lastSyncTs,
      nextRetryTs: this.nextRetryTs,
      endpointStatus: { ...this.endpointStatus },
      endpointAttempts: { ...this.endpointAttempts },
      inventory: serializeLikeInventorySets(this.inventory),
      updatedAt: Date.now()
    };
    this.sharedCacheUpdatedAt = snapshot.updatedAt;
    void sendMessageWithTimeout<{
      ok?: boolean;
    }>(
      {
        type: 'SET_SHARED_LIKES_CACHE',
        snapshot
      },
      MESSAGE_TIMEOUT_MS
    ).catch(() => {
      this.pushProcessEvent('shared.cache.write', `${reason}:error`);
    });
  }

  private publishPersistentBoughtCache(reason: string): void {
    const fanId = normalizeLikeId(this.fanId || '');
    if (!fanId || (!this.inventory.collectionAlbumIds.size && !this.inventory.collectionTrackIds.size)) {
      return;
    }

    const snapshot: PersistentBoughtLikesSnapshot = {
      fanId,
      fanSlug: this.fanSlug,
      inventory: serializeBoughtLikeInventorySets(this.inventory),
      updatedAt: Date.now()
    };
    this.persistentBoughtCacheUpdatedAt = snapshot.updatedAt;
    this.persistentBoughtCacheHydratedFanId = fanId;
    this.persistentBoughtCacheStatus = 'written';
    this.persistentBoughtCacheLastWriteAt = Date.now();
    this.persistentBoughtCacheCounts = {
      collectionAlbumIds: snapshot.inventory.collectionAlbumIds.length,
      collectionTrackIds: snapshot.inventory.collectionTrackIds.length,
      collectionAlbumUrls: snapshot.inventory.collectionAlbumUrls.length,
      collectionTrackUrls: snapshot.inventory.collectionTrackUrls.length
    };
    void sendMessageWithTimeout<{
      ok?: boolean;
      snapshot?: PersistentBoughtLikesSnapshot | null;
    }>(
      {
        type: 'SET_PERSISTENT_BOUGHT_LIKES_CACHE',
        snapshot
      },
      MESSAGE_TIMEOUT_MS
    ).catch(() => {
      this.persistentBoughtCacheStatus = 'write-error';
      this.pushProcessEvent('bought.cache.write', `${reason}:error`);
    });
  }

  public hardResetForOriginJump(reason = 'origin-jump'): void {
    const normalizedReason = String(reason || '').trim().toLowerCase();
    const isMutationReset =
      normalizedReason.includes('collect') || normalizedReason.includes('uncollect');
    const hadInFlightRun = this.syncStatus === 'in-flight' || this.syncInFlight || Boolean(this.syncPromise);
    const hadSuccessfulSync = this.lastSyncTs > 0;
    const inventoryCounts = getLikeInventoryCounts(this.inventory);
    const hasSeededInventory =
      inventoryCounts.wishlistAlbumIds > 0 ||
      inventoryCounts.wishlistTrackIds > 0 ||
      inventoryCounts.wishlistAlbumUrls > 0 ||
      inventoryCounts.wishlistTrackUrls > 0 ||
      inventoryCounts.collectionAlbumIds > 0 ||
      inventoryCounts.collectionTrackIds > 0 ||
      inventoryCounts.collectionAlbumUrls > 0 ||
      inventoryCounts.collectionTrackUrls > 0;
    const discoverContext = String(this.contextFamily || '').trim().toLowerCase() === 'discover';
    const hasTrustedInventory = (hadSuccessfulSync && this.syncStatus !== 'error') || (discoverContext && hasSeededInventory);
    const preserveInFlightSync =
      !isMutationReset &&
      hadInFlightRun &&
      this.activeSyncMode === 'deep';

    this.trackRapidOriginJumpBurst(reason);
    if (!preserveInFlightSync) {
      this.activeSyncRunSeq = 0;
      this.activeSyncMode = 'none';
      this.syncInFlight = false;
      this.syncPromise = null;
      this.syncStartedAt = 0;
    } else {
      this.pushProcessEvent('reset.soft.keep-sync', `${reason}:mode=${this.activeSyncMode}`);
    }
    this.lastError = '';
    this.sessionAlbumStates.clear();
    this.sessionTrackStates.clear();
    this.strictAlbumIdentityByUrl.clear();

    if (isMutationReset) {
      this.syncStatus = 'idle';
      this.syncReason = `reset:${reason}`;
      this.lastSyncTs = 0;
      this.lastMutationTs = 0;
      this.lastAttemptTs = 0;
      this.nextRetryTs = 0;
      this.endpointStatus = createDefaultLikeEndpointStatus();
      this.endpointAttempts = createDefaultLikeEndpointAttempts();
      clearInventorySets(this.inventory);
      this.pushProcessEvent('reset.hard', reason);
      return;
    }

    // For ordinary origin/source jumps keep synced inventory so we avoid
    // expensive re-fetch storms while playback is changing quickly.
    // But if we have never completed a successful sync (or are in error),
    // partial inventory is untrusted and can leak stale bought/liked states.
    if (!hasTrustedInventory) {
      if (preserveInFlightSync) {
        this.syncReason = `reset-soft:${reason}`;
        this.pushProcessEvent('reset.soft', reason);
        return;
      }
      this.syncStatus = 'idle';
      this.lastSyncTs = 0;
      this.lastMutationTs = 0;
      this.lastAttemptTs = 0;
      this.nextRetryTs = 0;
      this.endpointStatus = createDefaultLikeEndpointStatus();
      this.endpointAttempts = createDefaultLikeEndpointAttempts();
      clearInventorySets(this.inventory);
      this.pushProcessEvent('reset.soft.clear-inventory', reason);
      this.syncReason = `reset-soft:${reason}`;
      this.pushProcessEvent('reset.soft', reason);
      return;
    }

    this.lastAttemptTs = 0;
    this.nextRetryTs = 0;
    if (hadInFlightRun && !preserveInFlightSync) {
      if (hadSuccessfulSync) {
        this.syncStatus = 'success';
      } else {
        // Aborted first-run syncs should not leave a stale "in-flight" state.
        this.syncStatus = 'idle';
        this.lastAttemptTs = 0;
        this.nextRetryTs = 0;
        this.endpointStatus = createDefaultLikeEndpointStatus();
        this.endpointAttempts = createDefaultLikeEndpointAttempts();
      }
    }
    this.syncReason = `reset-soft:${reason}`;
    this.pushProcessEvent('reset.soft', reason);
  }

  public resetMutationViewCaches(reason = 'mutation-cache-reset'): void {
    this.sessionAlbumStates.clear();
    this.sessionTrackStates.clear();
    this.pushProcessEvent('reset.soft', reason);
  }

  public resetMutationViewCachesForIdentity(input: {
    reason?: string;
    target: 'album' | 'track';
    identity: LikeIdentity | null;
  }): void {
    const reason = String(input.reason || 'mutation-cache-reset');
    const target = input.target === 'album' ? 'album' : 'track';
    const identity = buildLikeIdentity(input.identity);

    if (!identity) {
      this.pushProcessEvent('reset.mutation', `${target}:none:${reason}`);
      return;
    }

    if (target === 'album') {
      const primaryUrl = identity.urls[0] || '';
      const albumSessionKey = albumLikeSessionKey(identity) || albumLikeSessionUrlKey(primaryUrl);
      if (albumSessionKey) {
        this.sessionAlbumStates.delete(albumSessionKey);
      }
    } else {
      const itemId = normalizeLikeId(identity.itemId || '');
      const sessionKey = itemId ? `id:${itemId}` : '';
      if (sessionKey) {
        this.sessionTrackStates.delete(sessionKey);
      }
    }

    this.pushProcessEvent('reset.mutation', `${target}:${formatLikeIdentityForDebug(identity)}:${reason}`);
  }

  public applyMutationDelta(input: {
    action: LikeMutationAction;
    target: 'album' | 'track';
    identity: LikeIdentity | null;
  }): boolean {
    const now = Date.now();
    const action = input.action === 'uncollect' ? 'uncollect' : 'collect';
    const target = input.target === 'track' ? 'track' : 'album';
    const itemId = normalizeLikeId(input.identity?.itemId || '');
    const pageUrl = canonicalizeLikeIdentityPageUrl(target, input.identity?.pageUrl || '');
    const idSet = target === 'track' ? this.inventory.wishlistTrackIds : this.inventory.wishlistAlbumIds;
    const urlSet = target === 'track' ? this.inventory.wishlistTrackUrls : this.inventory.wishlistAlbumUrls;
    const optimisticState: LikeState = action === 'collect' ? 'liked' : 'disliked';
    const hadCompleteCoverage = hasCompleteEndpointCoverage(this.endpointStatus);
    let changed = false;

    if (action === 'collect') {
      if (itemId && !idSet.has(itemId)) {
        idSet.add(itemId);
        changed = true;
      }
      if (pageUrl && !urlSet.has(pageUrl)) {
        urlSet.add(pageUrl);
        changed = true;
      }
    } else {
      if (itemId && idSet.delete(itemId)) {
        changed = true;
      }
      if (pageUrl && urlSet.delete(pageUrl)) {
        changed = true;
      }
    }

    this.pushProcessEvent(
      'delta.apply',
      `${target}:${action}:${itemId || '-'}:${pageUrl || '-'}:${changed ? 'changed' : 'no-op'}`
    );

    if (changed) {
      if (this.syncStatus !== 'in-flight') {
        this.syncStatus = 'success';
        this.syncReason = hadCompleteCoverage ? 'inventory-ready' : 'mutation-delta';
      }
      this.lastSyncTs = now;
      this.lastMutationTs = now;
      this.lastError = '';
      this.nextRetryTs = 0;
    }

    const optimisticIdentity = buildLikeIdentity(input.identity);
    if (target === 'album') {
      const albumSessionKey = albumLikeSessionKey(optimisticIdentity) || albumLikeSessionUrlKey(pageUrl);
      if (albumSessionKey) {
        this.sessionAlbumStates.set(albumSessionKey, optimisticState);
      }
    } else {
      const sessionKey = itemId ? `id:${itemId}` : '';
      if (sessionKey) {
        this.sessionTrackStates.set(sessionKey, optimisticState);
      }
    }
    this.pushProcessEvent('delta.optimistic', `${target}:${optimisticState}:${itemId || '-'}:${pageUrl || '-'}`);

    if (changed) {
      this.publishSharedCache('mutation-delta');
    }

    return changed;
  }

  public readInventoryLikeState(identity: LikeIdentity | null): LikeState {
    if (!identity) {
      return 'unknown';
    }
    const itemType = identity.itemType === 'track' ? 'track' : 'album';
    return this.resolveInventoryMembershipState({
      itemType,
      itemId: normalizeLikeId(identity.itemId || ''),
      canonicalUrl: canonicalizeLikeIdentityPageUrl(itemType, String(identity.pageUrl || '')),
      allowDisliked: this.canReadDislikedInventoryState()
    });
  }

  private resolveInventoryMembershipState(input: {
    itemType: 'album' | 'track';
    itemId: string;
    canonicalUrl: string;
    allowDisliked: boolean;
  }): LikeState {
    const collectionIds =
      input.itemType === 'track' ? this.inventory.collectionTrackIds : this.inventory.collectionAlbumIds;
    const collectionUrls =
      input.itemType === 'track' ? this.inventory.collectionTrackUrls : this.inventory.collectionAlbumUrls;
    const wishlistIds =
      input.itemType === 'track' ? this.inventory.wishlistTrackIds : this.inventory.wishlistAlbumIds;
    const wishlistUrls =
      input.itemType === 'track' ? this.inventory.wishlistTrackUrls : this.inventory.wishlistAlbumUrls;

    if ((input.itemId && collectionIds.has(input.itemId)) || (input.canonicalUrl && collectionUrls.has(input.canonicalUrl))) {
      return 'bought';
    }
    if ((input.itemId && wishlistIds.has(input.itemId)) || (input.canonicalUrl && wishlistUrls.has(input.canonicalUrl))) {
      return 'liked';
    }
    return input.allowDisliked ? 'disliked' : 'unknown';
  }

  private readSessionLikeOverlay(
    album: LikeIdentityInput | null,
    preferredAlbumUrl: string,
    playlistTracks: PlaylistTrack[]
  ): SessionLikeOverlay {
    const albumSessionKey = albumLikeSessionKey(album) || albumLikeSessionUrlKey(preferredAlbumUrl);
    const trackStates = new Map<number, LikeState>();
    let trackHits = 0;

    playlistTracks.forEach((track, index) => {
      const sessionKey = trackLikeSessionKey(track);
      const sessionTrackState = sessionKey ? this.sessionTrackStates.get(sessionKey) : undefined;
      if (!sessionTrackState) {
        return;
      }
      trackStates.set(index, sessionTrackState);
      trackHits += 1;
    });

    return {
      albumState: albumSessionKey ? this.sessionAlbumStates.get(albumSessionKey) : undefined,
      trackStates,
      trackHits
    };
  }

  private canReadDislikedInventoryState(): boolean {
    const postSourceReset = this.syncReason.startsWith('reset-soft:');
    return (
      !postSourceReset &&
      this.syncStatus === 'success' &&
      !this.syncInFlight &&
      endpointStatusIsComplete(this.endpointStatus.wishlist) &&
      endpointStatusIsComplete(this.endpointStatus.collection)
    );
  }

  public resolveViewState(
    albumIdentity: LikeIdentity | null,
    playlistTracks: PlaylistTrack[],
    writesDisabled = true,
    playlistSource = '',
    strictResolverTrackBinding = true,
    preferredAlbumUrl = ''
  ): { likeState: ReturnType<typeof buildResolvedLikeViewState>; playlistTracks: PlaylistTrack[] } {
    const directAlbumIdentity = buildLikeIdentity(albumIdentity);
    if (directAlbumIdentity) {
      this.cacheStrictAlbumIdentity(directAlbumIdentity);
    }
    const album = directAlbumIdentity || this.resolveCachedAlbumIdentityForPlaylist(playlistTracks, preferredAlbumUrl);
    const hasStrictAlbumIdentity = Boolean(
      album &&
      album.itemType === 'album' &&
      (normalizeLikeId(album.itemId || '') || album.urls.length > 0)
    );
    const syncUiState = this.resolveSyncUiState();
    const postSourceReset = this.syncReason.startsWith('reset-soft:');
    const allowDisliked = this.canReadDislikedInventoryState();
    const likeNotice = syncUiState.terminalError ? 'sync-error' : '';
    const trackIdentityReady = strictResolverTrackBinding && isTrustedPlaylistLikeSource(playlistSource);
    const allowAlbumTrackProjection = hasStrictAlbumIdentity && !trackIdentityReady;
    const activeTrackIndex = findActivePlaylistTrackIndex(playlistTracks);
    const activeTrackIdentity = activeTrackIndex >= 0
      ? buildLikeIdentity({
          itemId: playlistTracks[activeTrackIndex]?.trackId || '',
          itemType: 'track',
          pageUrl: playlistTracks[activeTrackIndex]?.pageUrl || ''
        })
      : null;
    const resolveInputDetail = [
      `source=${playlistSource || '-'}`,
      `tracks=${playlistTracks.length}`,
      `active=${formatPlaylistTrackForDebug(playlistTracks, {}, activeTrackIndex)}`,
      `album=${formatLikeIdentityForDebug(album)}`,
      `strictAlbum=${hasStrictAlbumIdentity ? '1' : '0'}`,
      `strictTrack=${trackIdentityReady ? '1' : '0'}`,
      `allowDisliked=${allowDisliked ? '1' : '0'}`,
      `writesDisabled=${writesDisabled ? '1' : '0'}`,
      `sync=${this.syncStatus}`,
      `syncInFlight=${this.syncInFlight ? '1' : '0'}`,
      `preferred=${toCanonicalLikeUrl(preferredAlbumUrl) || '-'}`
    ].join(' ');
    if (resolveInputDetail !== this.lastResolveInputDebug) {
      this.lastResolveInputDebug = resolveInputDetail;
      this.pushProcessEvent('view.resolve.input', resolveInputDetail);
    }
    const resolved = buildResolvedLikeViewState(
      this.inventory,
      album,
      playlistTracks,
      syncUiState.loading,
      allowDisliked,
      trackIdentityReady,
      writesDisabled,
      likeNotice
    );
    const baseLikeState = resolved;
    const sessionOverlay = this.readSessionLikeOverlay(album, preferredAlbumUrl, playlistTracks);
    const shouldStabilize = this.syncInFlight || Boolean(sessionOverlay.albumState) || sessionOverlay.trackHits > 0;
    let likeState = baseLikeState;
    const resolveReasons: string[] = [];
    if (postSourceReset) {
      resolveReasons.push('hold-disliked=post-reset');
    }
    if (!trackIdentityReady) {
      resolveReasons.push('track-identity-untrusted');
    }
    if (shouldStabilize) {
      resolveReasons.push(this.syncInFlight ? 'stabilize=sync-in-flight' : 'stabilize=mutation-overlay');
    }
    if (sessionOverlay.albumState) {
      resolveReasons.push(`session-album=${sessionOverlay.albumState}`);
    }

    if (shouldStabilize) {
      const stabilizedAlbumState = (() => {
        if (!sessionOverlay.albumState) {
          return baseLikeState.albumState;
        }
        // During a forced post-mutation sync, keep the optimistic session state
        // authoritative unless inventory proves collection ownership.
        if (this.syncInFlight && baseLikeState.albumState !== 'bought') {
          return sessionOverlay.albumState;
        }
        return maxLikeState(baseLikeState.albumState, sessionOverlay.albumState);
      })();
      const stabilizedTrackStates: Record<number, LikeState> = {};

      playlistTracks.forEach((track, index) => {
        const sessionTrackState = sessionOverlay.trackStates.get(index);
        if (!trackIdentityReady) {
          stabilizedTrackStates[index] = sessionTrackState || 'unknown';
          return;
        }
        const resolvedTrackState = baseLikeState.trackStates[index] || 'unknown';
        const nextTrackState = sessionTrackState
          ? maxLikeState(resolvedTrackState, sessionTrackState)
          : resolvedTrackState;
        stabilizedTrackStates[index] = nextTrackState;
      });
      if (sessionOverlay.trackHits > 0) {
        resolveReasons.push(`session-tracks=${sessionOverlay.trackHits}`);
      }

      likeState = {
        ...baseLikeState,
        albumState: stabilizedAlbumState,
        trackStates: stabilizedTrackStates
      };
    }

    // Track mutations should not force album UI into unknown/loading while sync is in-flight.
    // If album identity is strict, keep album state pinned to current inventory truth.
    if (this.syncInFlight && hasStrictAlbumIdentity && likeState.albumState === 'unknown' && album) {
      const albumInventoryState = this.readInventoryLikeState({
        itemId: album.itemId,
        itemType: 'album',
        pageUrl: album.urls[0] || ''
      });
      const shouldPinAlbumInventoryState =
        albumInventoryState === 'bought' ||
        albumInventoryState === 'liked' ||
        (albumInventoryState === 'disliked' && allowDisliked);
      if (shouldPinAlbumInventoryState) {
        resolveReasons.push(`pin-album=${albumInventoryState}`);
        likeState = {
          ...likeState,
          albumState: albumInventoryState
        };
      }
    }

    // Keep album toggle optimistic behavior consistent across surfaces when track identity
    // is not trustworthy yet. If strict track identity is available, do not project album
    // state down to tracks because that can hide per-track inventory truth.
    if (shouldStabilize && this.syncInFlight && sessionOverlay.albumState && allowAlbumTrackProjection) {
      resolveReasons.push(`project-album=${sessionOverlay.albumState}`);
      const optimisticTrackStates: Record<number, LikeState> = {};
      playlistTracks.forEach((track, index) => {
        const explicitState = this.resolveExplicitTrackInventoryState(track);
        const sessionTrackState = sessionOverlay.trackStates.get(index);
        let nextState: LikeState;
        if (sessionOverlay.albumState === 'liked') {
          nextState = explicitState === 'bought' ? 'bought' : 'liked';
        } else {
          nextState = explicitState === 'liked' || explicitState === 'bought' ? explicitState : 'disliked';
        }
        if (sessionTrackState) {
          nextState = maxLikeState(nextState, sessionTrackState);
        }
        optimisticTrackStates[index] = nextState;
      });
      likeState = {
        ...likeState,
        albumState: sessionOverlay.albumState,
        trackStates: optimisticTrackStates
      };
    } else if (shouldStabilize && this.syncInFlight && sessionOverlay.albumState && hasStrictAlbumIdentity && trackIdentityReady) {
      resolveReasons.push('skip-project=strict-track-ready');
    }

    const canInferAlbumBoughtFromTracks =
      isRootNonDiscoverContext(this.contextFamily) &&
      hasStrictAlbumIdentity &&
      (likeState.albumState === 'unknown' || likeState.albumState === 'disliked') &&
      playlistTracks.length > 0;
    if (canInferAlbumBoughtFromTracks) {
      const allTracksBought = playlistTracks.every((_, index) => (likeState.trackStates[index] || 'unknown') === 'bought');
      const currentIndex = (() => {
        const active = playlistTracks.findIndex((track) => Boolean(track.isCurrent));
        return active >= 0 ? active : 0;
      })();
      const currentTrackBought = (likeState.trackStates[currentIndex] || 'unknown') === 'bought';
      const inferFromRecommendationsCurrentTrack =
        String(this.contextFamily || '').trim().toLowerCase() === 'recommendations' && currentTrackBought;
      if (allTracksBought || inferFromRecommendationsCurrentTrack) {
        resolveReasons.push(
          allTracksBought ? 'infer-album-bought=all-tracks' : 'infer-album-bought=current-track'
        );
        likeState = {
          ...likeState,
          albumState: 'bought'
        };
        this.pushProcessEvent(
          'album.infer',
          allTracksBought ? 'source=tracks-all-bought' : 'source=recommendations-current-track-bought'
        );
      }
    }

    // During sync-in-flight the base inventory is incomplete — the album may
    // not have appeared in fetched collection pages yet.  Trust the session
    // state so album display projection keeps tracks stable at "bought".
    const allowAlbumDisplaySurface =
      hasStrictAlbumIdentity &&
      (
        likeState.albumState === 'liked' ||
        (
          likeState.albumState === 'bought' &&
          (
            baseLikeState.albumState === 'bought' ||
            this.syncInFlight
          )
        )
      );
    const preAlbumDerivedLikeState = likeState;
    likeState = applyAlbumDerivedTrackDisplay(likeState, playlistTracks.length, allowAlbumDisplaySurface);
    if (
      likeState.albumState !== preAlbumDerivedLikeState.albumState ||
      !trackStatesEqual(preAlbumDerivedLikeState.trackStates, likeState.trackStates, playlistTracks.length)
    ) {
      resolveReasons.push(`apply-album-display=${likeState.albumState}`);
    } else if (hasStrictAlbumIdentity && trackIdentityReady) {
      resolveReasons.push('skip-album-display=strict-track-ready');
    }

    const resolveOutputDetail = [
      `source=${playlistSource || '-'}`,
      `album=${baseLikeState.albumState}->${likeState.albumState}`,
      `active=${formatPlaylistTrackForDebug(playlistTracks, likeState.trackStates, activeTrackIndex)}`,
      `counts=${summarizeTrackStateCounts(likeState.trackStates, playlistTracks.length)}`,
      `strictAlbum=${hasStrictAlbumIdentity ? '1' : '0'}`,
      `strictTrack=${trackIdentityReady ? '1' : '0'}`,
      `reasons=${resolveReasons.join('|') || 'direct'}`
    ].join(' ');
    if (resolveOutputDetail !== this.lastResolveOutputDebug) {
      this.lastResolveOutputDebug = resolveOutputDetail;
      this.pushProcessEvent('view.resolve.output', resolveOutputDetail);
    }

    const tracksWithLikes = applyLikeStatesToPlaylist(playlistTracks, likeState);
    return {
      likeState,
      playlistTracks: tracksWithLikes
    };
  }

  private resolveExplicitTrackInventoryState(track: PlaylistTrack): LikeState {
    return this.resolveInventoryMembershipState({
      itemType: 'track',
      itemId: normalizeLikeId(track.trackId || ''),
      canonicalUrl: toCanonicalLikeUrl(String(track.pageUrl || '')),
      allowDisliked: true
    });
  }

  private resolveSyncUiState(): { loading: boolean; terminalError: boolean } {
    const now = Date.now();
    const minIntervalMs = this.syncReason === 'fan-id-unavailable' ? FAN_ID_RETRY_BACKOFF_MS : SYNC_MIN_INTERVAL_MS;
    const retryPendingByBackoff = this.nextRetryTs > now;
    const retryPendingByMinInterval =
      this.syncStatus === 'error' &&
      this.syncReason === 'fan-id-unavailable' &&
      this.lastAttemptTs > 0 &&
      now - this.lastAttemptTs < minIntervalMs;
    const retryPending = this.syncStatus === 'error' && (retryPendingByBackoff || retryPendingByMinInterval);
    const blockingInFlight = this.syncUiBlocking && (this.syncInFlight || this.syncStatus === 'in-flight');
    const bootstrapPending =
      this.lastSyncTs === 0 &&
      (blockingInFlight || (this.syncUiBlocking && this.syncStatus === 'idle' && this.lastAttemptTs > 0));

    return {
      loading: blockingInFlight || retryPending || bootstrapPending,
      terminalError: this.syncStatus === 'error' && !retryPending
    };
  }

  public applyDebug(target: LikesDebugSnapshot): void {
    if (!this.syncInFlight && !this.syncPromise && this.syncStatus === 'in-flight') {
      this.syncStatus = this.lastSyncTs > 0 ? 'success' : 'idle';
      if (!this.syncReason || this.syncReason === 'sync-start') {
        this.syncReason = 'sync-stale-settled';
      }
    }

    // Safety net: force-settle only if the active run has stopped making forward progress.
    if (this.hasSyncStalled()) {
      this.syncInFlight = false;
      this.syncPromise = null;
      this.activeSyncRunSeq = 0;
      this.syncStatus = 'error';
      this.syncReason = 'sync-timeout';
      this.lastError = 'likes-sync-timeout';
      this.syncLastProgressAt = 0;
      this.nextRetryTs = Date.now() + ERROR_BACKOFF_MS;
      this.endpointStatus = {
        wishlist: 'timeout',
        collection: 'timeout'
      };
    }

    target.phase = 'phase-1-status';
    target.context = this.context;
    target.contextFamily = this.contextFamily;
    target.contextVariant = this.contextVariant;
    target.fanSlug = this.fanSlug;
    target.fanId = this.fanId;
    target.syncStatus = this.syncStatus;
    target.syncReason = this.syncReason;
    target.syncRunSeq = this.syncRunSeq;
    target.syncInFlightSince = this.syncInFlight ? this.syncStartedAt : 0;
    target.lastSyncTs = this.lastSyncTs;
    target.endpointStatus = { ...this.endpointStatus };
    target.endpointAttempts = { ...this.endpointAttempts };
    target.nextRetryTs = this.nextRetryTs;
    target.inventoryCounts = getLikeInventoryCounts(this.inventory);
    target.boughtCacheStatus = this.persistentBoughtCacheStatus;
    target.boughtCacheUpdatedAt = this.persistentBoughtCacheUpdatedAt;
    target.boughtCacheLastReadAt = this.persistentBoughtCacheLastReadAt;
    target.boughtCacheLastWriteAt = this.persistentBoughtCacheLastWriteAt;
    target.boughtCacheCollectionAlbumIds = this.persistentBoughtCacheCounts.collectionAlbumIds;
    target.boughtCacheCollectionTrackIds = this.persistentBoughtCacheCounts.collectionTrackIds;
    target.boughtCacheCollectionAlbumUrls = this.persistentBoughtCacheCounts.collectionAlbumUrls;
    target.boughtCacheCollectionTrackUrls = this.persistentBoughtCacheCounts.collectionTrackUrls;
    target.lastError = this.lastError;
    const existingEvents = Array.isArray(target.processEvents) ? target.processEvents : [];
    target.processEvents = mergeLikeProcessEvents(this.processEvents.slice(), existingEvents);
  }

  public isSyncInFlight(): boolean {
    return this.syncInFlight || Boolean(this.syncPromise);
  }

  public isDeepSyncInFlight(): boolean {
    return this.syncInFlight && this.activeSyncMode === 'deep';
  }

  public hasSuccessfulSync(): boolean {
    return this.syncStatus === 'success';
  }

  public shouldRunForegroundSync(): boolean {
    return (
      this.syncStatus === 'idle' ||
      this.syncStatus === 'error' ||
      this.syncReason === 'not-started' ||
      this.syncReason.startsWith('reset:')
    );
  }

  private shouldForceFollowUpDeepSyncForFocus(
    focusIdentities: Array<LikeIdentity | null | undefined>
  ): boolean {
    const normalizedIdentities = focusIdentities
      .map((identity) => buildLikeIdentity(identity))
      .filter((identity): identity is LikeIdentityInput => Boolean(identity));
    if (!normalizedIdentities.length) {
      return true;
    }

    let sawBought = false;
    for (const identity of normalizedIdentities) {
      const state = this.readInventoryLikeState({
        itemId: identity.itemId,
        itemType: identity.itemType,
        pageUrl: identity.urls[0] || ''
      });
      if (state === 'liked' || state === 'unknown' || state === 'disliked') {
        return true;
      }
      if (state === 'bought') {
        sawBought = true;
      }
    }
    return !sawBought ? true : false;
  }

  public shouldRunDeepSync(
    focusIdentities: Array<LikeIdentity | null | undefined> = [],
    now = Date.now()
  ): boolean {
    if (this.isSyncInFlight() || this.shouldRunForegroundSync()) {
      return false;
    }
    if (this.lastMutationTs > 0 && now - this.lastMutationTs < MUTATION_DEEP_SYNC_SUPPRESS_MS) {
      return false;
    }
    if (this.nextRetryTs > now) {
      return false;
    }
    if (this.isSharedInventoryStale(now)) {
      return true;
    }
    if (this.isInventoryReady()) {
      return false;
    }
    if (this.syncStatus === 'success' && !this.shouldForceFollowUpDeepSyncForFocus(focusIdentities)) {
      return false;
    }
    return this.syncStatus === 'success' || this.syncStatus === 'error';
  }

  private resolveSyncFocusSummary(input: SyncInput): SyncFocusSummary {
    const albumIdentity = buildLikeIdentity(input.focusAlbumIdentity || null);
    const trackIdentityMap = new Map<string, LikeIdentityInput>();
    (input.focusTrackIdentities || [])
      .map((identity) => buildLikeIdentity(identity))
      .filter((identity): identity is LikeIdentityInput => Boolean(identity))
      .forEach((identity) => {
        const truthKey = buildFocusTruthKey(identity);
        if (truthKey && !trackIdentityMap.has(truthKey)) {
          trackIdentityMap.set(truthKey, identity);
        }
      });
    const trackIdentities = Array.from(trackIdentityMap.values());

    return {
      albumIdentity,
      trackIdentities
    };
  }

  public isInventoryReady(): boolean {
    return (
      this.syncStatus === 'success' &&
      this.syncReason === 'inventory-ready' &&
      !this.syncInFlight &&
      endpointStatusIsComplete(this.endpointStatus.wishlist) &&
      endpointStatusIsComplete(this.endpointStatus.collection)
    );
  }

  private shouldSkipSyncStart(input: SyncInput, now: number): boolean {
    if (this.rapidOriginJumpCooldownUntil > now) {
      const waitMs = this.rapidOriginJumpCooldownUntil - now;
      this.nextRetryTs = Math.max(this.nextRetryTs, this.rapidOriginJumpCooldownUntil);
      this.pushProcessEvent('sync.skipped', `rapid-origin-cooldown:${waitMs}ms`);
      return true;
    }
    if (this.syncPromise) {
      return true;
    }

    // Keep resolved status stable: after a successful sync, avoid re-fetching
    // unless explicitly forced. Exception: allow one refresh after reset-soft
    // on Discover where origin switching is highly dynamic.
    const allowResetSoftRefresh =
      this.syncReason.startsWith('reset-soft:') &&
      String(this.contextFamily || '').trim().toLowerCase() === 'discover';
    if (!input.force && this.syncStatus === 'success' && !allowResetSoftRefresh) {
      return true;
    }

    const minIntervalMs = this.syncReason === 'fan-id-unavailable' ? FAN_ID_RETRY_BACKOFF_MS : SYNC_MIN_INTERVAL_MS;
    const shouldApplyMinInterval = this.syncStatus !== 'error' || this.syncReason === 'fan-id-unavailable';
    if (!input.force && shouldApplyMinInterval && this.lastAttemptTs > 0 && now - this.lastAttemptTs < minIntervalMs) {
      return true;
    }

    const resetSoftBackoffBypass = this.syncReason.startsWith('reset-soft:');
    if (!input.force && this.nextRetryTs > now && !resetSoftBackoffBypass) {
      this.pushProcessEvent('sync.skipped', `retry-backoff-until:${this.nextRetryTs}`);
      return true;
    }
    if (!input.force && this.nextRetryTs > now && resetSoftBackoffBypass) {
      this.pushProcessEvent('sync.skipped', `retry-backoff-bypassed:${this.nextRetryTs}`);
    }

    return false;
  }

  public async sync(input: SyncInput): Promise<boolean> {
    const requestedMode = 'deep';
    const isSilentRun = Boolean(input.silent);
    const now = Date.now();
    const deepTrigger = this.resolveDeepSyncTrigger(now);
    if (this.shouldSkipSyncStart(input, now)) {
      return false;
    }

    const runSeq = ++this.syncRunSeq;
    this.activeSyncRunSeq = runSeq;
    this.activeSyncMode = requestedMode;
    this.syncUiBlocking = !isSilentRun;

    this.lastAttemptTs = now;
    this.syncStartedAt = now;
    this.syncLastProgressAt = now;
    this.syncStatus = 'in-flight';
    this.syncReason = 'sync-start';
    this.syncInFlight = true;
    this.pushProcessEvent(
      'sync.start',
      `run=${runSeq} force=${input.force ? '1' : '0'} mode=${requestedMode} silent=${isSilentRun ? '1' : '0'}${deepTrigger ? ` trigger=${deepTrigger.reason} ageMs=${deepTrigger.ageMs}` : ''}`
    );
    this.lastError = '';
    this.nextRetryTs = 0;
    this.endpointStatus = {
      wishlist: 'fetching',
      collection: 'fetching'
    };
    this.endpointAttempts = {
      wishlist: 0,
      collection: 0
    };

    const guardedRun = Promise.race<boolean>([
      this.runSync(input, runSeq, isSilentRun),
      this.waitForSyncStall(runSeq)
    ]);
    const activePromise = guardedRun
      .catch((error) => {
        if (!this.isRunActive(runSeq)) {
          return false;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (isSilentRun && this.lastSyncTs > 0) {
          this.syncStatus = 'success';
          this.syncReason = 'background-sync-failed';
          this.lastError = message;
          this.nextRetryTs = Date.now() + ERROR_BACKOFF_MS;
          this.pushProcessEvent('sync.error', `background:${message}`);
          this.activeSyncRunSeq = 0;
          this.syncStartedAt = 0;
          this.syncLastProgressAt = 0;
          return false;
        }
        this.syncStatus = 'error';
        this.syncReason = message.includes('likes-sync-timeout') ? 'sync-timeout' : 'sync-exception';
        this.lastError = message;
        this.nextRetryTs = Date.now() + ERROR_BACKOFF_MS;
        this.pushProcessEvent('sync.error', `${this.syncReason}:${message}`);
        this.endpointStatus = {
          wishlist: 'timeout',
          collection: 'timeout'
        };
        this.activeSyncRunSeq = 0;
        this.syncStartedAt = 0;
        this.syncLastProgressAt = 0;
        return false;
      })
      .finally(() => {
        if (this.isRunActive(runSeq)) {
          this.activeSyncRunSeq = 0;
          this.activeSyncMode = 'none';
          this.syncInFlight = false;
        }
        if (this.activeSyncRunSeq === 0) {
          this.syncStartedAt = 0;
          this.syncLastProgressAt = 0;
        }
        if (this.syncPromise === activePromise) {
          this.syncPromise = null;
          this.syncInFlight = false;
          this.syncUiBlocking = true;
        }
        this.pushProcessEvent('sync.finally', `run=${runSeq} status=${this.syncStatus}`);
      });

    this.syncPromise = activePromise;

    return this.syncPromise;
  }

  private async runSync(input: SyncInput, runSeq: number, silent: boolean): Promise<boolean> {
    this.contextFamily = String(input.contextFamily || this.contextFamily || '').trim();
    this.contextVariant = String(input.contextVariant || this.contextVariant || '').trim();
    const fanSlug = String(input.fanSlugHint || this.fanSlug || '').trim().toLowerCase();
    if (fanSlug) {
      this.fanSlug = fanSlug;
      this.pushProcessEvent('fan.slug', fanSlug);
    }

    const fanId = await this.resolveFanId(input.fanIdHint, runSeq);
    if (!this.isRunActive(runSeq)) {
      return false;
    }

    if (!fanId) {
      if (silent && this.lastSyncTs > 0) {
        this.syncStatus = 'success';
        this.syncReason = 'background-sync-skipped';
        this.lastError = 'fan-id-unavailable';
        this.nextRetryTs = 0;
        this.pushProcessEvent('fan.id.missing', `run=${runSeq}:background`);
        return false;
      }
      this.syncStatus = 'error';
      this.syncReason = 'fan-id-unavailable';
      this.lastError = 'Unable to resolve fan id';
      this.nextRetryTs = Date.now() + FAN_ID_RETRY_BACKOFF_MS;
      this.endpointStatus = {
        wishlist: 'fan-id-missing',
        collection: 'fan-id-missing'
      };
      this.pushProcessEvent('fan.id.missing', `run=${runSeq}`);
      return false;
    }
    this.fanId = fanId;
    this.markSyncProgress();
    this.pushProcessEvent('fan.id.resolved', fanId);
    const hydratedFromPersistentBoughtCache = await this.hydrateFromPersistentBoughtCache(fanId);
    if (!this.isRunActive(runSeq)) {
      return false;
    }
    this.markSyncProgress();
    if (hydratedFromPersistentBoughtCache) {
      this.pushProcessEvent('bought.cache.hit', `fan=${fanId}`);
    }
    const hydratedFromSharedCache = await this.hydrateFromSharedCache(fanId);
    if (!this.isRunActive(runSeq)) {
      return false;
    }
    this.markSyncProgress();
    if (hydratedFromSharedCache) {
      this.pushProcessEvent('shared.cache.hit', `fan=${fanId} force=${input.force ? '1' : '0'}`);
    }
    const focusSummary = this.resolveSyncFocusSummary(input);
    const shouldVerifyFocusedInventory =
      !silent &&
      this.hasCompleteInventoryCoverage() &&
      this.shouldForceFollowUpDeepSyncForFocus([
        input.focusAlbumIdentity,
        input.focusTrackIdentity,
        ...(input.focusTrackIdentities || [])
      ]);

    if (!input.force && this.hasCompleteInventoryCoverage() && !shouldVerifyFocusedInventory) {
      this.pushProcessEvent('sync.success', `run=${runSeq} reason=shared-cache`);
      return true;
    }
    if (shouldVerifyFocusedInventory) {
      this.pushProcessEvent('shared.cache.verify-focus', `run=${runSeq}`);
    }
    const focusedWishlistSnapshot = createEmptyEndpointSnapshot();
    const focusedCollectionSnapshot = createEmptyEndpointSnapshot();

    const [wishlistResult, collectionResult] = await Promise.all([
      this.syncEndpoint(
        'wishlist_items',
        fanId,
        buildSyntheticStartToken('wishlist_items'),
        runSeq,
        focusedWishlistSnapshot
      ),
      this.syncEndpoint(
        'collection_items',
        fanId,
        buildSyntheticStartToken('collection_items'),
        runSeq,
        focusedCollectionSnapshot
      )
    ]);
    if (!this.isRunActive(runSeq)) {
      return false;
    }

    this.pushProcessEvent(
      'sync.seed.summary',
        [
          `album=${focusSummary.albumIdentity ? '1' : '0'}`,
          `tracks=${focusSummary.trackIdentities.length}`,
          'wishlistSeed=synthetic',
          'collectionSeed=synthetic'
        ].join(' ')
      );

    this.endpointAttempts = {
      wishlist: wishlistResult.attempts,
      collection: collectionResult.attempts
    };
    this.endpointStatus = {
      wishlist: wishlistResult.status,
      collection: collectionResult.status
    };
    this.pushProcessEvent('endpoint.summary', `w=${wishlistResult.status};c=${collectionResult.status}`);

    if (wishlistResult.ok) {
      replaceEndpointData('wishlist_items', wishlistResult.snapshot, this.inventory);
      this.cacheStrictAlbumIdentityFromSnapshot(wishlistResult.snapshot);
      this.pushProcessEvent('endpoint.apply', `wishlist pages=${wishlistResult.pages}`);
    }
    if (collectionResult.ok) {
      replaceEndpointData('collection_items', collectionResult.snapshot, this.inventory);
      this.cacheStrictAlbumIdentityFromSnapshot(collectionResult.snapshot);
      this.pushProcessEvent('endpoint.apply', `collection pages=${collectionResult.pages}`);
    }

    if (!wishlistResult.ok && !collectionResult.ok) {
      const maxRetry = Math.max(wishlistResult.retryAfterMs, collectionResult.retryAfterMs, ERROR_BACKOFF_MS);
      if (silent && this.lastSyncTs > 0) {
        this.syncStatus = 'success';
        this.syncReason = 'background-sync-failed';
        this.lastError = `wishlist=${wishlistResult.error};collection=${collectionResult.error}`;
        this.nextRetryTs = Date.now() + maxRetry;
        this.pushProcessEvent('sync.failed', `background:${this.lastError}`);
        return false;
      }
      this.syncStatus = 'error';
      this.syncReason = 'sync-failed';
      this.lastError = `wishlist=${wishlistResult.error};collection=${collectionResult.error}`;
      this.nextRetryTs = Date.now() + maxRetry;
      this.pushProcessEvent('sync.failed', this.lastError);
      return false;
    }

    this.syncStatus = 'success';
    const hasCompleteCoverage =
      endpointStatusIsComplete(wishlistResult.status) && endpointStatusIsComplete(collectionResult.status);
    this.syncReason = hasCompleteCoverage ? 'inventory-ready' : 'inventory-partial';
    this.lastError = '';
    this.lastSyncTs = Date.now();
    this.nextRetryTs = 0;
    if (hasCompleteCoverage) {
      this.publishSharedCache('sync-complete');
      if (collectionResult.ok && endpointStatusIsComplete(collectionResult.status)) {
        this.publishPersistentBoughtCache('sync-complete');
      }
    }
    this.pushProcessEvent('sync.success', `run=${runSeq} reason=${this.syncReason}`);
    return true;
  }

  private async resolveFanId(fanIdHint: string, runSeq: number): Promise<string> {
    let fanId = normalizeLikeId(fanIdHint || this.fanId);
    if (fanId) {
      this.pushProcessEvent('fan.id.hint', fanId);
      return fanId;
    }

    try {
      await this.paceRapidRequests(runSeq);
      if (!this.isRunActive(runSeq)) {
        return '';
      }
      const resolved = await resolveViewerFanId({
        timeoutMs: MESSAGE_TIMEOUT_MS,
        fanSlugHint: this.fanSlug || undefined
      });
      fanId = normalizeLikeId(resolved.fanId);
      if (fanId) {
        this.pushProcessEvent('fan.id.viewer', `${fanId}:${resolved.source}`);
        return fanId;
      }
    } catch {
      this.pushProcessEvent('fan.id.viewer-error', 'resolve-viewer-fan-id-error');
      return '';
    }

    this.pushProcessEvent('fan.id.viewer-missing', 'source=unavailable');
    return '';
  }

  private async syncEndpoint(
    endpoint: FanEndpoint,
    fanId: string,
    bootstrapToken: string,
    runSeq: number,
    initialSnapshot: EndpointSnapshot | null
  ): Promise<EndpointSyncResult> {
    const snapshot = initialSnapshot ? initialSnapshot : createEmptyEndpointSnapshot();
    const pushEndpointEvent = (stage: 'request' | 'error' | 'retry' | 'complete', detail: string): void => {
      this.pushProcessEvent(`endpoint.${stage}.${endpoint}`, detail);
    };
    const shouldDeferLongRetry = (waitMs: number): boolean => {
      const remainingMs = this.getRemainingSyncBudgetMs();
      return remainingMs > 0 && waitMs >= Math.max(1000, remainingMs - 500);
    };
    let attempts = 0;
    let pages = 0;
    let token = bootstrapToken;
    let lastError = '';
    let retryAfterMs = 0;
    let continuationToken = '';
    let endpointRetryLimit = ENDPOINT_DEFAULT_MAX_ATTEMPTS;
    if (
      endpoint === 'collection_items' &&
      (isRootNonDiscoverContext(this.contextFamily) || String(this.contextFamily || '').trim().toLowerCase() === 'feed')
    ) {
      endpointRetryLimit = ENDPOINT_DEEP_COLLECTION_MAX_ATTEMPTS;
    }
    let consecutiveRetryAttempts = 0;

    if (!token) {
      pushEndpointEvent('error', 'seed-token-unavailable');
      return {
        ok: false,
        endpoint,
        attempts,
        pages,
        nextToken: '',
        snapshot,
        status: 'error:pages=0:seed-token-unavailable',
        error: 'seed-token-unavailable',
        retryAfterMs
      };
    }
    this.pushProcessEvent(`token.${endpoint}`, 'source=synthetic');

    // Deep sync should exhaust pagination. We only stop on completion, abort,
    // or a sustained retry/failure condition.
    while (this.isRunActive(runSeq)) {
      await this.paceRapidRequests(runSeq);
      if (!this.isRunActive(runSeq)) {
        break;
      }
      attempts += 1;
      pushEndpointEvent(
        'request',
        `attempt=${attempts} pages=${pages}`
      );
      let response: {
        ok?: boolean;
        data?: unknown;
        error?: string;
        status?: number;
        retryAfterMs?: number;
      } | null = null;
      try {
        response = await sendMessageWithTimeout<{
          ok?: boolean;
          data?: unknown;
          error?: string;
          status?: number;
          retryAfterMs?: number;
        }>(
          {
            type: 'FETCH_FANCOLLECTION_ITEMS',
            endpoint,
            fanId,
            olderThanToken: token,
            count: LIKES_FANCOLLECTION_PAGE_SIZE
          },
          LIKES_FANCOLLECTION_MESSAGE_TIMEOUT_MS
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'request-timeout');
        lastError = `network-error:${message}`;
        retryAfterMs = 0;
        consecutiveRetryAttempts += 1;
        pushEndpointEvent('error', `attempt=${attempts} pages=${pages} error=${lastError}`);
        if (consecutiveRetryAttempts >= endpointRetryLimit) {
          return {
            ok: false,
            endpoint,
            attempts,
            pages,
            nextToken: continuationToken,
            snapshot,
            status: `error:pages=${pages}:${lastError}`,
            error: lastError,
            retryAfterMs
          };
        }
        const waitMs = toBackoffMs(consecutiveRetryAttempts, retryAfterMs);
        if (shouldDeferLongRetry(waitMs)) {
          const deferredError = `deferred-backoff:${waitMs}`;
          pushEndpointEvent('complete', `pages=${pages} attempts=${attempts} reason=${deferredError}`);
          return {
            ok: false,
            endpoint,
            attempts,
            pages,
            nextToken: continuationToken,
            snapshot,
            status: `error:pages=${pages}:${deferredError}`,
            error: deferredError,
            retryAfterMs: waitMs
          };
        }
        pushEndpointEvent('retry', `attempt=${attempts} pages=${pages} waitMs=${waitMs} reason=${lastError}`);
        await sleep(waitMs);
        continue;
      }

      if (!response?.ok) {
        const status = Number(response?.status || 0);
        const error = String(response?.error || 'request-failed');
        lastError = error;
        retryAfterMs = Number(response?.retryAfterMs || 0);
        pushEndpointEvent(
          'error',
          `attempt=${attempts} pages=${pages} status=${status || '-'} retryAfterMs=${retryAfterMs || 0} error=${error}`
        );
        const retryable =
          status === 429 ||
          status >= 500 ||
          error.startsWith('network-error');
        if (!retryable) {
          return {
            ok: false,
            endpoint,
            attempts,
            pages,
            nextToken: continuationToken,
            snapshot,
            status: `error:pages=${pages}:${error}`,
            error,
            retryAfterMs
          };
        }

        consecutiveRetryAttempts += 1;
        if (consecutiveRetryAttempts >= endpointRetryLimit) {
          return {
            ok: false,
            endpoint,
            attempts,
            pages,
            nextToken: continuationToken,
            snapshot,
            status: `error:pages=${pages}:${error}`,
            error,
            retryAfterMs
          };
        }

        const waitMs = toBackoffMs(consecutiveRetryAttempts, retryAfterMs);
        if (shouldDeferLongRetry(waitMs)) {
          const deferredError = `deferred-backoff:${waitMs}`;
          pushEndpointEvent('complete', `pages=${pages} attempts=${attempts} reason=${deferredError}`);
          return {
            ok: false,
            endpoint,
            attempts,
            pages,
            nextToken: continuationToken,
            snapshot,
            status: `error:pages=${pages}:${deferredError}`,
            error: deferredError,
            retryAfterMs: waitMs
          };
        }
        pushEndpointEvent('retry', `attempt=${attempts} pages=${pages} waitMs=${waitMs} reason=${error}`);
        await sleep(waitMs);
        continue;
      }

      applyPayloadToSnapshot(response.data, snapshot);
      consecutiveRetryAttempts = 0;
      pages += 1;
      const paging = extractFanItemsPaging(response.data);
      continuationToken =
        paging.moreAvailable && paging.nextToken && paging.nextToken !== token
          ? paging.nextToken
          : '';
      if (this.isRunActive(runSeq)) {
        this.markSyncProgress();
        this.cacheStrictAlbumIdentityFromSnapshot(snapshot);
        const endpointKey = endpoint === 'wishlist_items' ? 'wishlist' : 'collection';
        this.endpointStatus = {
          ...this.endpointStatus,
          [endpointKey]: `fetching:pages=${pages}`
        };
        this.endpointAttempts = {
          ...this.endpointAttempts,
          [endpointKey]: attempts
        };
        this.pushProcessEvent(`endpoint.page.${endpoint}`, `pages=${pages} attempts=${attempts}`);
      }
      if (!paging.moreAvailable || !paging.nextToken || paging.nextToken === token) {
        continuationToken = '';
        pushEndpointEvent('complete', `pages=${pages} attempts=${attempts} reason=complete`);
        return {
          ok: true,
          endpoint,
          attempts,
          pages,
          nextToken: '',
          snapshot,
          status: `ok:pages=${pages}:complete`,
          error: '',
          retryAfterMs: 0
        };
      }
      token = paging.nextToken;
      continuationToken = token;
      await sleep(PAGE_REQUEST_SPACING_MS);
    }

    if (!this.isRunActive(runSeq)) {
      pushEndpointEvent('error', `pages=${pages} attempts=${attempts} error=aborted`);
      return {
        ok: false,
        endpoint,
        attempts,
        pages,
        nextToken: continuationToken,
        snapshot,
        status: `error:pages=${pages}:aborted`,
        error: 'aborted',
        retryAfterMs: 0
      };
    }

    pushEndpointEvent('error', `pages=${pages} attempts=${attempts} error=${lastError || 'unexpected-loop-exit'}`);
    return {
      ok: false,
      endpoint,
      attempts,
      pages,
      nextToken: continuationToken,
      snapshot,
      status: `error:pages=${pages}:${lastError || 'unexpected-loop-exit'}`,
      error: lastError || 'unexpected-loop-exit',
      retryAfterMs
    };
  }

  private isRunActive(runSeq: number): boolean {
    return this.activeSyncRunSeq === runSeq;
  }

  private markSyncProgress(): void {
    this.syncLastProgressAt = Date.now();
  }

  private hasSyncStalled(now = Date.now()): boolean {
    if (!this.syncInFlight) {
      return false;
    }
    const progressTs = this.syncLastProgressAt > 0 ? this.syncLastProgressAt : this.syncStartedAt;
    return progressTs > 0 && now - progressTs > SYNC_STALL_TIMEOUT_MS;
  }

  private async waitForSyncStall(runSeq: number): Promise<boolean> {
    while (this.isRunActive(runSeq)) {
      const remainingMs = this.getRemainingSyncBudgetMs();
      if (remainingMs <= 0) {
        throw new Error('likes-sync-timeout');
      }
      await sleep(Math.min(1000, remainingMs));
    }
    return false;
  }

  private getRemainingSyncBudgetMs(): number {
    const progressTs = this.syncLastProgressAt > 0 ? this.syncLastProgressAt : this.syncStartedAt;
    if (progressTs <= 0) {
      return SYNC_STALL_TIMEOUT_MS;
    }
    return Math.max(0, progressTs + SYNC_STALL_TIMEOUT_MS - Date.now());
  }

  private async paceRapidRequests(runSeq: number): Promise<void> {
    if (!this.isRunActive(runSeq)) {
      return;
    }

    if (this.rapidOriginJumpCooldownUntil > Date.now()) {
      const waitMs = this.rapidOriginJumpCooldownUntil - Date.now();
      this.pushProcessEvent('endpoint.cooldown', `waitMs=${waitMs}`);
      await sleep(waitMs);
      if (!this.isRunActive(runSeq)) {
        return;
      }
    }
  }

  private trackRapidOriginJumpBurst(reason: string): void {
    if (!this.isBurstTrackedOriginJump(reason)) {
      return;
    }

    const now = Date.now();
    if (this.lastOriginJumpTs > 0 && now - this.lastOriginJumpTs <= RAPID_ORIGIN_JUMP_WINDOW_MS) {
      this.rapidOriginJumpCount += 1;
    } else {
      this.rapidOriginJumpCount = 1;
    }
    this.lastOriginJumpTs = now;

    this.pushProcessEvent(
      'burst.jump',
      `count=${this.rapidOriginJumpCount}/${RAPID_ORIGIN_JUMP_BURST_LIMIT},window=${RAPID_ORIGIN_JUMP_WINDOW_MS}ms`
    );

    if (this.rapidOriginJumpCount < RAPID_ORIGIN_JUMP_BURST_LIMIT) {
      return;
    }

    this.rapidOriginJumpCount = 0;
    this.rapidOriginJumpCooldownUntil = now + RAPID_ORIGIN_JUMP_COOLDOWN_MS;
    this.nextRetryTs = Math.max(this.nextRetryTs, this.rapidOriginJumpCooldownUntil);
    this.pushProcessEvent('burst.cooldown', `trigger=${RAPID_ORIGIN_JUMP_COOLDOWN_MS}ms`);
  }

  private isBurstTrackedOriginJump(reason: string): boolean {
    const normalized = String(reason || '').trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized.includes('collect') || normalized.includes('uncollect')) {
      return false;
    }
    return (
      normalized.includes('origin-jump') ||
      normalized.includes('origin-switch') ||
      normalized.includes('playlist-jump')
    );
  }

  private pushProcessEvent(stage: string, detail: string): void {
    this.processEvents.push({
      ts: Date.now(),
      stage: String(stage || '-'),
      detail: String(detail || '-')
    });
    if (this.processEvents.length > MAX_LIKES_PROCESS_EVENTS) {
      const overflowCount = this.processEvents.length - MAX_LIKES_PROCESS_EVENTS;
      const now = Date.now();
      if (now - lastProcessOverflowWarnAt >= PROCESS_OVERFLOW_WARN_INTERVAL_MS) {
        lastProcessOverflowWarnAt = now;
        logger.warn(`process-log overflow: truncating ${overflowCount} oldest entries`);
      }
      this.processEvents.splice(0, this.processEvents.length - MAX_LIKES_PROCESS_EVENTS);
    }
  }

  private cacheStrictAlbumIdentity(identity: LikeIdentityInput): void {
    const itemId = normalizeLikeId(identity.itemId || '');
    if (!itemId || identity.itemType !== 'album') {
      return;
    }
    identity.urls.forEach((rawUrl) => {
      const canonicalUrl = toCanonicalLikeUrl(rawUrl);
      if (!canonicalUrl) {
        return;
      }
      this.strictAlbumIdentityByUrl.set(canonicalUrl, {
        itemId,
        itemType: 'album',
        urls: [canonicalUrl]
      });
    });
  }

  private cacheStrictAlbumIdentityFromSnapshot(snapshot: EndpointSnapshot): void {
    snapshot.albumIdByUrl.forEach((itemIdRaw, rawUrl) => {
      const itemId = normalizeLikeId(itemIdRaw || '');
      const canonicalUrl = toCanonicalLikeUrl(rawUrl);
      if (!itemId || !canonicalUrl) {
        return;
      }
      this.strictAlbumIdentityByUrl.set(canonicalUrl, {
        itemId,
        itemType: 'album',
        urls: [canonicalUrl]
      });
    });
  }

  public resolveStrictAlbumIdentityForUrl(
    preferredAlbumUrl: string,
    playlistTracks: PlaylistTrack[] = []
  ): LikeIdentity | null {
    const cached = this.resolveCachedAlbumIdentityForPlaylist(playlistTracks, preferredAlbumUrl);
    if (!cached || cached.itemType !== 'album') {
      return null;
    }
    const itemId = normalizeLikeId(cached.itemId || '');
    if (!itemId) {
      return null;
    }
    const canonicalUrl =
      toCanonicalLikeUrl(preferredAlbumUrl) ||
      toCanonicalLikeUrl(cached.urls[0] || '') ||
      toCanonicalLikeUrl(window.location.href);
    return {
      itemId,
      itemType: 'album',
      pageUrl: canonicalUrl
    };
  }

  private resolveCachedAlbumIdentityForPlaylist(
    playlistTracks: PlaylistTrack[],
    preferredAlbumUrl = ''
  ): LikeIdentityInput | null {
    const preferredAlbumCanonicalUrl = toCanonicalLikeUrl(String(preferredAlbumUrl || ''));
    if (preferredAlbumCanonicalUrl) {
      const preferredAlbumMatch = this.strictAlbumIdentityByUrl.get(preferredAlbumCanonicalUrl);
      if (preferredAlbumMatch) {
        return preferredAlbumMatch;
      }
    }

    if (!playlistTracks.length) {
      return null;
    }

    const currentTrack = playlistTracks.find((track) => track.isCurrent) || playlistTracks[0];
    const preferredUrl = toCanonicalLikeUrl(String(currentTrack?.pageUrl || ''));
    if (preferredUrl) {
      const preferredMatch = this.strictAlbumIdentityByUrl.get(preferredUrl);
      if (preferredMatch) {
        return preferredMatch;
      }
    }

    for (const track of playlistTracks) {
      const canonicalUrl = toCanonicalLikeUrl(String(track.pageUrl || ''));
      if (!canonicalUrl) {
        continue;
      }
      const match = this.strictAlbumIdentityByUrl.get(canonicalUrl);
      if (match) {
        return match;
      }
    }

    return null;
  }
}

export function buildLikeSyncInputFromPageContext(
  pageContext: PageContext,
  force = false,
  contextOverride?: { family: string; variant: string }
): SyncInput {
  const fanSlugHint = pageContext.isFanRoot
    ? String(pageContext.fanSlug || '').trim().toLowerCase()
    : '';
  const fanIdHint = '';
  return {
    fanIdHint,
    fanSlugHint,
    contextFamily: String(contextOverride?.family || pageContext.likeContextFamily || '').trim(),
    contextVariant: String(contextOverride?.variant || pageContext.likeContextVariant || '').trim(),
    force
  };
}

export function logLikeSyncStart(context: string): void {
  logger.debug('LIKES sync start', { context });
}
