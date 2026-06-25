import {
  readPersistedPlayerUserSettings,
  writePersistedPlayerUserSettings
} from '@/content/settings/player-user-settings';
import {
  normalizeShortcutMap,
  type KeyboardShortcutMap
} from '@/shared/keyboard-shortcuts';

export interface SettingsController {
  readonly preloadTracksEnabled: boolean;
  readonly keyAnalysisEnabled: boolean;
  readonly listeningModeEnabled: boolean;
  readonly autoPlayEnabled: boolean;
  readonly performanceModeEnabled: boolean;
  readonly keyboardShortcuts: KeyboardShortcutMap;
  setPreloadTracksEnabled(enabled: boolean): void;
  setKeyAnalysisEnabled(enabled: boolean): void;
  setListeningModeEnabled(enabled: boolean): void;
  setAutoPlayEnabled(enabled: boolean): void;
  setPerformanceModeEnabled(enabled: boolean): void;
  setKeyboardShortcuts(shortcuts: KeyboardShortcutMap): void;
}

export interface SettingsControllerCallbacks {
  onPreloadTracksChanged(enabled: boolean): void;
  onKeyAnalysisChanged(enabled: boolean): void;
  onListeningModeChanged(enabled: boolean): void;
  onAutoPlayChanged(enabled: boolean): void;
  onPerformanceModeChanged(enabled: boolean): void;
  onKeyboardShortcutsChanged(shortcuts: KeyboardShortcutMap): void;
}

export function createSettingsController(
  callbacks: SettingsControllerCallbacks
): SettingsController {
  const persisted = readPersistedPlayerUserSettings();
  let _preloadTracksEnabled = persisted.preloadTracks;
  let _keyAnalysisEnabled = persisted.keyAnalysisEnabled;
  let _listeningModeEnabled = persisted.listeningModeEnabled;
  let _autoPlayEnabled = persisted.autoPlayEnabled;
  let _performanceModeEnabled = persisted.performanceModeEnabled;
  let _keyboardShortcuts = normalizeShortcutMap(persisted.keyboardShortcuts);

  const persist = (): void => {
    writePersistedPlayerUserSettings({
      preloadTracks: _preloadTracksEnabled,
      keyAnalysisEnabled: _keyAnalysisEnabled,
      listeningModeEnabled: _listeningModeEnabled,
      autoPlayEnabled: _autoPlayEnabled,
      performanceModeEnabled: _performanceModeEnabled,
      keyboardShortcuts: _keyboardShortcuts
    });
  };

  return {
    get preloadTracksEnabled() {
      return _preloadTracksEnabled;
    },
    get keyAnalysisEnabled() {
      return _keyAnalysisEnabled;
    },
    get listeningModeEnabled() {
      return _listeningModeEnabled;
    },
    get autoPlayEnabled() {
      return _autoPlayEnabled;
    },
    get performanceModeEnabled() {
      return _performanceModeEnabled;
    },
    get keyboardShortcuts() {
      return { ..._keyboardShortcuts };
    },
    setPreloadTracksEnabled(enabled: boolean) {
      _preloadTracksEnabled = Boolean(enabled);
      persist();
      callbacks.onPreloadTracksChanged(_preloadTracksEnabled);
    },
    setKeyAnalysisEnabled(enabled: boolean) {
      _keyAnalysisEnabled = Boolean(enabled);
      persist();
      callbacks.onKeyAnalysisChanged(_keyAnalysisEnabled);
    },
    setListeningModeEnabled(enabled: boolean) {
      _listeningModeEnabled = Boolean(enabled);
      persist();
      callbacks.onListeningModeChanged(_listeningModeEnabled);
    },
    setAutoPlayEnabled(enabled: boolean) {
      _autoPlayEnabled = Boolean(enabled);
      persist();
      callbacks.onAutoPlayChanged(_autoPlayEnabled);
    },
    setPerformanceModeEnabled(enabled: boolean) {
      _performanceModeEnabled = Boolean(enabled);
      persist();
      callbacks.onPerformanceModeChanged(_performanceModeEnabled);
    },
    setKeyboardShortcuts(shortcuts: KeyboardShortcutMap) {
      _keyboardShortcuts = normalizeShortcutMap(shortcuts);
      persist();
      callbacks.onKeyboardShortcutsChanged({ ..._keyboardShortcuts });
    }
  };
}
