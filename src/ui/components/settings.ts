import { dom } from '@/utils/dom';
import { createPerformanceConfirmDialog, PerformanceConfirmDialog } from '@/ui/components/performance-confirm';
import { createConfirmDialog, ConfirmDialog } from '@/ui/components/confirm-dialog';

// Explainer shown when the user turns Key analysis ON. Built from nodes so app names can be bold.
// It is opt-in because key detection is subjective, so we set expectations before enabling it.
function keyAnalysisConfirmBodyNodes(): (string | Node)[] {
  return [
    'Key analysis is optional because it is ',
    dom('strong', {}, ['never a fully objective measurement']),
    '. Different tools listen to a track in different ways, so the same song can read differently in apps like ',
    dom('strong', {}, ['Rekordbox']),
    ' or ',
    dom('strong', {}, ['Mixed In Key']),
    ' — a different result does not mean one is wrong. Turn it on to add key estimates to your tracks.'
  ];
}

interface SettingsHandlers {
  onTogglePreloadTracks(enabled: boolean): void;
  onToggleKeyAnalysis(enabled: boolean): void;
  onToggleAutoPlay(enabled: boolean): void;
  onTogglePerformanceMode(enabled: boolean): void;
  onOpenKeyboardShortcuts(): void;
  onEditAppearance(): void;
}

interface SettingsUpdateInput {
  hidden: boolean;
  preloadTracks: boolean;
  keyAnalysisEnabled: boolean;
  autoPlayEnabled: boolean;
  performanceModeEnabled: boolean;
}

export interface SettingsComponent {
  update(input: SettingsUpdateInput): void;
  destroy(): void;
}

