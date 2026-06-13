export type KeyboardShortcutAction =
  | 'toggle-play-pause'
  | 'previous-track'
  | 'next-track'
  | 'seek-backward'
  | 'seek-forward'
  | 'tap-tempo'
  | 'tempo-up'
  | 'tempo-down';

export type KeyboardShortcutMap = Record<KeyboardShortcutAction, string>;

export interface KeyboardShortcutDefinition {
  action: KeyboardShortcutAction;
  label: string;
}

export const KEYBOARD_SHORTCUT_DEFINITIONS: KeyboardShortcutDefinition[] = [
  { action: 'toggle-play-pause', label: 'Play / Pause' },
  { action: 'previous-track', label: 'Previous track' },
  { action: 'next-track', label: 'Next track' },
  { action: 'seek-backward', label: 'Seek backward' },
  { action: 'seek-forward', label: 'Seek forward' },
  { action: 'tap-tempo', label: 'Tap tempo' },
  { action: 'tempo-up', label: 'Increase tempo' },
  { action: 'tempo-down', label: 'Decrease tempo' }
];

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  'toggle-play-pause': ' ',
  'previous-track': 'b',
  'next-track': 'n',
  'seek-backward': 'ArrowLeft',
  'seek-forward': 'ArrowRight',
  'tap-tempo': 't',
  'tempo-up': 'ArrowUp',
  'tempo-down': 'ArrowDown'
};

const NAMED_KEY_LABELS: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: 'Arrow Left',
  ArrowRight: 'Arrow Right',
  ArrowUp: 'Arrow Up',
  ArrowDown: 'Arrow Down'
};

export function normalizeShortcutKey(value: unknown): string {
  const raw = String(value ?? '');
  if (raw === ' ' || raw === 'Spacebar' || raw === 'Space') {
    return ' ';
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length === 1) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

export function normalizeShortcutMap(value: unknown): KeyboardShortcutMap {
  const input = value && typeof value === 'object'
    ? value as Partial<Record<KeyboardShortcutAction, unknown>>
    : {};
  const normalized = { ...DEFAULT_KEYBOARD_SHORTCUTS };
  KEYBOARD_SHORTCUT_DEFINITIONS.forEach(({ action }) => {
    const key = normalizeShortcutKey(input[action]);
    if (key) {
      normalized[action] = key;
    }
  });
  return normalized;
}

export function shortcutKeyFromKeyboardEvent(event: KeyboardEvent): string {
  if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
    return ' ';
  }
  return normalizeShortcutKey(event.key);
}

export function formatShortcutKey(key: string): string {
  const normalized = normalizeShortcutKey(key);
  if (NAMED_KEY_LABELS[normalized]) {
    return NAMED_KEY_LABELS[normalized];
  }
  if (normalized.length === 1) {
    return normalized.toUpperCase();
  }
  return normalized || 'Unassigned';
}

export function findShortcutActionByKey(
  shortcuts: KeyboardShortcutMap,
  key: string
): KeyboardShortcutAction | null {
  const normalizedKey = normalizeShortcutKey(key);
  if (!normalizedKey) {
    return null;
  }
  for (const { action } of KEYBOARD_SHORTCUT_DEFINITIONS) {
    if (normalizeShortcutKey(shortcuts[action]) === normalizedKey) {
      return action;
    }
  }
  return null;
}
