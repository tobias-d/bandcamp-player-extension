import { dom } from '@/utils/dom';
import type { PanelGlassController } from '@/ui/glass/glass-effect';
import {
  GLASS_DEFAULTS,
  BACKGROUND_STYLES,
  loadGlassSettings,
  saveGlassSettings,
  positionFromSettings,
  withGlassPosition
} from '@/ui/glass/glass-settings';

export interface AppearancePanelController {
  /** Opens the Appearance panel (e.g. from the Settings menu entry). */
  open(): void;
  destroy(): void;
}

/** Slider granularity: 1% steps over the 0..1 position (= 0.1px blur steps). */
const POSITION_STEP = 0.01;

/**
 * How far below the main panel's top edge the Appearance panel attaches, in the
 * main panel's own (pre-scale) px — roughly below its header — so it reads as
 * attached to the body of the panel rather than hanging off the top corner.
 */
const ATTACH_TOP_OFFSET_PX = 56;

const formatPosition = (position: number): string => `${Math.round(position * 100)}%`;

/**
 * The Appearance panel — a live-tuning surface for the panel glass, opened with
 * Alt+G or from Settings → Appearance → Edit (same shortcut pattern as the Alt+K
 * key-tuning and Alt+D debugger panels). Styled to match the main UI panel (light
 * glass), it sits just to the left of it. A "Frost" slider drives tint and blur
 * together (see withGlassPosition); a "Background" stepper (‹ name ›) cycles through
 * the background styles in BACKGROUND_STYLES (None, Camouflage, Prism, plus one
 * reserved placeholder position; the camo amount/blur/shade are fixed constants in
 * GLASS_DEFAULTS). The remaining glass parameters keep their defaults. Loads persisted
 * settings and applies them immediately on creation, so a tuned look survives
 * reloads even when the panel is never opened.
 */
