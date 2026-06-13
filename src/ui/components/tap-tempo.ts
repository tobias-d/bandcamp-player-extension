import { dom } from '@/utils/dom';
import type { PanelInput } from '@/shared/types';

export interface TapTempoComponent {
  update(hidden: boolean, input?: PanelInput): void;
  tapFromShortcut(): void;
  destroy(): void;
}

const TAP_RESET_GAP_MS = 2500;
const TAP_LONG_PRESS_MS = 2000;
const TAP_MIN_COUNT_FOR_ESTIMATE = 5;
const TAP_MAX_INTERVAL_WINDOW_SIZE = 24;

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function computeTapTrackKey(input?: PanelInput): string {
  if (!input) {
    return '';
  }

  const playlist = input.playlist;
  const track =
    Array.isArray(playlist?.tracks) && Number.isFinite(playlist?.currentIndex)
      ? playlist.tracks[Math.max(0, Math.min(playlist.tracks.length - 1, Number(playlist.currentIndex)))]
      : null;

  const trackId = normalizeToken(track?.trackId);
  const streamUrl = normalizeToken(track?.streamUrl || input.analysis?.sourceUrl);
  if (trackId || streamUrl) {
    return `s:${trackId}|${streamUrl}`;
  }

  const artist = normalizeToken(input.metadata?.artistName);
  const title = normalizeToken(input.metadata?.trackTitle);
  const album = normalizeToken(input.metadata?.albumTitle);
  const combined = normalizeToken(input.metadata?.combined);
  if (artist || title || album || combined) {
    return `m:${artist}|${title}|${album}|${combined}`;
  }

  return '';
}

