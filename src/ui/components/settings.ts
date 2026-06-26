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

// Short, level-specific explainer shown by the (i) next to "Preload tracks". Deliberately terse —
// the broader prose about the memory trade-off lives in the About panel; this only names what each
// segment does. The High line is Chrome-only (the segment does not exist on Firefox).
function preloadInfoNodes(): HTMLElement[] {
  const lines: HTMLElement[] = [
    dom('p', {}, [dom('strong', {}, ['Off']), ' — upcoming tracks are not prepared ahead.']),
    dom('p', {}, [dom('strong', {}, ['Normal']), ' — prepares a few tracks ahead so playback starts instantly.'])
  ];
  if (__BUILD_TARGET__ === 'chrome') {
    lines.push(
      dom('p', {}, [
        dom('strong', {}, ['High']),
        ' — prepares many more for instant skipping; uses more memory and reloads the page.'
      ])
    );
  }
  return lines;
}

// Explainer shown when the user turns Lite mode ON. Same modal style as Key analysis.
function liteModeConfirmBodyNodes(): (string | Node)[] {
  return [
    'Lite mode turns Bandcamp Deck into a ',
    dom('strong', {}, ['simple player']),
    '. It hides the BPM and key readouts, the playlist BPM column, and the ',
    dom('strong', {}, ['Tempo Adjust']),
    ' and ',
    dom('strong', {}, ['Tap Tempo']),
    ' tools, and stops all BPM analysis — leaving just the waveform, playtime, and transport. Turn it off any time to bring the DJ features back.'
  ];
}

interface SettingsHandlers {
  onTogglePreloadTracks(enabled: boolean): void;
  onToggleKeyAnalysis(enabled: boolean): void;
  onToggleLiteMode(enabled: boolean): void;
  onToggleAutoPlay(enabled: boolean): void;
  onTogglePerformanceMode(enabled: boolean): void;
  onOpenKeyboardShortcuts(): void;
  onEditAppearance(): void;
}

interface SettingsUpdateInput {
  hidden: boolean;
  preloadTracks: boolean;
  keyAnalysisEnabled: boolean;
  liteModeEnabled: boolean;
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

  // Preload tracks: a single 3-level control (Off / Normal / High) that replaces the old
  // separate "Preload tracks" toggle and Chrome-only "Performance mode" toggle. It is laid out as
  // a STACKED block — label + (i) on top, full-width segments below — rather than the usual
  // label-left/control-right row, because three segments are too wide to sit beside the label
  // without forcing the whole Settings panel wider. The segment maps onto the two persisted
  // booleans: Off = preload off, Normal = preload on (auto device tier), High = preload on +
  // performance mode (Chrome only). High is omitted from the Firefox bundle (no performance tier).
  type PreloadLevel = 'off' | 'normal' | 'high';
  const isChromeBuild = __BUILD_TARGET__ === 'chrome';

  const deriveLevel = (preloadTracks: boolean, performanceMode: boolean): PreloadLevel => {
    if (preloadTracks && performanceMode && isChromeBuild) {
      return 'high';
    }
    return preloadTracks ? 'normal' : 'off';
  };

  const preloadBlock = dom('div', { class: 'bc-settings-preload' });
  const preloadHead = dom('div', { class: 'bc-settings-preload-head' });
  const preloadText = dom('span', { class: 'bc-settings-label' }, ['Preload tracks']);
  const preloadInfoButton = dom(
    'button',
    {
      class: 'bc-settings-info',
      type: 'button',
      'aria-label': 'About preload tracks',
      'aria-expanded': 'false'
    },
    ['i']
  ) as HTMLButtonElement;
  preloadHead.appendChild(preloadText);
  preloadHead.appendChild(preloadInfoButton);

  // Built from preloadInfoNodes() so the High line can be dropped on Firefox.
  const preloadInfoPop = dom('div', { class: 'bc-settings-info-pop', role: 'note' }, preloadInfoNodes());

