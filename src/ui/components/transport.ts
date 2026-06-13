import type { PanelInput } from '@/shared/types';
import { dom } from '@/utils/dom';
import { extensionAssetUrl } from '@/utils/asset-url';
import { createTempoAdjustPanel } from '@/ui/components/tempo-adjust-panel';

export interface TransportComponent {
  update(input: PanelInput): void;
  getBottomSlot(): HTMLElement;
  getTapSlot(): HTMLElement;
  setTapOpen(open: boolean): void;
  destroy(): void;
}

interface TransportHandlers {
  onPrevTrack(): void;
  onTogglePlayPause(): void;
  onSetVolume(volume: number): void;
  onNextTrack(): void;
  onToggleTap(): void;
  onSetTempoAdjustOffsetBpm(offsetBpm: number): void;
  onSetTempoAdjustMasterTempoEnabled(enabled: boolean): void;
}

const VOLUME_SLIDER_STEP_PERCENT = 1;
export function createTransport(container: HTMLElement, handlers: TransportHandlers): TransportComponent {
  const volumeIcon = dom('span', { class: 'bc-btn-symbol bc-btn-symbol-volume bc-icon bc-icon-volume', 'aria-hidden': 'true' }, [
    dom('span', { class: 'bc-icon-volume-speaker' }),
    dom('span', { class: 'bc-icon-volume-wave bc-icon-volume-wave-1' }),
    dom('span', { class: 'bc-icon-volume-wave bc-icon-volume-wave-2' }),
    dom('span', { class: 'bc-icon-volume-slash' })
  ]);
  const volumeBtn = dom(
    'button',
    { type: 'button', class: 'bc-btn bc-vol-btn', title: 'Mute/Restore Volume', 'aria-label': 'Mute/Restore Volume' },
    [volumeIcon]
  );
  const prevBtn = dom(
    'button',
    { type: 'button', class: 'bc-btn bc-btn-prev', title: 'Previous' },
    [dom('span', { class: 'bc-btn-symbol bc-btn-symbol-nav bc-icon bc-icon-nav bc-icon-prev', 'aria-hidden': 'true' })]
  );
  const playIcon = dom('span', {
    class: 'bc-btn-symbol bc-btn-symbol-play bc-icon bc-icon-play',
    'aria-hidden': 'true'
  });
  const playBtn = dom('button', { type: 'button', class: 'bc-btn bc-btn-play', title: 'Play/Pause' }, [playIcon]);
  const nextBtn = dom(
    'button',
    { type: 'button', class: 'bc-btn bc-btn-next', title: 'Next' },
    [dom('span', { class: 'bc-btn-symbol bc-btn-symbol-nav bc-icon bc-icon-nav bc-icon-next', 'aria-hidden': 'true' })]
  );
  const tempoAdjustBtn = dom(
    'button',
    { type: 'button', class: 'bc-btn bc-btn-tempo-adjust', title: 'Tempo Adjust' },
    [
      dom('img', {
        class: 'bc-btn-symbol-svg bc-btn-symbol-svg-turntable',
        src: extensionAssetUrl('public/turntable.svg'),
        alt: '',
        'aria-hidden': 'true'
      })
    ]
  );
  const tapBtn    = dom(
    'button',
    { type: 'button', class: 'bc-btn bc-btn-tap', title: 'Tap Tempo' },
    [
      dom('img', {
        class: 'bc-btn-symbol-svg bc-btn-symbol-svg-tap',
        src: extensionAssetUrl('public/tap.svg'),
        alt: '',
        'aria-hidden': 'true'
      })
    ]
  );
  const volSlider = dom(
    'input',
    {
      type: 'range',
      class: 'bc-vol-mini-slider',
      min: '0',
      max: '100',
      step: String(VOLUME_SLIDER_STEP_PERCENT),
      value: '100',
      'aria-label': 'Volume'
    }
  ) as HTMLInputElement;
  const volSliderWrap = dom('div', { class: 'bc-vol-mini-slider-wrap' }, [volSlider]);
  const leftControls = dom('div', { class: 'bc-transport-left-controls' }, [prevBtn, playBtn, nextBtn]);
  const volumeControl = dom('div', { class: 'bc-volume-control' }, [volumeBtn, volSliderWrap]);
  const rightControls = dom('div', { class: 'bc-transport-right-controls' }, [tempoAdjustBtn, tapBtn]);
  const controlsPill = dom(
    'div',
    { class: 'bc-transport-pill' },
    [leftControls, volumeControl, rightControls]
  );
  const topCell = dom('div', { class: 'bc-transport-cell bc-transport-cell-top' }, [controlsPill]);
  const tempoPanelCell = dom('div', { class: 'bc-transport-cell bc-transport-cell-tempo' });
  const tempoAdjustPanel = createTempoAdjustPanel(tempoPanelCell, {
    onSetOffsetBpm(offsetBpm) {
      handlers.onSetTempoAdjustOffsetBpm(offsetBpm);
    },
    onSetMasterTempoEnabled(enabled) {
      handlers.onSetTempoAdjustMasterTempoEnabled(enabled);
    }
  });
  const tapPanelCell = dom('div', { class: 'bc-transport-cell bc-transport-cell-tap' });
  const analysisContent = dom('div', { class: 'bc-transport-bottom-content' });
  const analysisCell = dom('div', { class: 'bc-transport-cell bc-transport-cell-bottom' });
  analysisCell.appendChild(analysisContent);

  const root = dom('div', { class: 'bc-transport-inner' }, [analysisCell, topCell, tempoPanelCell, tapPanelCell]);
  let lastAudibleVolumePercent = 100;
  let tapOpen = false;

  const readSliderVolumePercent = (): number => {
    const value = Number.parseFloat(volSlider.value);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100;
  };

  const writeSliderVolumePercent = (volumePercent: number): void => {
    const clamped = Number.isFinite(volumePercent) ? Math.min(100, Math.max(0, volumePercent)) : 100;
    volSlider.value = String(Number(clamped.toFixed(4)));
  };

  const updateVolumeVisual = (volumePercent = readSliderVolumePercent()): void => {
    const clamped = Number.isFinite(volumePercent) ? Math.min(100, Math.max(0, volumePercent)) : 100;
    volSliderWrap.style.setProperty('--vol-level', `${clamped}%`);
    volSliderWrap.style.setProperty('--vol-thumb-left', `${clamped}%`);
  };

  const updateVolumeButtonState = (volumePercent = readSliderVolumePercent(), muted = false): void => {
    const clamped = Number.isFinite(volumePercent) ? Math.min(100, Math.max(0, volumePercent)) : 100;
    const levelClass = muted || clamped <= 0.5
      ? 'is-muted'
      : clamped < 66
        ? 'is-mid'
        : 'is-full';
    volumeBtn.classList.toggle('is-muted', levelClass === 'is-muted');
    volumeBtn.classList.toggle('is-mid', levelClass === 'is-mid');
    volumeBtn.classList.toggle('is-full', levelClass === 'is-full');
  };

  const applyVolumePercent = (volumePercent: number): void => {
    const clamped = Number.isFinite(volumePercent) ? Math.min(100, Math.max(0, volumePercent)) : 100;
    if (clamped > 0.5) {
      lastAudibleVolumePercent = clamped;
    }
    writeSliderVolumePercent(clamped);
    updateVolumeVisual(clamped);
    updateVolumeButtonState(clamped, clamped <= 0.5);
    handlers.onSetVolume(clamped / 100);
  };

  const setTempoAdjustOpen = (nextOpen: boolean): void => {
    tempoAdjustPanel.setOpen(nextOpen);
    tempoAdjustBtn.classList.toggle('bc-btn-tempo-adjust-active', nextOpen);
    tempoPanelCell.classList.toggle('is-open', nextOpen);
    root.classList.toggle('bc-tempo-adjust-open', nextOpen);
  };

  const setTapOpen = (open: boolean): void => {
    tapOpen = Boolean(open);
    tapBtn.classList.toggle('bc-btn-tap-active', tapOpen);
    tapPanelCell.classList.toggle('is-open', open);
    root.classList.toggle('bc-tap-open', open);
  };

  volumeBtn.addEventListener('click', (event) => {
    event.preventDefault();
    const current = readSliderVolumePercent();
    applyVolumePercent(current <= 0.5 ? lastAudibleVolumePercent : 0);
  });
  // While the user is actively dragging the slider, do NOT let a panel update() overwrite
  // the thumb from the (lagging) state volume — that yanks it back and makes the drag jump.
  let volumeDragging = false;
  const endVolumeDrag = (): void => { volumeDragging = false; };
  volSlider.addEventListener('pointerdown', () => { volumeDragging = true; });
  volSlider.addEventListener('pointerup', endVolumeDrag);
  volSlider.addEventListener('pointercancel', endVolumeDrag);
  volSlider.addEventListener('blur', endVolumeDrag);
  // pointerup can land outside the slider if the cursor leaves it mid-drag.
  window.addEventListener('pointerup', endVolumeDrag);
  volSlider.addEventListener('input', () => {
    applyVolumePercent(readSliderVolumePercent());
  });

  prevBtn.addEventListener('click', () => { handlers.onPrevTrack(); });
  playBtn.addEventListener('click', () => { handlers.onTogglePlayPause(); });
  nextBtn.addEventListener('click', () => { handlers.onNextTrack(); });
  tempoAdjustBtn.addEventListener('click', () => {
    setTempoAdjustOpen(!tempoAdjustPanel.isOpen());
  });
  tapBtn.addEventListener('click', () => {
    tapOpen = !tapOpen;
    setTapOpen(tapOpen);
    handlers.onToggleTap();
  });
  updateVolumeVisual();
  updateVolumeButtonState();
  setTempoAdjustOpen(false);
  setTapOpen(false);

  container.appendChild(root);

  return {
    update(input) {
      playIcon.classList.toggle('is-paused', input.isPlaying);
      playBtn.classList.toggle('bc-btn-play-active', input.isPlaying);
      const volume = Number.isFinite(input.volume) ? Math.max(0, Math.min(1, Number(input.volume))) : 1;
      const muted = Boolean(input.muted) || volume <= 0.005;
      const volumePercent = muted ? 0 : volume * 100;
      // Skip while dragging: the user owns the thumb until they release (the input handler
      // keeps the visual in sync); overwriting here from lagging state causes the jump.
      if (!volumeDragging) {
        if (volumePercent > 0.5) {
          lastAudibleVolumePercent = volumePercent;
        }
        writeSliderVolumePercent(volumePercent);
        updateVolumeVisual(volumePercent);
        updateVolumeButtonState(volumePercent, muted);
      }
      tempoAdjustPanel.update(input.tempoAdjust);
    },
    getBottomSlot() {
      return analysisContent;
    },
    getTapSlot() {
      return tapPanelCell;
    },
    setTapOpen,
    destroy() {
      window.removeEventListener('pointerup', endVolumeDrag);
      tempoAdjustPanel.destroy();
      root.remove();
    },
  };
}
