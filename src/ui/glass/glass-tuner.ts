import { dom } from '@/utils/dom';
import type { PanelGlassController } from '@/ui/glass/glass-effect';
import {
  GLASS_DEFAULTS,
  loadGlassSettings,
  saveGlassSettings,
  positionFromSettings,
  withGlassPosition
} from '@/ui/glass/glass-settings';

export interface GlassTunerController {
  /** Opens the tuner panel (e.g. from the Settings menu entry). */
  open(): void;
  destroy(): void;
}

/** Slider granularity: 1% steps over the 0..1 position (= 0.1px blur steps). */
const POSITION_STEP = 0.01;

const formatPosition = (position: number): string => `${Math.round(position * 100)}%`;

/**
 * Alt+G live-tuning panel for the panel glass surface (same shortcut pattern
 * as the Alt+K key-tuning and Alt+D debugger panels). A single "Frost" slider
 * drives tint and blur together (see withGlassPosition); the other glass
 * parameters keep their calibrated defaults. Loads persisted settings and
 * applies them immediately on creation, so a tuned look survives reloads even
 * when the tuner is never opened.
 */
export function createGlassTuner(glass: PanelGlassController): GlassTunerController {
  // Re-couple the loaded values to a single slider position so stored state
  // can never drift from the one control the panel now exposes.
  let position = positionFromSettings(loadGlassSettings());
  let settings = withGlassPosition(loadGlassSettings(), position);
  glass.apply(settings);
  saveGlassSettings(settings);

  const applyAndSave = (): void => {
    settings = withGlassPosition(settings, position);
    glass.apply(settings);
    saveGlassSettings(settings);
  };

  const slider = dom('input', {
    type: 'range',
    class: 'bc-glass-tuner-slider',
    min: '0',
    max: '1',
    step: String(POSITION_STEP),
    value: String(position),
    'aria-label': 'Glass frost'
  }) as HTMLInputElement;
  const valueEl = dom('span', { class: 'bc-glass-tuner-value' }, [formatPosition(position)]);

  const setPosition = (next: number): void => {
    position = next;
    slider.value = String(position);
    valueEl.textContent = formatPosition(position);
    applyAndSave();
  };

  slider.addEventListener('input', () => setPosition(Number.parseFloat(slider.value)));

  const resetButton = dom('button', { type: 'button', class: 'bc-glass-tuner-reset' }, ['Reset']);
  resetButton.addEventListener('click', () => setPosition(positionFromSettings(GLASS_DEFAULTS)));

  const closeButton = dom('button', { type: 'button', class: 'bc-glass-tuner-close', 'aria-label': 'Close' }, ['×']);

  const host = dom('div', { class: 'bc-glass-tuner', role: 'dialog', 'aria-label': 'Glass tuning' }, [
    dom('div', { class: 'bc-glass-tuner-head' }, [
      dom('span', { class: 'bc-glass-tuner-title' }, ['Glass · Alt+G']),
      resetButton,
      closeButton
    ]),
    dom('div', { class: 'bc-glass-tuner-row' }, [
      dom('span', { class: 'bc-glass-tuner-label' }, ['Frost']),
      valueEl
    ]),
    slider
  ]);
  closeButton.addEventListener('click', () => host.classList.remove('is-open'));
  document.body.appendChild(host);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.code !== 'KeyG' || event.repeat) {
      return;
    }
    event.preventDefault();
    host.classList.toggle('is-open');
  };
  document.addEventListener('keydown', onKeyDown, true);

  return {
    open(): void {
      host.classList.add('is-open');
    },
    destroy(): void {
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
    }
  };
}