  const preloadSeg = dom('div', { class: 'bc-settings-seg', role: 'group', 'aria-label': 'Preload level' });
  const segLevels: PreloadLevel[] = isChromeBuild ? ['off', 'normal', 'high'] : ['off', 'normal'];
  const segLabels: Record<PreloadLevel, string> = { off: 'Off', normal: 'Normal', high: 'High' };
  const segButtons = new Map<PreloadLevel, HTMLButtonElement>();
  for (const level of segLevels) {
    const button = dom(
      'button',
      { class: 'bc-settings-seg-btn', type: 'button', 'aria-pressed': 'false' },
      [segLabels[level]]
    ) as HTMLButtonElement;
    segButtons.set(level, button);
    preloadSeg.appendChild(button);
  }

  preloadBlock.appendChild(preloadHead);
  preloadBlock.appendChild(preloadSeg);
  preloadBlock.appendChild(preloadInfoPop);

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

  // DJ / Lite mode: one toggle between the standard full-featured DJ mode (off) and Lite mode
  // (on), which disables all DJ-oriented features (BPM/key readouts and analysis, Tempo Adjust,
  // Tap Tempo, playlist BPM) for a clean listening-focused UI. Laid out as "DJ mode · toggle ·
  // Lite mode" with the active side bolded; the toggle itself stays a neutral darker grey in
  // both states (state is shown by the bold label and the thumb position).
  const liteRow = dom('div', { class: 'bc-settings-row bc-settings-row-djlite' });
  const djLabel = dom('span', { class: 'bc-settings-mode-label' }, ['DJ mode']);
  const liteLabel = dom('span', { class: 'bc-settings-mode-label' }, ['Lite mode']);
  const liteToggle = dom('button', {
    class: 'bc-settings-toggle-btn bc-settings-toggle-djlite',
    type: 'button',
    role: 'switch',
    'aria-label': 'Toggle DJ/Lite mode',
    'aria-pressed': 'false'
  }) as HTMLButtonElement;
  liteRow.appendChild(djLabel);
  liteRow.appendChild(liteToggle);
  liteRow.appendChild(liteLabel);

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

  // The High segment maps onto Chrome-only Performance mode (Chrome caps deviceMemory at 8, so
  // high-RAM machines need an explicit opt-in to use the headroom). Entering OR leaving High
  // changes the predecode policy, which the engine reads once at construction — so unlike the
  // soft Off<->Normal flip, any High transition routes through this confirm dialog and reloads on
  // confirm. The dialog is null on Firefox (no High segment is built there).
  let openPerformanceConfirm: ((targetPerf: boolean, targetPreload: boolean) => void) | null = null;
  // Body-mounted confirm dialog, tracked so destroy() can remove it (it is not under root).
  let performanceConfirm: PerformanceConfirmDialog | null = null;
  if (isChromeBuild) {
    performanceConfirm = createPerformanceConfirmDialog(root);
    openPerformanceConfirm = (targetPerf: boolean, targetPreload: boolean): void => {
      // Persist BOTH booleans for the chosen level before the dialog reloads. Off<->High changes
      // preload too, so we set it here; the reload makes the live re-render moot. Cancel leaves
      // everything untouched and update() re-syncs the active segment from the persisted value.
      performanceConfirm?.open(targetPerf, () => {
        handlers.onTogglePreloadTracks(targetPreload);
        handlers.onTogglePerformanceMode(targetPerf);
      });
    };
  }

  // Turning Key analysis ON opens this explainer first (same modal style as Performance mode). Only
  // on confirm do we call the handler; cancel leaves the toggle off. Turning it OFF needs no dialog.
  const keyConfirm: ConfirmDialog = createConfirmDialog(root, 'Key analysis');
  // Same opt-in explainer pattern for Lite mode. No reload — it applies live.
  const liteConfirm: ConfirmDialog = createConfirmDialog(root, 'Lite mode');

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

  // Order: DJ/Lite mode, Preload tracks (Off/Normal/High), Auto-play, Analyze Key, Keyboard
  // shortcuts, Appearance. The Preload block is the stacked label+segments unit defined above.
  list.appendChild(liteRow);
  list.appendChild(preloadBlock);
  list.appendChild(autoPlayRow);
  list.appendChild(keyRow);
  list.appendChild(shortcutsRow);
  list.appendChild(glassRow);
  root.appendChild(title);
  root.appendChild(list);
  root.style.display = 'none';

