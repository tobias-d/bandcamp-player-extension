// Promise wrappers over the extension's persistent storage area, shared by the
// background caches (analysis-result cache + persistent bought-likes cache) so
// they cannot drift. Prefers chrome.storage.local, falls back to sync, and
// resolves to a null/no-op when no storage API is available (e.g. a context
// without the permission). The callback APIs never reject, so neither do these.
import { browserApi } from '@/utils/browser-api';

function getStorageArea(): chrome.storage.StorageArea | null {
  return browserApi.storage?.local || browserApi.storage?.sync || null;
}

export function storageGet<T>(key: string): Promise<T | null> {
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

export function storageSet(key: string, value: unknown): Promise<void> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    area.set({ [key]: value }, () => resolve());
  });
}

export function storageRemove(key: string): Promise<void> {
  const area = getStorageArea();
  if (!area) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    area.remove(key, () => resolve());
  });
}
