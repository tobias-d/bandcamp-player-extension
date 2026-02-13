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
 * @version 2026-02-13
 */

/**
 * Get the appropriate storage area (sync or local)
 * 
 * @param {object} api - Browser API object (from api.js)
 * @returns {object|null} Storage area object or null if unavailable
 */
export function getStorageArea(api) {
  return api?.storage && (api.storage.sync || api.storage.local)
    ? (api.storage.sync || api.storage.local)
    : null;
}

/**
 * Get values from storage with defaults
 * 
 * @param {object} api - Browser API object
 * @param {object} defaults - Default values to return if keys don't exist
 * @returns {Promise<object>} Resolves with stored values or defaults
 */
export function storageGet(api, defaults) {
  const area = getStorageArea(api);
  if (!area) return Promise.resolve({ ...defaults });
  return new Promise((resolve) => area.get(defaults, (res) => resolve(res || { ...defaults })));
}

/**
 * Set values in storage
 * 
 * @param {object} api - Browser API object
 * @param {object} obj - Key-value pairs to store
 * @returns {Promise<void>} Resolves when storage operation completes
 */
export function storageSet(api, obj) {
  const area = getStorageArea(api);
  if (!area) return Promise.resolve();
  return new Promise((resolve) => area.set(obj, () => resolve()));
}

/**
 * Retrieve the stored beat mode preference
 * 
 * @param {object} api - Browser API object
 * @returns {Promise<string>} Resolves with 'auto', 'straight', or 'breakbeat'
 */
export async function getBeatModeStored(api) {
  const res = await storageGet(api, { beatMode: 'auto' });
  const mode = res?.beatMode;
  return (mode === 'auto' || mode === 'straight' || mode === 'breakbeat') ? mode : 'auto';
}

/**
 * Store beat mode preference
 * 
 * @param {object} api - Browser API object
 * @param {string} beatMode - Mode to store ('auto', 'straight', or 'breakbeat')
 * @returns {Promise<object>} Resolves with {ok: boolean, beatMode?: string}
 */
export async function setBeatModeStored(api, beatMode) {
  if (!['auto', 'straight', 'breakbeat'].includes(beatMode)) return { ok: false };
  await storageSet(api, { beatMode });
  return { ok: true, beatMode };
}
