import { SHARED_LIKES_CACHE_MAX_AGE_MS } from '@/shared/constants';
import type { SharedLikesCacheSnapshot } from '@/shared/types';
const sharedLikesCacheByFanId = new Map<string, SharedLikesCacheSnapshot>();

function normalizeFanId(value: unknown): string {
  return String(value ?? '').replace(/[^\d]/g, '').trim();
}

function isExpired(snapshot: SharedLikesCacheSnapshot, now = Date.now()): boolean {
  const updatedAt = Number(snapshot.updatedAt || 0);
  return !updatedAt || now - updatedAt > SHARED_LIKES_CACHE_MAX_AGE_MS;
}

export function readSharedLikesCache(fanIdRaw: unknown): SharedLikesCacheSnapshot | null {
  const fanId = normalizeFanId(fanIdRaw);
  if (!fanId) {
    return null;
  }
  const snapshot = sharedLikesCacheByFanId.get(fanId) || null;
  if (!snapshot) {
    return null;
  }
  if (isExpired(snapshot)) {
    sharedLikesCacheByFanId.delete(fanId);
    return null;
  }
  return snapshot;
}

export function writeSharedLikesCache(snapshot: SharedLikesCacheSnapshot): SharedLikesCacheSnapshot | null {
  const fanId = normalizeFanId(snapshot.fanId);
  if (!fanId) {
    return null;
  }
  const normalized: SharedLikesCacheSnapshot = {
    ...snapshot,
    fanId,
    fanSlug: String(snapshot.fanSlug || '').trim().toLowerCase(),
    updatedAt: Math.max(1, Number(snapshot.updatedAt || Date.now()))
  };
  const existing = sharedLikesCacheByFanId.get(fanId) || null;
  if (existing && Number(existing.updatedAt || 0) > normalized.updatedAt) {
    return existing;
  }
  sharedLikesCacheByFanId.set(fanId, normalized);
  return normalized;
}