function computeTapBpmFromTimes(timesMs: number[]): number {
  if (!Array.isArray(timesMs) || timesMs.length < TAP_MIN_COUNT_FOR_ESTIMATE) {
    return Number.NaN;
  }

  const intervals: number[] = [];
  for (let i = 1; i < timesMs.length; i += 1) {
    const dt = timesMs[i] - timesMs[i - 1];
    if (Number.isFinite(dt) && dt > 0) {
      intervals.push(dt);
    }
  }
  if (!intervals.length) {
    return Number.NaN;
  }

  if (intervals.length < TAP_MIN_COUNT_FOR_ESTIMATE - 1) {
    return Number.NaN;
  }

  // Adaptive window: grows with more taps for increased stability.
  const adaptiveWindowSize = Math.max(
    4,
    Math.min(
      TAP_MAX_INTERVAL_WINDOW_SIZE,
      intervals.length,
      Math.floor(4 + Math.log2(Math.max(1, intervals.length)) * 6)
    )
  );
  const recentIntervals = intervals.slice(-adaptiveWindowSize);
  const sorted = [...recentIntervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // Robust outlier filtering using median absolute deviation.
  const absoluteDeviations = recentIntervals.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const madMid = Math.floor(absoluteDeviations.length / 2);
  const mad =
    absoluteDeviations.length % 2 === 1
      ? absoluteDeviations[madMid]
      : (absoluteDeviations[madMid - 1] + absoluteDeviations[madMid]) / 2;

  const intervalsToUse =
    mad > 1
      ? recentIntervals.filter((x) => Math.abs(0.6745 * (x - median) / mad) <= 3.5)
      : recentIntervals.filter((x) => x >= median * 0.7 && x <= median * 1.3);

  const stableIntervals = intervalsToUse.length >= 3 ? intervalsToUse : recentIntervals;

  // Weighted mean where newer taps count slightly more while preserving history.
  let weightedSum = 0;
  let totalWeight = 0;
  for (let i = 0; i < stableIntervals.length; i += 1) {
    const weight = i + 1;
    weightedSum += stableIntervals[i] * weight;
    totalWeight += weight;
  }
  const averageMs = weightedSum / Math.max(1, totalWeight);
  const bpm = 60000 / averageMs;
  return Number.isFinite(bpm) ? bpm : Number.NaN;
}

export function createTapTempo(container: HTMLElement): TapTempoComponent {
  const bpmValue = dom('span', { class: 'bc-bpm-val' }, ['---']);
  const leftPlaceholder = dom('div', { class: 'bc-tap-left-placeholder' }, [
    dom('span', { class: 'bc-bpm-label' }, ['BPM']),
    bpmValue
  ]);
  const leftColumn = dom('div', { class: 'bc-tap-column bc-tap-column-left' }, [leftPlaceholder]);
  const tapHint = dom('div', { class: 'bc-tap-hint' }, [
    dom('span', { class: 'bc-tap-hint-line' }, ['Click or tap here']),
    dom('span', { class: 'bc-tap-hint-line' }, ['to detect tempo']),
    dom('span', { class: 'bc-tap-hint-line' }, ['hold to reset'])
  ]);
  const tapTarget = dom(
    'button',
    {
      type: 'button',
      class: 'bc-tap-target',
      title: 'Tap tempo (hold to reset)',
      'aria-label': 'Tap tempo (hold to reset)'
    },
    [tapHint]
  );
  const rightColumn = dom('div', { class: 'bc-tap-column bc-tap-column-right' }, [tapTarget]);
  const separator = dom('div', { class: 'bc-tap-separator', 'aria-hidden': 'true' });
  const root = dom('div', { class: 'bc-tap-stub' }, [leftColumn, separator, rightColumn]);
  container.appendChild(root);

  let tapTimesMs: number[] = [];
  let tapBpm = Number.NaN;
  let tapLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let tapLongPressed = false;
  let lastTrackKey = '';

  const updateTapBpmUi = (): void => {
    bpmValue.textContent = Number.isFinite(tapBpm) ? String(Math.round(tapBpm)) : '---';
  };

  const spawnTapRipple = (clientX?: number, clientY?: number): void => {
    const rect = tapTarget.getBoundingClientRect();
    const localWidth = Math.max(1, tapTarget.clientWidth || tapTarget.offsetWidth || Math.round(rect.width));
    const localHeight = Math.max(1, tapTarget.clientHeight || tapTarget.offsetHeight || Math.round(rect.height));
    const normalizedX = Number.isFinite(clientX) && rect.width > 0 ? (Number(clientX) - rect.left) / rect.width : 0.5;
    const normalizedY = Number.isFinite(clientY) && rect.height > 0 ? (Number(clientY) - rect.top) / rect.height : 0.5;
    const x = Math.max(0, Math.min(localWidth, normalizedX * localWidth));
    const y = Math.max(0, Math.min(localHeight, normalizedY * localHeight));
    const ripple = dom('span', { class: 'bc-tap-ripple', 'aria-hidden': 'true' });
    ripple.style.left = `${Math.round(x)}px`;
    ripple.style.top = `${Math.round(y)}px`;
    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });
    tapTarget.appendChild(ripple);
  };

  const clearTapLongPressTimer = (): void => {
    if (tapLongPressTimer != null) {
      clearTimeout(tapLongPressTimer);
      tapLongPressTimer = null;
    }
  };

  const resetTapper = (): void => {
    tapTimesMs = [];
    tapBpm = Number.NaN;
    updateTapBpmUi();
  };

  const handleTap = (): void => {
    const now = performance.now();
    if (tapTimesMs.length > 0) {
      const gap = now - tapTimesMs[tapTimesMs.length - 1];
      if (gap > TAP_RESET_GAP_MS) {
        tapTimesMs = [];
      }
    }
    tapTimesMs.push(now);
    tapBpm = computeTapBpmFromTimes(tapTimesMs);
    updateTapBpmUi();
  };

  const onTapPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    spawnTapRipple(event.clientX, event.clientY);
    tapLongPressed = false;
    clearTapLongPressTimer();
    try {
      tapTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore browsers/environments where pointer capture is unavailable.
    }
    tapLongPressTimer = setTimeout(() => {
      tapLongPressed = true;
      resetTapper();
    }, TAP_LONG_PRESS_MS);
  };

  const onTapPointerUp = (event: PointerEvent): void => {
    event.preventDefault();
    clearTapLongPressTimer();
    if (!tapLongPressed) {
      handleTap();
    }
    tapLongPressed = false;
  };

  const onTapPointerCancel = (event?: PointerEvent): void => {
    event?.preventDefault();
    clearTapLongPressTimer();
    tapLongPressed = false;
  };

  const onTapKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      spawnTapRipple();
      handleTap();
      return;
    }
    if (event.key === 'Backspace' || event.key.toLowerCase() === 'r') {
      event.preventDefault();
      resetTapper();
    }
  };

  tapTarget.addEventListener('pointerdown', onTapPointerDown, true);
  tapTarget.addEventListener('pointerup', onTapPointerUp, true);
  tapTarget.addEventListener('pointercancel', onTapPointerCancel, true);
  tapTarget.addEventListener('pointerleave', onTapPointerCancel, true);
  tapTarget.addEventListener('keydown', onTapKeyDown, true);

  return {
    update(hidden, input) {
      const trackKey = computeTapTrackKey(input);
      if (trackKey && trackKey !== lastTrackKey) {
        resetTapper();
      }
      if (trackKey) {
        lastTrackKey = trackKey;
      }
      root.classList.toggle('visible', !hidden);
    },
    tapFromShortcut() {
      spawnTapRipple();
      handleTap();
    },
    destroy() {
      clearTapLongPressTimer();
      tapTarget.removeEventListener('pointerdown', onTapPointerDown, true);
      tapTarget.removeEventListener('pointerup', onTapPointerUp, true);
      tapTarget.removeEventListener('pointercancel', onTapPointerCancel, true);
      tapTarget.removeEventListener('pointerleave', onTapPointerCancel, true);
      tapTarget.removeEventListener('keydown', onTapKeyDown, true);
      root.remove();
    }
  };
}