  // The active preload segment, tracked so a click knows whether the transition touches High
  // (perf change → confirm + reload) or is a soft Off<->Normal flip. Kept in sync by update().
  let currentLevel: PreloadLevel = 'off';
  let infoOpen = false;
  const closeInfoPop = (): void => {
    if (!infoOpen) {
      return;
    }
    infoOpen = false;
    preloadInfoPop.classList.remove('is-open');
    preloadInfoButton.setAttribute('aria-expanded', 'false');
  };

  // The settings root stops clicks from reaching the panel's outside-click handler. Reuse this
  // single listener to also dismiss the info popover on any click outside it (the info button
  // stops its own propagation, so toggling it does not immediately re-close it here).
  root.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as Node | null;
    if (infoOpen && target && !preloadInfoButton.contains(target) && !preloadInfoPop.contains(target)) {
      closeInfoPop();
    }
  });

  const setToggleState = (toggle: HTMLButtonElement, enabled: boolean): void => {
    toggle.classList.toggle('is-on', enabled);
    toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  };

  const readToggleState = (toggle: HTMLButtonElement): boolean =>
    toggle.getAttribute('aria-pressed') === 'true';

  preloadInfoButton.addEventListener('click', (event) => {
    // Stop here so the root listener above does not treat this as an outside click and re-close.
    event.stopPropagation();
    if (infoOpen) {
      closeInfoPop();
      return;
    }
    infoOpen = true;
    preloadInfoPop.classList.add('is-open');
    preloadInfoButton.setAttribute('aria-expanded', 'true');
  });

  const selectPreloadLevel = (target: PreloadLevel): void => {
    if (target === currentLevel) {
      return;
    }
    // Any transition into or out of High changes Performance mode → confirm + reload owns it.
    if ((target === 'high' || currentLevel === 'high') && openPerformanceConfirm) {
      openPerformanceConfirm(target === 'high', target !== 'off');
      return;
    }
    // Soft path: Off<->Normal just flips preload live. update() re-syncs the active segment.
    handlers.onTogglePreloadTracks(target !== 'off');
  };

  for (const [level, button] of segButtons) {
    button.addEventListener('click', () => selectPreloadLevel(level));
  }

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

  liteToggle.addEventListener('click', () => {
    const next = !readToggleState(liteToggle);
    if (next) {
      // Do not flip/persist here — the confirm dialog owns enabling. The toggle's visual state is
      // re-synced from the persisted value by update() on the render that follows, so a cancelled
      // dialog leaves it off and a confirmed one shows it on.
      liteConfirm.open({
        title: 'Lite mode',
        body: liteModeConfirmBodyNodes(),
        confirmLabel: 'Enable',
        onConfirm: () => handlers.onToggleLiteMode(true)
      });
      return;
    }
    handlers.onToggleLiteMode(false);
  });

  autoPlayToggle.addEventListener('click', () => {
    const next = !readToggleState(autoPlayToggle);
    setToggleState(autoPlayToggle, next);
    handlers.onToggleAutoPlay(next);
  });

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
      if (input.hidden) {
        closeInfoPop();
      }
      // Derive the active preload segment from the two persisted booleans and highlight it.
      currentLevel = deriveLevel(Boolean(input.preloadTracks), Boolean(input.performanceModeEnabled));
      for (const [level, button] of segButtons) {
        const active = level === currentLevel;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
      setToggleState(keyToggle, Boolean(input.keyAnalysisEnabled));
      setToggleState(liteToggle, Boolean(input.liteModeEnabled));
      // Highlight (bold) the currently active mode label flanking the toggle.
      djLabel.classList.toggle('is-active', !input.liteModeEnabled);
      liteLabel.classList.toggle('is-active', Boolean(input.liteModeEnabled));
      setToggleState(autoPlayToggle, Boolean(input.autoPlayEnabled));
      // Key analysis is a DJ feature: deactivate (dim + non-interactive) its row while Lite
      // mode is on, rather than hiding it, so the user can see it is unavailable.
      keyToggle.disabled = Boolean(input.liteModeEnabled);
      keyRow.classList.toggle('bc-settings-row-disabled', Boolean(input.liteModeEnabled));
    },
    destroy() {
      root.remove();
      performanceConfirm?.destroy();
      keyConfirm.destroy();
      liteConfirm.destroy();
    }
  };
}
