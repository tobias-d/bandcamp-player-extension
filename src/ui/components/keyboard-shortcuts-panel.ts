import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_DEFINITIONS,
  findShortcutActionByKey,
  formatShortcutKey,
  normalizeShortcutMap,
  shortcutKeyFromKeyboardEvent,
  type KeyboardShortcutAction,
  type KeyboardShortcutMap
} from '@/shared/keyboard-shortcuts';
import { dom, setText } from '@/utils/dom';

interface KeyboardShortcutsPanelHandlers {
  onChange(shortcuts: KeyboardShortcutMap): void;
}

interface KeyboardShortcutsPanelUpdateInput {
  hidden: boolean;
  shortcuts?: KeyboardShortcutMap;
}

export interface KeyboardShortcutsPanelComponent {
  update(input: KeyboardShortcutsPanelUpdateInput): void;
  destroy(): void;
}

function labelForAction(action: KeyboardShortcutAction): string {
  return KEYBOARD_SHORTCUT_DEFINITIONS.find((item) => item.action === action)?.label || action;
}

export function createKeyboardShortcutsPanel(
  container: HTMLElement,
  handlers: KeyboardShortcutsPanelHandlers
): KeyboardShortcutsPanelComponent {
  const root = dom('div', { class: 'bc-shortcuts-panel bc-context-popover' });
  const title = dom('div', { class: 'bc-settings-title' }, ['Keyboard shortcuts']);
  const list = dom('div', { class: 'bc-shortcuts-list' });
  const notice = dom('div', { class: 'bc-shortcuts-notice', role: 'status' });
  const resetButton = dom(
    'button',
    {
      class: 'bc-shortcuts-reset-btn',
      type: 'button'
    },
    ['Reset defaults']
  ) as HTMLButtonElement;

  root.appendChild(title);
  root.appendChild(list);
  root.appendChild(notice);
  root.appendChild(resetButton);
  root.style.display = 'none';
  root.addEventListener('click', (event) => event.stopPropagation());
  root.addEventListener('keydown', (event) => event.stopPropagation());

  let shortcuts = normalizeShortcutMap(null);
  let captureAction: KeyboardShortcutAction | null = null;
  const buttons = new Map<KeyboardShortcutAction, HTMLButtonElement>();

  const setNotice = (message: string): void => {
    setText(notice, message);
    notice.classList.toggle('is-visible', Boolean(message));
  };

  const syncView = (): void => {
    KEYBOARD_SHORTCUT_DEFINITIONS.forEach(({ action }) => {
      const button = buttons.get(action);
      if (!button) {
        return;
      }
      const isCapturing = captureAction === action;
      setText(button, isCapturing ? 'Press key' : formatShortcutKey(shortcuts[action]));
      button.classList.toggle('is-capturing', isCapturing);
      button.setAttribute('aria-pressed', isCapturing ? 'true' : 'false');
    });
  };

  const commitShortcut = (action: KeyboardShortcutAction, key: string): void => {
    const existingAction = findShortcutActionByKey(shortcuts, key);
    if (existingAction && existingAction !== action) {
      setNotice(`${formatShortcutKey(key)} is already used for ${labelForAction(existingAction)}.`);
      captureAction = null;
      syncView();
      return;
    }

    shortcuts = normalizeShortcutMap({
      ...shortcuts,
      [action]: key
    });
    captureAction = null;
    setNotice('');
    syncView();
    handlers.onChange({ ...shortcuts });
  };

  KEYBOARD_SHORTCUT_DEFINITIONS.forEach(({ action, label }) => {
    const row = dom('div', { class: 'bc-shortcuts-row' });
    const rowLabel = dom('span', { class: 'bc-settings-label' }, [label]);
    const button = dom(
      'button',
      {
        class: 'bc-shortcuts-key-btn',
        type: 'button',
        'aria-pressed': 'false'
      },
      [formatShortcutKey(shortcuts[action])]
    ) as HTMLButtonElement;

    button.addEventListener('click', () => {
      captureAction = action;
      setNotice('');
      syncView();
      button.focus();
    });

    button.addEventListener('keydown', (event) => {
      if (captureAction !== action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        captureAction = null;
        setNotice('');
        syncView();
        return;
      }
      const key = shortcutKeyFromKeyboardEvent(event);
      if (!key) {
        return;
      }
      commitShortcut(action, key);
    });

    buttons.set(action, button);
    row.appendChild(rowLabel);
    row.appendChild(button);
    list.appendChild(row);
  });

  resetButton.addEventListener('click', () => {
    shortcuts = normalizeShortcutMap(DEFAULT_KEYBOARD_SHORTCUTS);
    captureAction = null;
    setNotice('');
    syncView();
    handlers.onChange({ ...shortcuts });
  });

  container.appendChild(root);
  syncView();

  return {
    update(input) {
      root.style.display = input.hidden ? 'none' : 'block';
      if (input.hidden) {
        captureAction = null;
        setNotice('');
      }
      shortcuts = normalizeShortcutMap(input.shortcuts);
      syncView();
    },
    destroy() {
      root.remove();
    }
  };
}
