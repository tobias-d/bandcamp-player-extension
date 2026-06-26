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
// segment does. The High line is Chrome-only (the segment does not exist on Firefox). The closing
// note applies to every option: any change reloads the page (the engine reads its preload policy
// once on load).
function preloadInfoNodes(): HTMLElement[] {
  const lines: HTMLElement[] = [
    dom('p', {}, [dom('strong', {}, ['Off']), ' — saves memory, CPU and network traffic; upcoming tracks are not prepared ahead.']),
    dom('p', {}, [dom('strong', {}, ['Normal']), ' — prepares a few tracks ahead so playback starts instantly.'])
  ];
  if (__BUILD_TARGET__ === 'chrome') {
    lines.push(
      dom('p', {}, [dom('strong', {}, ['High']), ' — prepares many more for instant skipping; uses more memory.'])
    );
  }
  lines.push(dom('p', { class: 'bc-settings-info-note' }, ['Changing this reloads the page.']));
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

// A segmented control: a track holding N equal buttons, where the active one reads as a raised
// "thumb". Every toggle in the Settings menu uses this one shape — full-width (DJ/Lite, Preload)
// or compact on the right of a row (Auto-play, Analyze Key) — so the menu looks consistent.
interface SegGroup {
  el: HTMLElement;
  buttons: Map<string, HTMLButtonElement>;
}

function buildSegGroup(
  ariaLabel: string,
  options: { value: string; label: string }[],
  variant: 'full' | 'compact'
): SegGroup {
  const el = dom('div', {
    class: `bc-settings-seg bc-settings-seg--${variant}`,
    role: 'group',
    'aria-label': ariaLabel
  });
  const buttons = new Map<string, HTMLButtonElement>();
  for (const option of options) {
    const button = dom(
      'button',
      { class: 'bc-settings-seg-btn', type: 'button', 'aria-pressed': 'false' },
      [option.label]
    ) as HTMLButtonElement;
    buttons.set(option.value, button);
    el.appendChild(button);
  }
  return { el, buttons };
}

function setActiveSeg(group: SegGroup, active: string): void {
  for (const [value, button] of group.buttons) {
    const isOn = value === active;
    button.classList.toggle('is-active', isOn);
    button.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  }
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

  const isChromeBuild = __BUILD_TARGET__ === 'chrome';

  // DJ / Lite mode: a full-width segmented control between the standard DJ mode (full DJ features)
  // and Lite mode, which disables all DJ-oriented features (BPM/key readouts and analysis, Tempo
  // Adjust, Tap Tempo, playlist BPM) for a clean listening-focused UI. The control fills the row;
  // the active half is the highlighted thumb. Enabling Lite opens an opt-in explainer first.
  const liteSeg = buildSegGroup('DJ or Lite mode', [
    { value: 'dj', label: 'DJ mode' },
    { value: 'lite', label: 'Lite mode' }
  ], 'full');
  const liteBlock = dom('div', { class: 'bc-settings-block' }, [liteSeg.el]);

  // Preload tracks: a single Off / Normal / High control that replaces the old separate "Preload
  // tracks" toggle and Chrome-only "Performance mode" toggle. Laid out as a STACKED block — label
  // + (i) on top, full-width segments below — so three segments don't force the panel wider. The
  // segment maps onto the two persisted booleans: Off = preload off, Normal = preload on (auto
  // device tier), High = preload on + performance mode (Chrome only). High is omitted from the
  // Firefox bundle (no performance tier there).
  type PreloadLevel = 'off' | 'normal' | 'high';
  const deriveLevel = (preloadTracks: boolean, performanceMode: boolean): PreloadLevel => {
    if (preloadTracks && performanceMode && isChromeBuild) {
      return 'high';
    }
    return preloadTracks ? 'normal' : 'off';
  };

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
  const preloadHead = dom('div', { class: 'bc-settings-preload-head' }, [preloadText, preloadInfoButton]);
  // Built from preloadInfoNodes() so the High line can be dropped on Firefox.
  const preloadInfoPop = dom('div', { class: 'bc-settings-info-pop', role: 'note' }, preloadInfoNodes());

  const preloadOptions = [
    { value: 'off', label: 'Off' },
    { value: 'normal', label: 'Normal' }
  ];
  if (isChromeBuild) {
    preloadOptions.push({ value: 'high', label: 'High' });
  }
  const preloadSeg = buildSegGroup('Preload level', preloadOptions, 'full');
  const preloadBlock = dom('div', { class: 'bc-settings-block' }, [preloadHead, preloadSeg.el, preloadInfoPop]);

  // Auto-play and Analyze Key: compact Off/On segments on the right of a normal label-left row.
  const autoPlaySeg = buildSegGroup('Auto-play next track', [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' }
  ], 'compact');
  const autoPlayRow = dom('div', { class: 'bc-settings-row' }, [
    dom('span', { class: 'bc-settings-label' }, ['Auto-play next track']),
    autoPlaySeg.el
  ]);

  const keySeg = buildSegGroup('Analyze Key', [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' }
  ], 'compact');
  const keyRow = dom('div', { class: 'bc-settings-row' }, [
    dom('span', { class: 'bc-settings-label' }, ['Analyze Key']),
    keySeg.el
  ]);

  // The High segment maps onto Chrome-only Performance mode (Chrome caps deviceMemory at 8, so
  // high-RAM machines need an explicit opt-in to use the headroom). Entering OR leaving High shows
  // a RAM-cost warning, so it routes through this confirm dialog, which persists both booleans and
  // reloads on confirm. (Off<->Normal reloads too, but directly — no warning needed.) The dialog is
  // null on Firefox (no High segment is built there).
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

  // Turning Key analysis or Lite mode ON opens an explainer first. Only on confirm do we call the
  // handler; cancel leaves it off (update() re-syncs the active segment from the persisted value).
  const keyConfirm: ConfirmDialog = createConfirmDialog(root, 'Key analysis');
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
  // shortcuts, Appearance.
  list.appendChild(liteBlock);
  list.appendChild(preloadBlock);
  list.appendChild(autoPlayRow);
  list.appendChild(keyRow);
  list.appendChild(shortcutsRow);
  list.appendChild(glassRow);
  root.appendChild(title);
  root.appendChild(list);
  root.style.display = 'none';

  // Tracked persisted state so a click knows the current value: the preload level (does a click
  // touch High → confirm + reload, or is it a soft Off<->Normal flip?) and the lite/key flags
  // (so re-clicking the already-active segment is a no-op rather than re-opening a confirm).
  let currentLevel: PreloadLevel = 'off';
  let liteOn = false;
  let keyOn = false;
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
    // Entering or leaving High also needs the RAM-cost warning, so it routes through the confirm
    // dialog (which persists both booleans and reloads on confirm).
    if ((target === 'high' || currentLevel === 'high') && openPerformanceConfirm) {
      openPerformanceConfirm(target === 'high', target !== 'off');
      return;
    }
    // Off<->Normal: persist, then reload directly (no warning needed). The info popover tells the
    // user every change reloads, and the engine reads its preload policy once on load.
    handlers.onTogglePreloadTracks(target !== 'off');
    window.location.reload();
  };
  for (const [level, button] of preloadSeg.buttons) {
    button.addEventListener('click', () => selectPreloadLevel(level as PreloadLevel));
  }

  liteSeg.buttons.get('lite')?.addEventListener('click', () => {
    if (liteOn) {
      return;
    }
    // Do not flip/persist here — the confirm dialog owns enabling. update() re-syncs the active
    // half from the persisted value, so a cancelled dialog leaves it on DJ.
    liteConfirm.open({
      title: 'Lite mode',
      body: liteModeConfirmBodyNodes(),
      confirmLabel: 'Enable',
      onConfirm: () => handlers.onToggleLiteMode(true)
    });
  });
  liteSeg.buttons.get('dj')?.addEventListener('click', () => {
    if (!liteOn) {
      return;
    }
    handlers.onToggleLiteMode(false);
  });

  autoPlaySeg.buttons.get('on')?.addEventListener('click', () => handlers.onToggleAutoPlay(true));
  autoPlaySeg.buttons.get('off')?.addEventListener('click', () => handlers.onToggleAutoPlay(false));

  keySeg.buttons.get('on')?.addEventListener('click', () => {
    if (keyOn) {
      return;
    }
    keyConfirm.open({
      title: 'Key analysis',
      body: keyAnalysisConfirmBodyNodes(),
      confirmLabel: 'Enable',
      onConfirm: () => handlers.onToggleKeyAnalysis(true)
    });
  });
  keySeg.buttons.get('off')?.addEventListener('click', () => {
    if (!keyOn) {
      return;
    }
    handlers.onToggleKeyAnalysis(false);
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
      // Derive each control's active segment from the persisted values.
      currentLevel = deriveLevel(Boolean(input.preloadTracks), Boolean(input.performanceModeEnabled));
      setActiveSeg(preloadSeg, currentLevel);
      liteOn = Boolean(input.liteModeEnabled);
      setActiveSeg(liteSeg, liteOn ? 'lite' : 'dj');
      setActiveSeg(autoPlaySeg, input.autoPlayEnabled ? 'on' : 'off');
      keyOn = Boolean(input.keyAnalysisEnabled);
      setActiveSeg(keySeg, keyOn ? 'on' : 'off');
      // Key analysis is a DJ feature: deactivate (dim + non-interactive) its row while Lite mode
      // is on, rather than hiding it, so the user can see it is unavailable.
      keyRow.classList.toggle('bc-settings-row-disabled', liteOn);
      for (const button of keySeg.buttons.values()) {
        button.disabled = liteOn;
      }
    },
    destroy() {
      root.remove();
      performanceConfirm?.destroy();
      keyConfirm.destroy();
      liteConfirm.destroy();
    }
  };
}
