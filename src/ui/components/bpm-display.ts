import { dom, setText } from '@/utils/dom';
import { buildKeyDisplay } from '@/shared/key-confidence';
import type { KeyAnalysisStatus } from '@/shared/types';
import type { KeyAnalysisResult } from '@/shared/types';

function confidenceLabel(confidence?: number, isAnalyzing = false): string {
  if (!Number.isFinite(confidence)) {
    return 'Confidence: Unknown';
  }
  const suffix = isAnalyzing ? ' (refining)' : '';
  if (Number(confidence) >= 25) {
    return `Confidence: High${suffix}`;
  }
  if (Number(confidence) >= 10) {
    return `Confidence: Medium${suffix}`;
  }
  return `Confidence: Low${suffix}`;
}

function confidenceClass(
  confidence?: number,
  isAnalyzing = false
): 'level-low' | 'level-medium' | 'level-high' | 'level-unknown' {
  if (!Number.isFinite(confidence)) {
    return 'level-unknown';
  }
  if (Number(confidence) >= 25) {
    return 'level-high';
  }
  if (Number(confidence) >= 10) {
    return 'level-medium';
  }
  return 'level-low';
}

function formatPlaybackTime(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export interface BpmDisplayInput {
  isIdle?: boolean;
  isPlaying?: boolean;
  currentTimeSec?: number;
  durationSec?: number;
  bpm?: number;
  confidence?: number;
  isAnalyzing?: boolean;
  keyAnalysisEnabled?: boolean;
  keyAnalysis?: KeyAnalysisResult;
  keyStatus?: KeyAnalysisStatus;
  keyUnavailable?: boolean;
  keyAnalysisCompleted?: boolean;
}

export interface BpmDisplayComponent {
  update(input: BpmDisplayInput): void;
  destroy(): void;
}

const PAUSED_PROGRESS_PULSE_MIN_TIME_SEC = 0.25;
const PAUSED_PROGRESS_END_EPSILON_SEC = 0.25;

function isPausedWithStartedPlayhead(input: BpmDisplayInput): boolean {
  if (input.isIdle || input.isPlaying) {
    return false;
  }
  const currentTimeSec = Number(input.currentTimeSec);
  const durationSec = Number(input.durationSec);
  if (!Number.isFinite(currentTimeSec) || currentTimeSec <= PAUSED_PROGRESS_PULSE_MIN_TIME_SEC) {
    return false;
  }
  return !Number.isFinite(durationSec) || durationSec <= 0 || currentTimeSec < durationSec - PAUSED_PROGRESS_END_EPSILON_SEC;
}

export function createBpmDisplay(container: HTMLElement): BpmDisplayComponent {
  const setDotLevel = (dot: HTMLElement, level: 'level-low' | 'level-medium' | 'level-high' | 'level-unknown'): void => {
    dot.className = `bc-bpm-confidence-dot ${level}`;
  };

  const timeVal = dom('span', {
    class: 'bc-transport-meta-value bc-transport-time-value',
    title: 'Current / Total Time'
  });
  const currentTimeVal = dom('span', { class: 'bc-transport-time-part bc-transport-current-time' }, ['--']);
  const timeSeparator = dom('span', { class: 'bc-transport-time-separator', 'aria-hidden': 'true' }, ['/']);
  const totalTimeVal = dom('span', { class: 'bc-transport-time-part bc-transport-total-time' }, ['--']);
  timeVal.appendChild(currentTimeVal);
  timeVal.appendChild(timeSeparator);
  timeVal.appendChild(totalTimeVal);
  const timeCell = dom('div', { class: 'bc-transport-meta-item bc-transport-time-item' }, [timeVal]);

  const bpmLabel = dom('span', { class: 'bc-transport-meta-label' }, ['BPM']);
  const confDot = dom('span', {
    class: 'bc-bpm-confidence-dot level-unknown',
    title: 'Confidence: Unknown',
    'aria-label': 'Confidence: Unknown'
  });
  const bpmLabelWrap = dom('span', { class: 'bc-bpm-label-wrap' }, [bpmLabel, confDot]);
  const bpmVal   = dom('span', { class: 'bc-transport-meta-value' });
  const bpmValueText = dom('span', { class: 'bc-bpm-main-value-text' }, ['---']);
  const loadingIcon = dom('span', { class: 'bc-bpm-main-loading-icon', 'aria-hidden': 'true' });
  loadingIcon.style.visibility = 'hidden';
  const bpmValueSlot = dom('span', { class: 'bc-bpm-value-slot' }, [bpmValueText, loadingIcon]);
  bpmVal.appendChild(bpmValueSlot);
  const bpmCell  = dom('div',  { class: 'bc-transport-meta-item' }, [bpmLabelWrap, bpmVal]);

  const keyLabel = dom('span', { class: 'bc-transport-meta-label' }, ['KEY']);
  const keyVal = dom('span', { class: 'bc-transport-meta-value bc-key-main-value' });
  const key1Dot = dom('span', { class: 'bc-bpm-confidence-dot level-unknown' });
  const key1Text = dom('span', { class: 'bc-key-main-value-text' }, ['---']);
  const key1LoadingIcon = dom('span', { class: 'bc-bpm-main-loading-icon', 'aria-hidden': 'true' });
  key1LoadingIcon.style.visibility = 'hidden';
  const key2Dot = dom('span', { class: 'bc-bpm-confidence-dot level-unknown' });
  const key2Text = dom('span', { class: 'bc-key-main-value-text' }, ['---']);
  const key2LoadingIcon = dom('span', { class: 'bc-bpm-main-loading-icon', 'aria-hidden': 'true' });
  key2LoadingIcon.style.visibility = 'hidden';
  const key1ValueSlot = dom('span', { class: 'bc-key-value-slot' }, [key1Text, key1LoadingIcon]);
  const key2ValueSlot = dom('span', { class: 'bc-key-value-slot' }, [key2Text, key2LoadingIcon]);
  const key1Wrap = dom('span', { class: 'bc-key-main-entry' }, [key1Dot, key1ValueSlot]);
  const key2Wrap = dom('span', { class: 'bc-key-main-entry' }, [key2Dot, key2ValueSlot]);
  keyVal.appendChild(key1Wrap);
  keyVal.appendChild(key2Wrap);
  const keyCell  = dom('div',  { class: 'bc-transport-meta-item' }, [keyLabel, keyVal]);

  const root = dom('div', { class: 'bc-transport-meta-grid' }, [timeCell, bpmCell, keyCell]);
  container.appendChild(root);

  let lastInput: BpmDisplayInput | null = null;
  let lastInputUpdatedAtMs = 0;
  let timeAnimationRafId = 0;

  const cancelTimeAnimation = (): void => {
    if (!timeAnimationRafId) {
      return;
    }
    window.cancelAnimationFrame(timeAnimationRafId);
    timeAnimationRafId = 0;
  };

  const renderTimeReadout = (): void => {
    const input = lastInput;
    if (!input || input.isIdle) {
      setText(currentTimeVal, '--');
      setText(totalTimeVal, '--');
      return;
    }

    const rawCurrent = Number(input.currentTimeSec);
    const rawDuration = Number(input.durationSec);
    const baseCurrent = Number.isFinite(rawCurrent) ? Math.max(0, rawCurrent) : 0;
    const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const elapsedSec =
      input.isPlaying && durationSec > 0 && lastInputUpdatedAtMs > 0
        ? Math.max(0, (performance.now() - lastInputUpdatedAtMs) / 1000)
        : 0;
    const currentTimeSec =
      durationSec > 0
        ? Math.min(durationSec, baseCurrent + elapsedSec)
        : baseCurrent + elapsedSec;

    setText(currentTimeVal, formatPlaybackTime(currentTimeSec));
    setText(totalTimeVal, formatPlaybackTime(durationSec));
  };

  const syncTimeAnimation = (): void => {
    const input = lastInput;
    if (!input?.isPlaying || !(Number(input.durationSec) > 0)) {
      cancelTimeAnimation();
      return;
    }
    if (timeAnimationRafId) {
      return;
    }
    timeAnimationRafId = window.requestAnimationFrame(() => {
      timeAnimationRafId = 0;
      renderTimeReadout();
      syncTimeAnimation();
    });
  };

  return {
    update(input) {
      lastInput = input;
      lastInputUpdatedAtMs = performance.now();
      renderTimeReadout();
      syncTimeAnimation();
      currentTimeVal.classList.toggle('bc-transport-current-time-paused-progress', isPausedWithStartedPlayhead(input));

      const bpm = input?.bpm;
      const confidence = input?.confidence;
      const isAnalyzing = Boolean(input?.isAnalyzing);
      const keyAnalysisEnabled = Boolean(input?.keyAnalysisEnabled);
      const keyStatus = input?.keyStatus;
      const keyUnavailable = keyAnalysisEnabled && Boolean(input?.keyUnavailable);
      const keyAnalysisCompleted = keyAnalysisEnabled && Boolean(input?.keyAnalysisCompleted);
      const keyDisplay = buildKeyDisplay(keyAnalysisEnabled ? input?.keyAnalysis : undefined, {
        isAnalyzing: keyAnalysisEnabled && (keyStatus === 'pending-bpm' || keyStatus === 'analyzing')
      });
      keyCell.classList.toggle('bc-key-disabled', !keyAnalysisEnabled);

      const showLoading = isAnalyzing && !(typeof bpm === 'number' && Number.isFinite(bpm));
      bpmVal.classList.toggle('is-loading', showLoading);

      if (showLoading) {
        bpmValueText.style.visibility = 'hidden';
        loadingIcon.style.visibility = 'visible';
      } else if (typeof bpm === 'number' && Number.isFinite(bpm)) {
        loadingIcon.style.visibility = 'hidden';
        bpmValueText.style.visibility = 'visible';
        setText(bpmValueText, String(Math.round(bpm)));
      } else {
        loadingIcon.style.visibility = 'hidden';
        bpmValueText.style.visibility = 'visible';
        setText(bpmValueText, '---');
      }

      const nextLabel = confidenceLabel(confidence, isAnalyzing);
      const nextClass = confidenceClass(confidence, isAnalyzing);
      setDotLevel(confDot, nextClass);
      confDot.title = nextLabel;
      confDot.setAttribute('aria-label', nextLabel);

      const key1Value = (
        (keyUnavailable || keyAnalysisCompleted) && !keyDisplay.key1.loading && keyDisplay.key1.value === '---'
      ) ? 'N/A' : keyDisplay.key1.value;
      const key2Value = (
        (keyUnavailable || keyAnalysisCompleted) && !keyDisplay.key2.loading && keyDisplay.key2.value === '---'
      ) ? 'N/A' : keyDisplay.key2.value;
      setText(key1Text, key1Value);
      setText(key2Text, key2Value);
      key2Wrap.classList.toggle('is-empty', !keyDisplay.key2.present && key2Value === '---');

      setDotLevel(key1Dot, keyDisplay.key1.loading || !keyDisplay.key1.present ? 'level-unknown' : keyDisplay.key1.level);
      setDotLevel(key2Dot, keyDisplay.key2.loading || !keyDisplay.key2.present ? 'level-unknown' : keyDisplay.key2.level);

      key1LoadingIcon.style.visibility = keyDisplay.key1.loading ? 'visible' : 'hidden';
      key2LoadingIcon.style.visibility = keyDisplay.key2.loading ? 'visible' : 'hidden';
      key1Text.style.visibility = keyDisplay.key1.loading ? 'hidden' : 'visible';
      key2Text.style.visibility = keyDisplay.key2.loading ? 'hidden' : 'visible';
      key1Dot.title = `KEY confidence: ${Math.round(keyDisplay.key1.score)}%`;
      key2Dot.title = `KEY2 confidence: ${Math.round(keyDisplay.key2.score)}%`;
    },
    destroy() {
      cancelTimeAnimation();
      root.remove();
    },
  };
}
