import { dom, injectStylesheet } from '@/utils/dom';
import { copyThemeVars } from '@/utils/theme';

// Generic viewport-centered confirm/explainer modal used for opt-in settings (Performance mode,
// Key analysis). It mounts on document.body — a true viewport modal — because a popover's
// backdrop-filter containing block cannot trap a position:fixed card. Theme tokens are copied from
// a source element at open time so the card matches the current panel theme.
const CONFIRM_STYLE_ID = 'bc-player-confirm-dialog-styles';
const CONFIRM_THEME_VARS = [
  '--panel-surface-bg',
  '--panel-text',
  '--panel-text-dim',
  '--panel-divider',
  '--panel-border',
  '--panel-surface-active'
] as const;
const CONFIRM_CSS = `
.bc-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483020;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.42);
}
.bc-confirm-backdrop.is-visible {
  display: flex;
}
.bc-confirm-card {
  box-sizing: border-box;
  width: 320px;
  max-width: 100%;
  padding: 16px 18px 14px;
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel-surface-bg) 86%, white 14%);
  color: var(--panel-text);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(30px) saturate(150%);
  -webkit-backdrop-filter: blur(30px) saturate(150%);
}
.bc-confirm-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}
.bc-confirm-body {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--panel-text-dim, var(--panel-text));
}
.bc-confirm-body strong {
  font-weight: 700;
  color: var(--panel-text);
}
.bc-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.bc-confirm-btn {
  border: 0;
  border-radius: 7px;
  padding: 0 12px;
  height: 26px;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  cursor: pointer;
}
.bc-confirm-cancel {
  background: color-mix(in srgb, var(--panel-surface-active) 72%, transparent);
  color: var(--panel-text);
}
.bc-confirm-go {
  background: #83b154;
  color: #fff;
}
.bc-confirm-btn:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}
`;

export interface ConfirmDialogContent {
  title: string;
  // Body nodes (not a flat string) so parts can be bold via dom('strong', …).
  body: (string | Node)[];
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm(): void;
}

export interface ConfirmDialog {
  open(content: ConfirmDialogContent): void;
  destroy(): void;
}

export function createConfirmDialog(themeSource: HTMLElement, ariaLabel: string): ConfirmDialog {
  injectStylesheet(CONFIRM_STYLE_ID, CONFIRM_CSS);
  const backdrop = dom('div', { class: 'bc-confirm-backdrop' });
  const card = dom('div', { class: 'bc-confirm-card', role: 'dialog', 'aria-label': ariaLabel });
  const titleEl = dom('div', { class: 'bc-confirm-title' }, ['']);
  const bodyEl = dom('p', { class: 'bc-confirm-body' }, ['']);
  const cancelButton = dom('button', { class: 'bc-confirm-btn bc-confirm-cancel', type: 'button' }, ['Cancel']) as HTMLButtonElement;
  const goButton = dom('button', { class: 'bc-confirm-btn bc-confirm-go', type: 'button' }, ['']) as HTMLButtonElement;
  const actions = dom('div', { class: 'bc-confirm-actions' }, [cancelButton, goButton]);
  card.appendChild(titleEl);
  card.appendChild(bodyEl);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  let pendingConfirm: (() => void) | null = null;
  const close = (): void => backdrop.classList.remove('is-visible');

  card.addEventListener('click', (event) => event.stopPropagation());
  backdrop.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  goButton.addEventListener('click', () => {
    close();
    pendingConfirm?.();
  });

  return {
    open(content) {
      pendingConfirm = content.onConfirm;
      titleEl.textContent = content.title;
      bodyEl.replaceChildren(...content.body);
      goButton.textContent = content.confirmLabel;
      cancelButton.textContent = content.cancelLabel ?? 'Cancel';
      copyThemeVars(themeSource, backdrop, CONFIRM_THEME_VARS);
      backdrop.classList.add('is-visible');
    },
    destroy() {
      backdrop.remove();
    }
  };
}