export function createAppearancePanel(
  glass: PanelGlassController,
  root: HTMLElement
): AppearancePanelController {
  // Re-couple the loaded values to a single slider position so stored state
  // can never drift from the one control the panel exposes for tint+blur.
  let position = positionFromSettings(loadGlassSettings());
  let settings = withGlassPosition(loadGlassSettings(), position);
  glass.apply(settings);
  saveGlassSettings(settings);

  const applyAndSave = (): void => {
    // Re-couple tint+blur from the Frost position; camoEnabled on `settings` is
    // preserved through withGlassPosition (it spreads the current settings).
    settings = withGlassPosition(settings, position);
    glass.apply(settings);
    saveGlassSettings(settings);
  };

  // ─── Frost slider (tint + blur coupled to a single position) ───────────
  const slider = dom('input', {
    type: 'range',
    class: 'bc-appearance-panel-slider',
    min: '0',
    max: '1',
    step: String(POSITION_STEP),
    value: String(position),
    'aria-label': 'Frost'
  }) as HTMLInputElement;
  const valueEl = dom('span', { class: 'bc-appearance-panel-value' }, [formatPosition(position)]);

  const setPosition = (next: number): void => {
    position = next;
    slider.value = String(position);
    valueEl.textContent = formatPosition(position);
    applyAndSave();
  };

  slider.addEventListener('input', () => setPosition(Number.parseFloat(slider.value)));

  // ─── Background style stepper (‹ name ›) ───────────────────────────────
  const bgValueEl = dom(
    'span',
    { class: 'bc-appearance-panel-value bc-appearance-panel-bg-value' },
    [BACKGROUND_STYLES[settings.bgStyle]]
  );
  const bgPrev = dom('button', {
    type: 'button',
    class: 'bc-appearance-panel-arrow',
    'aria-label': 'Previous background style'
  }, ['‹']) as HTMLButtonElement;
  const bgNext = dom('button', {
    type: 'button',
    class: 'bc-appearance-panel-arrow',
    'aria-label': 'Next background style'
  }, ['›']) as HTMLButtonElement;

  const setBgStyle = (next: number): void => {
    const index = Math.min(BACKGROUND_STYLES.length - 1, Math.max(0, Math.round(next)));
    settings = { ...settings, bgStyle: index };
    bgValueEl.textContent = BACKGROUND_STYLES[index];
    bgPrev.disabled = index === 0;
    bgNext.disabled = index === BACKGROUND_STYLES.length - 1;
    applyAndSave();
  };
  bgPrev.disabled = settings.bgStyle === 0;
  bgNext.disabled = settings.bgStyle === BACKGROUND_STYLES.length - 1;

  bgPrev.addEventListener('click', () => setBgStyle(settings.bgStyle - 1));
  bgNext.addEventListener('click', () => setBgStyle(settings.bgStyle + 1));

  // ─── Reset ─────────────────────────────────────────────────────────────
  const resetButton = dom('button', { type: 'button', class: 'bc-appearance-panel-reset' }, ['Reset']);
  resetButton.addEventListener('click', () => {
    setBgStyle(GLASS_DEFAULTS.bgStyle);
    setPosition(positionFromSettings(GLASS_DEFAULTS));
  });

  const closeButton = dom(
    'button',
    { type: 'button', class: 'bc-appearance-panel-close', 'aria-label': 'Close' },
    ['×']
  );

  const host = dom('div', { class: 'bc-appearance-panel', role: 'dialog', 'aria-label': 'Appearance' }, [
    dom('div', { class: 'bc-appearance-panel-head' }, [
      dom('span', { class: 'bc-appearance-panel-title' }, ['Appearance']),
      resetButton,
      closeButton
    ]),
    dom('div', { class: 'bc-appearance-panel-row bc-appearance-panel-slider-row' }, [
      dom('span', { class: 'bc-appearance-panel-label' }, ['Frost']),
      slider,
      valueEl
    ]),
    dom('div', { class: 'bc-appearance-panel-row bc-appearance-panel-bg-row' }, [
      dom('span', { class: 'bc-appearance-panel-label' }, ['Background']),
      dom('div', { class: 'bc-appearance-panel-stepper' }, [bgValueEl, bgPrev, bgNext])
    ])
  ]);
  document.body.appendChild(host);

  // Attached to the main panel: while open, each frame places the panel flush
  // against the main panel's left edge with tops aligned and matching its live
  // scale, so it tracks the main panel through drag and resize (same approach as
  // the keyboard-shortcuts host). getBoundingClientRect already includes the
  // main panel's transform, so this is a single read per frame.
  let geometryRaf = 0;
  const readPanelScale = (): number => {
    const raw = Number.parseFloat(getComputedStyle(root).getPropertyValue('--panel-scale'));
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
  };
  const syncGeometry = (): void => {
    const rect = root.getBoundingClientRect();
    const scale = readPanelScale();
    // Anchor by left (not right) using the panel's own scaled width, so its
    // right edge sits flush against the main panel's left edge with no seam — the
    // same approach as the keyboard-shortcuts host. (right + innerWidth is
    // unreliable: innerWidth includes the scrollbar, which opens a gap.) Clamp to
    // the viewport so the panel is never cut off when room to the left is tight.
    const scaledWidth = host.offsetWidth * scale;
    const left = Math.max(8, rect.left - scaledWidth);
    // Offset down (scaled with the panel) so it attaches below the main panel's
    // header rather than at the very top corner.
    const top = Math.max(8, rect.top + ATTACH_TOP_OFFSET_PX * scale);
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
    host.style.setProperty('--appearance-scale', String(scale));
  };
  const stopGeometryLoop = (): void => {
    if (geometryRaf) {
      window.cancelAnimationFrame(geometryRaf);
      geometryRaf = 0;
    }
  };
  const startGeometryLoop = (): void => {
    stopGeometryLoop();
    const tick = (): void => {
      syncGeometry();
      geometryRaf = window.requestAnimationFrame(tick);
    };
    tick();
  };

  const setOpen = (open: boolean): void => {
    host.classList.toggle('is-open', open);
    if (open) {
      startGeometryLoop();
    } else {
      stopGeometryLoop();
    }
  };

  closeButton.addEventListener('click', () => setOpen(false));

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.code !== 'KeyG' || event.repeat) {
      return;
    }
    event.preventDefault();
    setOpen(!host.classList.contains('is-open'));
  };
  document.addEventListener('keydown', onKeyDown, true);

  return {
    open(): void {
      setOpen(true);
    },
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown, true);
      stopGeometryLoop();
      host.remove();
    }
  };
}
