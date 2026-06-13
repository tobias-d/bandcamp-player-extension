import type { TempoAdjustUiState } from '@/shared/types';
import {
  TEMPO_ADJUST_DEFAULT_MASTER_TEMPO,
  TEMPO_ADJUST_OFFSET_MAX_BPM,
  TEMPO_ADJUST_OFFSET_MIN_BPM,
  clampTempoAdjustOffsetBpm,
  computeTempoAdjustPlaybackRate
} from '@/shared/tempo-adjust';
import { dom, setText } from '@/utils/dom';

const OFFSET_STEP_BPM = 1;
const OFFSET_MARKER_COUNT = TEMPO_ADJUST_OFFSET_MAX_BPM - TEMPO_ADJUST_OFFSET_MIN_BPM + 1;

function asInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.round(value);
}

function formatAdjustedBpm(
  detectedBpm: number | undefined,
  offsetBpm: number
): string {
  if (!Number.isFinite(detectedBpm) || Number(detectedBpm) <= 0) {
    return '--';
  }
  const detected = Number(detectedBpm);
  const playbackRate = computeTempoAdjustPlaybackRate(detected, offsetBpm);
  const adjusted = Math.max(1, Math.round(detected * playbackRate));
  return `${adjusted}`;
}


function createDefaultUiState(): TempoAdjustUiState {
  return {
    detectedBpm: undefined,
    controlsEnabled: false,
    offsetBpm: 0,
    masterTempoEnabled: TEMPO_ADJUST_DEFAULT_MASTER_TEMPO
  };
}

function normalizeUiState(state: TempoAdjustUiState | null | undefined): TempoAdjustUiState {
  const fallback = createDefaultUiState();
  if (!state) {
    return fallback;
  }
  return {
    detectedBpm: Number.isFinite(state.detectedBpm) && Number(state.detectedBpm) > 0
      ? Math.round(Number(state.detectedBpm))
      : undefined,
    controlsEnabled: Boolean(state.controlsEnabled),
    offsetBpm: clampTempoAdjustOffsetBpm(state.offsetBpm),
    masterTempoEnabled: Boolean(state.masterTempoEnabled)
  };
}

export interface TempoAdjustPanelHandlers {
  onSetOffsetBpm(offsetBpm: number): void;
  onSetMasterTempoEnabled(enabled: boolean): void;
}

export interface TempoAdjustPanelComponent {
  isOpen(): boolean;
  setOpen(open: boolean): void;
  update(nextState?: TempoAdjustUiState): void;
  destroy(): void;
}

