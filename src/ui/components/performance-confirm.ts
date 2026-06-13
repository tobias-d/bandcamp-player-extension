import { dom, injectStylesheet } from '@/utils/dom';

// Chrome-only confirm dialog for the Performance-mode toggle, shared by the settings row and the
// welcome gate so both open the exact same explainer. Theme tokens are copied from a source element
// at open time because the dialog mounts on document.body (a true viewport modal, so a popover's
// backdrop-filter containing block cannot trap its position:fixed).
const PERF_CONFIRM_STYLE_ID = 'bc-player-performance-mode-confirm-styles';
const PERF_CONFIRM_THEME_VARS = [
  '--panel-surface-bg',
  '--panel-text',
  '--panel-text-dim',
  '--panel-divider',
  '--panel-border',
  '--panel-surface-active'
] as const;
const PERF_CONFIRM_CSS = `
.bc-perf-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483020;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.42);
}
.bc-perf-confirm-backdrop.is-visible {
  display: flex;
}
.bc-perf-confirm-card {
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
.bc-perf-confirm-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}
.bc-perf-confirm-body {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--panel-text-dim, var(--panel-text));
}
.bc-perf-confirm-body strong {
  font-weight: 700;
  color: var(--panel-text);
}
.bc-perf-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.bc-perf-confirm-btn {
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
.bc-perf-confirm-cancel {
  background: color-mix(in srgb, var(--panel-surface-active) 72%, transparent);
  color: var(--panel-text);
}
.bc-perf-confirm-go {
  background: #83b154;
  color: #fff;
}
.bc-perf-confirm-btn:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}
`;

// Body content is built from nodes (not a flat string) so the RAM requirement can be bold.
function performanceConfirmBodyNodes(next: boolean): (string | Node)[] {
  if (!next) {
    return ['This switches back to normal memory use. The page will reload to apply the change.'];
  }
  return [
    'Performance mode loads more of your playlist ahead of time, so jumping between tracks and ' +
      'skipping around stays instant even in long lists. ',
    dom('strong', {}, ['Only turn this on if your computer has at least 16 GB of memory (RAM)']),
    ', because it keeps a lot more music ready in the background and uses noticeably more memory. ' +
      'The page will reload to apply the change.'
  ];
}

export interface PerformanceConfirmDialog {
  // Opens the explainer for a pending change. The toggle is not flipped/persisted here; only on
  // confirm do we call onConfirm and reload the tab so the engine picks up the new predecode policy
  // (it reads the policy once at construction). Cancel leaves everything untouched.
  open(next: boolean, onConfirm: (next: boolean) => void): void;
  destroy(): void;
}

export function createPerformanceConfirmDialog(themeSource: HTMLElement): PerformanceConfirmDialog {
  injectStylesheet(PERF_CONFIRM_STYLE_ID, PERF_CONFIRM_CSS);
  const backdrop = dom('div', { class: 'bc-perf-confirm-backdrop' });
  const card = dom('div', { class: 'bc-perf-confirm-card', role: 'dialog', 'aria-label': 'Performance mode' });
  const confirmTitle = dom('div', { class: 'bc-perf-confirm-title' }, ['Performance mode']);
  const confirmBody = dom('p', { class: 'bc-perf-confirm-body' }, ['']);
  const cancelButton = dom('button', { class: 'bc-perf-confirm-btn bc-perf-confirm-cancel', type: 'button' }, ['Cancel']) as HTMLButtonElement;
  const goButton = dom('button', { class: 'bc-perf-confirm-btn bc-perf-confirm-go', type: 'button' }, ['Enable & reload']) as HTMLButtonElement;
  const actions = dom('div', { class: 'bc-perf-confirm-actions' }, [cancelButton, goButton]);
  card.appendChild(confirmTitle);
  card.appendChild(confirmBody);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  let pendingNext = false;
  let pendingConfirm: ((next: boolean) => void) | null = null;
  const closeConfirm = (): void => backdrop.classList.remove('is-visible');

  card.addEventListener('click', (event) => event.stopPropagation());
  backdrop.addEventListener('click', closeConfirm);
  cancelButton.addEventListener('click', closeConfirm);
  goButton.addEventListener('click', () => {
    closeConfirm();
    pendingConfirm?.(pendingNext);
    window.location.reload();
  });

  return {
    open(next, onConfirm) {
      pendingNext = next;
      pendingConfirm = onConfirm;
      confirmBody.replaceChildren(...performanceConfirmBodyNodes(next));
      goButton.textContent = next ? 'Enable & reload' : 'Disable & reload';
      const sourceStyles = window.getComputedStyle(themeSource);
      for (const variable of PERF_CONFIRM_THEME_VARS) {
        const value = sourceStyles.getPropertyValue(variable).trim();
        if (value) {
          backdrop.style.setProperty(variable, value);
        }
      }
      backdrop.classList.add('is-visible');
    },
    destroy() {
      backdrop.remove();
    }
  };
}
