/**
 * ============================================================================
 * BROWSER STORAGE UTILITIES
 * ============================================================================
 * 
 * Provides promise-based wrappers around the browser storage API.
 * Manages persistent storage of user preferences, specifically beat mode settings.
 * 
 * STORAGE HIERARCHY:
 * 1. Prefers sync storage (synced across devices if available)
 * 2. Falls back to local storage
 * 3. Gracefully handles missing storage API
 * 
 * BEAT MODES:
 * - 'auto': Automatically detect straight vs breakbeat
 * - 'straight': Force straight/four-on-the-floor beat detection
 * - 'breakbeat': Force breakbeat/syncopated beat detection
 * 
 * @module background/storage
 * @version 2026-02-15-typescript
 */

import type { BeatMode } from '../shared/index';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Browser API object (chrome or browser namespace)
 */
interface BrowserAPI {
  storage?: {
    sync?: chrome.storage.StorageArea;
    local?: chrome.storage.StorageArea;
  };
}

/**
 * Storage result for beat mode
 */
interface BeatModeStorage {
  beatMode: BeatMode;
}

/**
 * Result of setting beat mode
 */
interface SetBeatModeResult {
  ok: boolean;
  beatMode?: BeatMode;
}

// ============================================================================
// STORAGE FUNCTIONS
// ============================================================================

/**
 * Get the appropriate storage area (sync or local)
 * 
 * @param api - Browser API object (from api.ts)
 * @returns Storage area object or null if unavailable
 */
export function getStorageArea(api: BrowserAPI): chrome.storage.StorageArea | null {
  if (!api?.storage) return null;
  return api.storage.sync || api.storage.local || null;
}

/**
 * Get values from storage with defaults
 * 
 * @param api - Browser API object
 * @param defaults - Default values to return if keys don't exist
 * @returns Promise resolving with stored values or defaults
 */
export function storageGet<T extends Record<string, any>>(
  api: BrowserAPI,
  defaults: T
): Promise<T> {
  const area = getStorageArea(api);
  if (!area) return Promise.resolve({ ...defaults });
  
  return new Promise((resolve) => {
    area.get(defaults, (res) => {
      resolve((res as T) || { ...defaults });
    });
  });
}

/**
 * Set values in storage
 * 
 * @param api - Browser API object
 * @param obj - Key-value pairs to store
 * @returns Promise resolving when storage operation completes
 */
export function storageSet(
  api: BrowserAPI,
  obj: Record<string, any>
): Promise<void> {
  const area = getStorageArea(api);
  if (!area) return Promise.resolve();
  
  return new Promise((resolve) => {
    area.set(obj, () => resolve());
  });
}

/**
 * Retrieve the stored beat mode preference
 * 
 * @param api - Browser API object
 * @returns Promise resolving with 'auto', 'straight', or 'breakbeat'
 */
export async function getBeatModeStored(api: BrowserAPI): Promise<BeatMode> {
  const res = await storageGet<BeatModeStorage>(api, { beatMode: 'auto' });
  const mode = res?.beatMode;
  
  // Type guard: ensure we only return valid BeatMode values
  return (mode === 'auto' || mode === 'straight' || mode === 'breakbeat') 
    ? mode 
    : 'auto';
}

/**
 * Store beat mode preference
 * 
 * @param api - Browser API object
 * @param beatMode - Mode to store ('auto', 'straight', or 'breakbeat')
 * @returns Promise resolving with result status and stored mode
 */
export async function setBeatModeStored(
  api: BrowserAPI,
  beatMode: string
): Promise<SetBeatModeResult> {
  // Type guard: validate input is a valid BeatMode
  const validModes: BeatMode[] = ['auto', 'straight', 'breakbeat'];
  if (!validModes.includes(beatMode as BeatMode)) {
    return { ok: false };
  }
  
  await storageSet(api, { beatMode });
  return { ok: true, beatMode: beatMode as BeatMode };
}