export function createTempoAdjustPanel(
  container: HTMLElement,
  handlers: TempoAdjustPanelHandlers
): TempoAdjustPanelComponent {
  const title = dom('div', { class: 'bc-tempo-adjust-title' }, ['Tempo Adjust']);
  const offsetValue = dom('span', { class: 'bc-tempo-adjust-offset-value' }, ['--']);
  const offsetHeader = dom('div', { class: 'bc-tempo-adjust-offset-header' }, [
    dom('span', { class: 'bc-tempo-adjust-offset-label' }, ['BPM']),
    offsetValue
  ]);

  const offsetSlider = dom('input', {
    class: 'bc-tempo-adjust-slider',
    type: 'range',
    min: String(TEMPO_ADJUST_OFFSET_MIN_BPM),
    max: String(TEMPO_ADJUST_OFFSET_MAX_BPM),
    step: String(OFFSET_STEP_BPM),
    value: '0',
    'aria-label': 'Tempo offset in BPM'
  }) as HTMLInputElement;

  const sliderTicks = dom('div', { class: 'bc-tempo-adjust-slider-ticks', 'aria-hidden': 'true' }, [
    dom('span', {}, [`${TEMPO_ADJUST_OFFSET_MIN_BPM}`]),
    dom('span', {}, [`+${TEMPO_ADJUST_OFFSET_MAX_BPM}`])
  ]);
  const sliderMarkers = dom('div', { class: 'bc-tempo-adjust-slider-markers', 'aria-hidden': 'true' });
  for (let index = 0; index < OFFSET_MARKER_COUNT; index += 1) {
    const marker = dom('span', { class: 'bc-tempo-adjust-slider-marker' });
    const value = TEMPO_ADJUST_OFFSET_MIN_BPM + index;
    const position = OFFSET_MARKER_COUNT <= 1 ? 0 : (index / (OFFSET_MARKER_COUNT - 1)) * 100;
    marker.style.left = `${position}%`;
    if (index === 0) {
      marker.classList.add('is-first');
      marker.classList.add('is-zero');
    } else if (index === OFFSET_MARKER_COUNT - 1) {
      marker.classList.add('is-last');
      marker.classList.add('is-zero');
    }
    if (value === 0) {
      marker.classList.add('is-zero');
    }
    sliderMarkers.appendChild(marker);
  }

  const mtButton = dom(
    'button',
    {
      type: 'button',
      class: 'bc-settings-toggle-btn',
      'aria-pressed': 'true',
      role: 'switch',
      'aria-label': 'Toggle key lock',
      title: 'Key Lock'
    },
    []
  );
  const keyLockLabel = dom('span', { class: 'bc-settings-label' }, ['Key Lock']);
  const keyLockRow = dom('div', { class: 'bc-tempo-adjust-key-lock' }, [keyLockLabel, mtButton]);

  const topRow = dom('div', { class: 'bc-tempo-adjust-top-row' }, [keyLockRow, offsetHeader]);
  const root = dom('div', { class: 'bc-tempo-adjust-row', 'aria-hidden': 'true' }, [
    title,
    topRow,
    offsetSlider,
    sliderMarkers,
    sliderTicks
  ]);

  container.appendChild(root);

  let open = false;
  let uiState = createDefaultUiState();

  const syncView = (): void => {
    uiState = normalizeUiState(uiState);

    offsetSlider.value = String(uiState.offsetBpm);
    setText(offsetValue, formatAdjustedBpm(uiState.detectedBpm, uiState.offsetBpm));

    mtButton.classList.toggle('is-on', uiState.masterTempoEnabled);
    mtButton.setAttribute('aria-pressed', uiState.masterTempoEnabled ? 'true' : 'false');

    const controlsEnabled = uiState.controlsEnabled;
    offsetSlider.disabled = !controlsEnabled;
    mtButton.disabled = !controlsEnabled;
    root.classList.toggle('is-disabled', !controlsEnabled);

    root.classList.toggle('is-open', open);
    root.setAttribute('aria-hidden', open ? 'false' : 'true');
  };

  const onOffsetInput = (): void => {
    if (!uiState.controlsEnabled) {
      return;
    }
    const parsed = Number.parseFloat(offsetSlider.value);
    uiState.offsetBpm = clampTempoAdjustOffsetBpm(asInteger(parsed, 0));
    handlers.onSetOffsetBpm(uiState.offsetBpm);
    syncView();
  };

  const onMasterTempoClick = (): void => {
    if (!uiState.controlsEnabled) {
      return;
    }
    uiState.masterTempoEnabled = !uiState.masterTempoEnabled;
    handlers.onSetMasterTempoEnabled(uiState.masterTempoEnabled);
    syncView();
  };

  offsetSlider.addEventListener('input', onOffsetInput);
  mtButton.addEventListener('click', onMasterTempoClick);

  syncView();

  return {
    isOpen() {
      return open;
    },
    setOpen(nextOpen) {
      open = Boolean(nextOpen);
      syncView();
    },
    update(nextState) {
      uiState = normalizeUiState(nextState);
      syncView();
    },
    destroy() {
      offsetSlider.removeEventListener('input', onOffsetInput);
      mtButton.removeEventListener('click', onMasterTempoClick);
      root.remove();
    }
  };
}
