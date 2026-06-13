import type { PersistentBoughtLikesSnapshot } from '@/shared/types';
import { browserApi } from '@/utils/browser-api';

const PERSISTENT_BOUGHT_LIKES_CACHE_STORAGE_KEY = 'persistent_bought_likes_cache_v1';

let loaded = false;
let loadPromise: Promise<void> | null = null;
const persistentBoughtLikesByFanId = new Map<string, PersistentBoughtLikesSnapshot>();

function getStorageArea(): chrome.storage.StorageArea | null {
  return browserApi.storage?.local || browserApi.storage?.sync || null;
}

function normalizeFanId(value: unknown): string {
  return String(value ?? '').replace(/[^\d]/g, '').trim();
}

function normalizeUrl(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeInventory(snapshot: PersistentBoughtLikesSnapshot['inventory'] | null | undefined) {
  return {
    collectionAlbumIds: Array.from(new Set((snapshot?.collectionAlbumIds || []).map((value) => normalizeFanId(value)).filter(Boolean))),
    collectionTrackIds: Array.from(new Set((snapshot?.collectionTrackIds || []).map((value) => normalizeFanId(value)).filter(Boolean))),
    collectionAlbumUrls: Array.from(new Set((snapshot?.collectionAlbumUrls || []).map((value) => normalizeUrl(value)).filter(Boolean))),
    collectionTrackUrls: Array.from(new Set((snapshot?.collectionTrackUrls || []).map((value) => normalizeUrl(value)).filter(Boolean)))
  };
}

function normalizeSnapshot(snapshot: PersistentBoughtLikesSnapshot): PersistentBoughtLikesSnapshot | null {
  const fanId = normalizeFanId(snapshot?.fanId);
  if (!fanId) {
    return null;
  }
  return {
    fanId,
    fanSlug: String(snapshot?.fanSlug || '').trim().toLowerCase(),
    inventory: normalizeInventory(snapshot?.inventory),
    updatedAt: Math.max(1, Number(snapshot?.updatedAt || Date.now()))
  };
}

function storageGet<T>(key: string): Promise<T | null> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    area.get(key, (result) => {
      resolve((result?.[key] as T) ?? null);
    });
  });
}

function storageSet(key: string, value: unknown): Promise<void> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    area.set({ [key]: value }, () => resolve());
  });
}

async function ensureLoaded(): Promise<void> {
  if (loaded) {
    return;
  }
  if (loadPromise) {
    return loadPromise;
  }
  loadPromise = (async () => {
    const payload = await storageGet<Record<string, PersistentBoughtLikesSnapshot>>(PERSISTENT_BOUGHT_LIKES_CACHE_STORAGE_KEY);
    persistentBoughtLikesByFanId.clear();
    Object.entries(payload || {}).forEach(([fanIdRaw, snapshot]) => {
      const normalized = normalizeSnapshot({
        ...snapshot,
        fanId: snapshot?.fanId || fanIdRaw
      } as PersistentBoughtLikesSnapshot);
      if (!normalized) {
        return;
      }
      persistentBoughtLikesByFanId.set(normalized.fanId, normalized);
    });
    loaded = true;
    loadPromise = null;
  })();
  return loadPromise;
}

async function flush(): Promise<void> {
  const payload = Array.from(persistentBoughtLikesByFanId.entries()).reduce<Record<string, PersistentBoughtLikesSnapshot>>(
    (acc, [fanId, snapshot]) => {
      acc[fanId] = snapshot;
      return acc;
    },
    {}
  );
  await storageSet(PERSISTENT_BOUGHT_LIKES_CACHE_STORAGE_KEY, payload);
}

export async function readPersistentBoughtLikesCache(fanIdRaw: unknown): Promise<PersistentBoughtLikesSnapshot | null> {
  const fanId = normalizeFanId(fanIdRaw);
  if (!fanId) {
    return null;
  }
  await ensureLoaded();
  return persistentBoughtLikesByFanId.get(fanId) || null;
}

export async function writePersistentBoughtLikesCache(
  snapshot: PersistentBoughtLikesSnapshot
): Promise<PersistentBoughtLikesSnapshot | null> {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) {
    return null;
  }
  await ensureLoaded();
  const existing = persistentBoughtLikesByFanId.get(normalized.fanId) || null;
  const merged: PersistentBoughtLikesSnapshot = {
    fanId: normalized.fanId,
    fanSlug: normalized.fanSlug || existing?.fanSlug || '',
    updatedAt: Math.max(Number(existing?.updatedAt || 0), normalized.updatedAt),
    inventory: {
      collectionAlbumIds: Array.from(new Set([...(existing?.inventory.collectionAlbumIds || []), ...normalized.inventory.collectionAlbumIds])),
      collectionTrackIds: Array.from(new Set([...(existing?.inventory.collectionTrackIds || []), ...normalized.inventory.collectionTrackIds])),
      collectionAlbumUrls: Array.from(new Set([...(existing?.inventory.collectionAlbumUrls || []), ...normalized.inventory.collectionAlbumUrls])),
      collectionTrackUrls: Array.from(new Set([...(existing?.inventory.collectionTrackUrls || []), ...normalized.inventory.collectionTrackUrls]))
    }
  };
  persistentBoughtLikesByFanId.set(merged.fanId, merged);
  await flush();
  return merged;
}
