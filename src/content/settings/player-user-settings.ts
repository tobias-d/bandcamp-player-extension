import {
  normalizeShortcutMap,
  type KeyboardShortcutMap
} from '@/shared/keyboard-shortcuts';

export interface PlayerUserSettings {
  preloadTracks: boolean;
  keyAnalysisEnabled: boolean;
  autoPlayEnabled: boolean;
  // Chrome-only opt-in higher predecode tier. Persisted unconditionally; the Chrome-only gate
  // is enforced in code (index.ts) so a synced/edited `true` cannot activate on Firefox.
  performanceModeEnabled: boolean;
  keyboardShortcuts: KeyboardShortcutMap;
}

const STORAGE_KEY = 'bc-player:user-settings:v1';

const DEFAULT_SETTINGS: PlayerUserSettings = {
  preloadTracks: true,
  keyAnalysisEnabled: false,
  autoPlayEnabled: true,
  performanceModeEnabled: false,
  keyboardShortcuts: normalizeShortcutMap(null)
};

function cloneDefaultSettings(): PlayerUserSettings {
  return {
    ...DEFAULT_SETTINGS,
    keyboardShortcuts: { ...DEFAULT_SETTINGS.keyboardShortcuts }
  };
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

export function readPersistedPlayerUserSettings(): PlayerUserSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return cloneDefaultSettings();
    }
    const parsed = JSON.parse(raw) as Partial<PlayerUserSettings> & { autoPreload?: unknown };
    const preloadTracks = coerceBoolean(
      parsed?.preloadTracks,
      coerceBoolean(parsed?.autoPreload, DEFAULT_SETTINGS.preloadTracks)
    );
    return {
      preloadTracks,
      keyAnalysisEnabled: coerceBoolean(parsed?.keyAnalysisEnabled, DEFAULT_SETTINGS.keyAnalysisEnabled),
      autoPlayEnabled: coerceBoolean(parsed?.autoPlayEnabled, DEFAULT_SETTINGS.autoPlayEnabled),
      performanceModeEnabled: coerceBoolean(parsed?.performanceModeEnabled, DEFAULT_SETTINGS.performanceModeEnabled),
      keyboardShortcuts: normalizeShortcutMap(parsed?.keyboardShortcuts)
    };
  } catch {
    return cloneDefaultSettings();
  }
}

export function writePersistedPlayerUserSettings(settings: PlayerUserSettings): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        preloadTracks: Boolean(settings.preloadTracks),
        // Backward compatibility for users on prior builds.
        autoPreload: Boolean(settings.preloadTracks),
        keyAnalysisEnabled: Boolean(settings.keyAnalysisEnabled),
        autoPlayEnabled: Boolean(settings.autoPlayEnabled),
        performanceModeEnabled: Boolean(settings.performanceModeEnabled),
        keyboardShortcuts: normalizeShortcutMap(settings.keyboardShortcuts)
      })
    );
  } catch {
    // Ignore storage write failures to keep runtime behavior intact.
  }
}