export function createSettings(container: HTMLElement, handlers: SettingsHandlers): SettingsComponent {
  const root = dom('div', { class: 'bc-settings bc-context-popover' });
  const title = dom('div', { class: 'bc-settings-title' }, ['Settings']);
  const list = dom('div', { class: 'bc-settings-list' });

  const preloadRow = dom('div', { class: 'bc-settings-row' });
  const preloadText = dom('span', { class: 'bc-settings-label' }, ['Preload tracks']);
  const preloadToggle = dom('button', {
    class: 'bc-settings-toggle-btn',
    type: 'button',
    role: 'switch',
    'aria-label': 'Toggle track preloading',
    'aria-pressed': 'false'
  }) as HTMLButtonElement;
  preloadRow.appendChild(preloadText);
  preloadRow.appendChild(preloadToggle);

  const keyRow = dom('div', { class: 'bc-settings-row' });
  const keyText = dom('span', { class: 'bc-settings-label' }, ['Analyze Key']);
  const keyToggle = dom('button', {
    class: 'bc-settings-toggle-btn',
    type: 'button',
    role: 'switch',
    'aria-label': 'Toggle key analysis',
    'aria-pressed': 'false'
  }) as HTMLButtonElement;
  keyRow.appendChild(keyText);
  keyRow.appendChild(keyToggle);

  const autoPlayRow = dom('div', { class: 'bc-settings-row' });
  const autoPlayText = dom('span', { class: 'bc-settings-label' }, ['Auto-play next track']);
  const autoPlayToggle = dom('button', {
    class: 'bc-settings-toggle-btn',
    type: 'button',
    role: 'switch',
    'aria-label': 'Toggle auto-play next track',
    'aria-pressed': 'false'
  }) as HTMLButtonElement;
  autoPlayRow.appendChild(autoPlayText);
  autoPlayRow.appendChild(autoPlayToggle);

  // Performance mode is Chrome-only (Chrome caps deviceMemory at 8, so high-RAM machines need an
  // explicit opt-in to use the headroom). The build-time __BUILD_TARGET__ guard removes the whole
  // row from the Firefox bundle, so the toggle cannot even be shown there.
  let performanceRow: HTMLElement | null = null;
  let performanceToggle: HTMLButtonElement | null = null;
  // Opens the confirm dialog for a pending toggle change; null on Firefox (row not built).
  let openPerformanceConfirm: ((next: boolean) => void) | null = null;
  // Body-mounted confirm dialog, tracked so destroy() can remove it (it is not under root).
  let performanceConfirm: PerformanceConfirmDialog | null = null;
  if (__BUILD_TARGET__ === 'chrome') {
    performanceRow = dom('div', { class: 'bc-settings-row' });
    const performanceText = dom('span', { class: 'bc-settings-label' }, ['Performance mode']);
    performanceToggle = dom('button', {
      class: 'bc-settings-toggle-btn',
      type: 'button',
      role: 'switch',
      'aria-label': 'Toggle performance mode',
      'aria-pressed': 'false'
    }) as HTMLButtonElement;
    performanceRow.appendChild(performanceText);
    performanceRow.appendChild(performanceToggle);

    // Pressing the toggle does not flip/persist immediately; it opens the shared confirm dialog,
    // and only on confirm does the dialog persist the change and reload the tab so the engine picks
    // up the new predecode policy (it reads the policy once at construction).
    performanceConfirm = createPerformanceConfirmDialog(root);
    openPerformanceConfirm = (next: boolean): void => {
      performanceConfirm?.open(next, handlers.onTogglePerformanceMode);
    };
  }

  // Turning Key analysis ON opens this explainer first (same modal style as Performance mode). Only
  // on confirm do we call the handler; cancel leaves the toggle off. Turning it OFF needs no dialog.
  const keyConfirm: ConfirmDialog = createConfirmDialog(root, 'Key analysis');

  const shortcutsRow = dom('div', { class: 'bc-settings-row' });
  const shortcutsText = dom('span', { class: 'bc-settings-label' }, ['Keyboard shortcuts']);
  const shortcutsButton = dom(
    'button',
    {
      class: 'bc-settings-action-btn',
      type: 'button',
      'aria-label': 'Open keyboard shortcuts'
    },
    ['Edit']
  ) as HTMLButtonElement;
  shortcutsRow.appendChild(shortcutsText);
  shortcutsRow.appendChild(shortcutsButton);

  const glassRow = dom('div', { class: 'bc-settings-row' });
  const glassText = dom('span', { class: 'bc-settings-label' }, ['Appearance']);
  const glassButton = dom(
    'button',
    {
      class: 'bc-settings-action-btn',
      type: 'button',
      'aria-label': 'Edit appearance'
    },
    ['Edit']
  ) as HTMLButtonElement;
  glassRow.appendChild(glassText);
  glassRow.appendChild(glassButton);

  list.appendChild(preloadRow);
  list.appendChild(keyRow);
  list.appendChild(autoPlayRow);
  if (performanceRow) {
    list.appendChild(performanceRow);
  }
  list.appendChild(shortcutsRow);
  list.appendChild(glassRow);
  root.appendChild(title);
  root.appendChild(list);
  root.style.display = 'none';
  root.addEventListener('click', (event) => event.stopPropagation());

  const setToggleState = (toggle: HTMLButtonElement, enabled: boolean): void => {
    toggle.classList.toggle('is-on', enabled);
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  };

  const readToggleState = (toggle: HTMLButtonElement): boolean =>
    toggle.getAttribute('aria-pressed') === 'true';

  preloadToggle.addEventListener('click', () => {
    const next = !readToggleState(preloadToggle);
    setToggleState(preloadToggle, next);
    handlers.onTogglePreloadTracks(next);
  });

  keyToggle.addEventListener('click', () => {
    const next = !readToggleState(keyToggle);
    if (next) {
      // Do not flip/persist here — the confirm dialog owns enabling. The toggle's visual state is
      // re-synced from the persisted value by update() on the render that follows onToggleKeyAnalysis,
      // so a cancelled dialog leaves it off and a confirmed one shows it on.
      keyConfirm.open({
        title: 'Key analysis',
        body: keyAnalysisConfirmBodyNodes(),
        confirmLabel: 'Enable',
        onConfirm: () => handlers.onToggleKeyAnalysis(true)
      });
      return;
    }
    handlers.onToggleKeyAnalysis(false);
  });

  autoPlayToggle.addEventListener('click', () => {
    const next = !readToggleState(autoPlayToggle);
    setToggleState(autoPlayToggle, next);
    handlers.onToggleAutoPlay(next);
  });

  if (performanceToggle && openPerformanceConfirm) {
    const toggle = performanceToggle;
    const openConfirm = openPerformanceConfirm;
    toggle.addEventListener('click', () => {
      // Do not flip/persist here — the confirm dialog owns the change and reload. The toggle's
      // visual state stays in sync with the persisted value (set by update()); a cancelled
      // dialog therefore leaves it untouched, a confirmed one reloads with the new value.
      openConfirm(!readToggleState(toggle));
    });
  }

  shortcutsButton.addEventListener('click', () => {
    handlers.onOpenKeyboardShortcuts();
  });

  glassButton.addEventListener('click', () => {
    handlers.onEditAppearance();
  });

  container.appendChild(root);

  return {
    update(input) {
      root.style.display = input.hidden ? 'none' : 'block';
      setToggleState(preloadToggle, Boolean(input.preloadTracks));
      setToggleState(keyToggle, Boolean(input.keyAnalysisEnabled));
      setToggleState(autoPlayToggle, Boolean(input.autoPlayEnabled));
      if (performanceToggle) {
        setToggleState(performanceToggle, Boolean(input.performanceModeEnabled));
      }
    },
    destroy() {
      root.remove();
      performanceConfirm?.destroy();
      keyConfirm.destroy();
    }
  };
}
