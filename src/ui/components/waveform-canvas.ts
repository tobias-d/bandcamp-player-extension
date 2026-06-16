import type { PanelInput, WaveformBands, WaveformLoadingPerformanceDebug } from '@/shared/types';
import { dom } from '@/utils/dom';
import {
  buildWaveformLayers,
  compositeWaveformFrame,
  hasRenderableWaveform,
  paletteSignature,
  resolvePalette,
  type WaveformLayers
} from '@/ui/components/waveform-draw';
import { fractionFromPointer } from '@/ui/components/waveform-interaction';

export interface WaveformCanvasComponent {
  update(input: PanelInput): void;
  destroy(): void;
}

interface WaveformHandlers {
  onSeekToFraction(fraction: number): void;
  onDebugTrace?(stage: string, detail: string): void;
  onPerformance?(snapshot: WaveformLoadingPerformanceDebug): void;
}

interface WaveformVisualState {
  waveformRef: WaveformBands | null;
  waveformStatus: string;
  showLoading: boolean;
  seekPending: boolean;
  seekPendingFraction: number | null;
  isIdle: boolean;
  dotCount: number;
  isPlaying: boolean;
  durationSec: number;
  playheadFraction: number;
}

const WAVE_LOADING_DOT_COUNT_ANALYZING = 18;
const WAVE_LOADING_DOT_COUNT_IDLE = 10;
const WAVE_LOADING_MAX_DOT_COUNT = WAVE_LOADING_DOT_COUNT_ANALYZING;
const WAVE_LOADING_IDLE_SPEED_MULTIPLIER = 1.8;
const WAVEFORM_REVEAL_DURATION_MS = 220;
const PLAYHEAD_INTERPOLATION_MAX_MS = 1500;
const WAVE_LOADING_DOT_RGBS: ReadonlyArray<string> = ['89,72,111', '113,106,169', '175,155,211'];
const WAVE_LOADING_STAGE_FADE_HOLD_MS = 720;
const WAVE_LOADING_LONG_FRAME_MS = 34;
const WAVE_LOADING_PERF_REPORT_MS = 500;

function isWaveformAnalysisStatus(statusText: string): boolean {
  const normalized = String(statusText || '').trim().toLowerCase();
  return normalized.includes('analyzing') || normalized.includes('computing');
}

function hasTerminalWaveformStatus(statusText: string): boolean {
  const normalized = String(statusText || '').trim();
  if (!normalized) {
    return false;
  }
  return !isWaveformAnalysisStatus(normalized);
}

function shouldShowWaveformLoading(input: PanelInput, hasWaveform: boolean, waveformStatus: string): boolean {
  if (hasWaveform) {
    return false;
  }

  if (isIdleInput(input)) {
    return true;
  }

  if (hasTerminalWaveformStatus(waveformStatus)) {
    return false;
  }

  return Boolean(String(input.analysis?.sourceUrl || '').trim());
}

function isIdleInput(input: PanelInput): boolean {
  const durationSec = Number(input.durationSec);
  const noLoadedDuration = !Number.isFinite(durationSec) || durationSec <= 0;
  return !input.isPlaying && noLoadedDuration;
}

function resolveWaveformSeekMode(input: PanelInput | null): NonNullable<PanelInput['waveformSeekMode']> {
  return input?.waveformSeekMode === 'continuous' ? 'continuous' : 'commit-on-release';
}

export function createWaveformCanvas(container: HTMLElement, handlers: WaveformHandlers): WaveformCanvasComponent {
  const root = dom('div', { class: 'bc-waveform-stub bc-waveform' });
  const canvas = dom('canvas', {
    class: 'bc-waveform-canvas',
    width: '320',
    height: '68',
    role: 'button',
    tabindex: '0',
    'aria-label': 'Seek waveform'
  }) as HTMLCanvasElement;
  const seekOverlay = dom('div', { class: 'bc-waveform-seek-overlay', 'aria-hidden': 'true' });
  const loading = dom('div', { class: 'bc-waveform-loading', 'aria-hidden': 'true' });

  root.appendChild(canvas);
  root.appendChild(seekOverlay);
  root.appendChild(loading);
  container.appendChild(root);

  let lastInput: PanelInput | null = null;
  let loadingFadeOutTimer: number | null = null;
  let optimisticPlayheadFraction: number | null = null;
  let optimisticPlayheadSetAtMs = 0;
  let waveformRevealRafId = 0;
  let waveformRevealStartMs = 0;
  let waveformRevealFraction = 1;
  let lastInputUpdatedAtMs = 0;
  let playheadAnimationRafId = 0;
  let lastRenderableWaveformKey = '';
  // Pre-rendered static waveform layers (past/future). Rebuilt only when the
  // waveform, physical canvas size, or palette changes — not per animation frame.
  let waveformLayers: WaveformLayers | null = null;
  let waveformLayersKey = '';
  let cachedCssWidth = 0;
  let cachedCssHeight = 0;
  let lastCanvasPhysWidth = 0;
  let lastCanvasPhysHeight = 0;
  let lastLoadingWidth = 0;
  let cachedCtx: CanvasRenderingContext2D | null = null;
  let lastVisualState: WaveformVisualState | null = null;
  let lastLoadingVisible = false;
  let lastWaveformReady = false;
  let loadingPerfRafId = 0;
  let loadingPerfStartedAt = 0;
  let loadingPerfLastFrameAt = 0;
  let loadingPerfLastReportAt = 0;
  let loadingPerfSampleCount = 0;
  let loadingPerfLongFrameCount = 0;
  let loadingPerfTotalFrameMs = 0;
  let loadingPerfMaxFrameMs = 0;
  let loadingPerfLastFrameMs = 0;

  const appendDebugTrace = (stage: string, detail: string): void => {
    handlers.onDebugTrace?.(stage, detail);
  };

  const formatTraceContext = (input: PanelInput, extras: string[] = []): string => {
    const parts = [
      `source=${String(input.analysis?.sourceUrl || '').trim() || '-'}`,
      `status=${String(input.analysis?.waveformStatus || '').trim() || '-'}`,
      `playing=${input.isPlaying ? '1' : '0'}`,
      ...extras
    ];
    return parts.join(' ');
  };

  const reportLoadingPerformance = (active: boolean): void => {
    const now = Date.now();
    handlers.onPerformance?.({
      active,
      dotCount: lastVisualState?.dotCount || 0,
      sampleCount: loadingPerfSampleCount,
      longFrameCount: loadingPerfLongFrameCount,
      avgFrameMs: loadingPerfSampleCount > 0 ? loadingPerfTotalFrameMs / loadingPerfSampleCount : 0,
      maxFrameMs: loadingPerfMaxFrameMs,
      lastFrameMs: loadingPerfLastFrameMs,
      durationMs: loadingPerfStartedAt > 0 ? Math.max(0, performance.now() - loadingPerfStartedAt) : 0,
      lastUpdateTs: now
    });
  };

  const stopLoadingPerformanceMonitor = (): void => {
    if (loadingPerfRafId) {
      window.cancelAnimationFrame(loadingPerfRafId);
      loadingPerfRafId = 0;
    }
    if (loadingPerfStartedAt > 0) {
      reportLoadingPerformance(false);
    }
    loadingPerfStartedAt = 0;
    loadingPerfLastFrameAt = 0;
    loadingPerfLastReportAt = 0;
    loadingPerfSampleCount = 0;
    loadingPerfLongFrameCount = 0;
    loadingPerfTotalFrameMs = 0;
    loadingPerfMaxFrameMs = 0;
    loadingPerfLastFrameMs = 0;
  };

  const stepLoadingPerformanceMonitor = (timestampMs: number): void => {
    if (!loading.classList.contains('isVisible')) {
      stopLoadingPerformanceMonitor();
      return;
    }

    if (!loadingPerfStartedAt) {
      loadingPerfStartedAt = timestampMs;
      loadingPerfLastReportAt = timestampMs;
    }
    if (loadingPerfLastFrameAt > 0) {
      const frameMs = Math.max(0, timestampMs - loadingPerfLastFrameAt);
      loadingPerfLastFrameMs = frameMs;
      loadingPerfSampleCount += 1;
      loadingPerfTotalFrameMs += frameMs;
      loadingPerfMaxFrameMs = Math.max(loadingPerfMaxFrameMs, frameMs);
      if (frameMs >= WAVE_LOADING_LONG_FRAME_MS) {
        loadingPerfLongFrameCount += 1;
      }
    }
    loadingPerfLastFrameAt = timestampMs;

    if (timestampMs - loadingPerfLastReportAt >= WAVE_LOADING_PERF_REPORT_MS) {
      loadingPerfLastReportAt = timestampMs;
      reportLoadingPerformance(true);
    }

    loadingPerfRafId = window.requestAnimationFrame(stepLoadingPerformanceMonitor);
  };

  const startLoadingPerformanceMonitor = (): void => {
    if (loadingPerfRafId) {
      return;
    }
    loadingPerfStartedAt = 0;
    loadingPerfLastFrameAt = 0;
    loadingPerfLastReportAt = 0;
    loadingPerfSampleCount = 0;
    loadingPerfLongFrameCount = 0;
    loadingPerfTotalFrameMs = 0;
    loadingPerfMaxFrameMs = 0;
    loadingPerfLastFrameMs = 0;
    loadingPerfRafId = window.requestAnimationFrame(stepLoadingPerformanceMonitor);
  };

  const buildVisualState = (input: PanelInput): WaveformVisualState => {
    const waveform = hasRenderableWaveform(input.analysis?.waveform) ? input.analysis.waveform : null;
    const waveformStatus = String(input.analysis?.waveformStatus || '').trim();
    const isIdle = isIdleInput(input);
    const seekPending = Boolean(input.seekPending);
    const seekPendingFraction =
      seekPending && Number.isFinite(input.seekPendingFraction)
        ? Math.max(0, Math.min(1, Number(input.seekPendingFraction)))
        : null;
    const dotCount = isIdle ? WAVE_LOADING_DOT_COUNT_IDLE : WAVE_LOADING_DOT_COUNT_ANALYZING;
    const showLoading = shouldShowWaveformLoading(input, Boolean(waveform), waveformStatus);
    return {
      waveformRef: waveform,
      waveformStatus,
      showLoading,
      seekPending,
      seekPendingFraction,
      isIdle,
      dotCount,
      isPlaying: Boolean(input.isPlaying),
      durationSec: Number.isFinite(input.durationSec) ? Number(input.durationSec) : 0,
      playheadFraction: Number.isFinite(input.playheadFraction) ? Number(input.playheadFraction) : 0
    };
  };

  const visualStateChanged = (prev: WaveformVisualState | null, next: WaveformVisualState): boolean => {
    if (!prev) {
      return true;
    }

    const shouldCompareTransportState = Boolean(prev.waveformRef || next.waveformRef);

    return prev.waveformRef !== next.waveformRef
      || prev.waveformStatus !== next.waveformStatus
      || prev.showLoading !== next.showLoading
      || prev.seekPending !== next.seekPending
      || prev.seekPendingFraction !== next.seekPendingFraction
      || prev.isIdle !== next.isIdle
      || prev.dotCount !== next.dotCount
      || (
        shouldCompareTransportState
        && (
          prev.isPlaying !== next.isPlaying
          || prev.durationSec !== next.durationSec
          || prev.playheadFraction !== next.playheadFraction
        )
      );
  };

  const clearLoadingFadeOutTimer = (): void => {
    if (loadingFadeOutTimer === null) {
      return;
    }
    window.clearTimeout(loadingFadeOutTimer);
    loadingFadeOutTimer = null;
  };

  const easeOutCubic = (value: number): number => 1 - ((1 - value) ** 3);

  const cancelWaveformRevealAnimation = (): void => {
    if (!waveformRevealRafId) {
      return;
    }
    window.cancelAnimationFrame(waveformRevealRafId);
    waveformRevealRafId = 0;
  };

  const stepWaveformReveal = (timestampMs: number): void => {
    if (!waveformRevealStartMs) {
      waveformRevealStartMs = timestampMs;
    }

    const elapsedMs = Math.max(0, timestampMs - waveformRevealStartMs);
    const progress = Math.max(0, Math.min(1, elapsedMs / WAVEFORM_REVEAL_DURATION_MS));
    waveformRevealFraction = easeOutCubic(progress);
    render();

    if (progress >= 1) {
      waveformRevealRafId = 0;
      waveformRevealStartMs = 0;
      waveformRevealFraction = 1;
      // Reveal is done; hand off to the playhead animation loop if still playing.
      syncPlayheadAnimation();
      return;
    }

    waveformRevealRafId = window.requestAnimationFrame(stepWaveformReveal);
  };

  const startWaveformRevealAnimation = (): void => {
    cancelWaveformRevealAnimation();
    waveformRevealStartMs = 0;
    waveformRevealFraction = 0;
    waveformRevealRafId = window.requestAnimationFrame(stepWaveformReveal);
  };

  const cancelPlayheadAnimation = (): void => {
    if (!playheadAnimationRafId) {
      return;
    }
    window.cancelAnimationFrame(playheadAnimationRafId);
    playheadAnimationRafId = 0;
  };

  const shouldAnimatePlayhead = (): boolean => {
    const input = lastInput;
    if (!input) {
      return false;
    }
    if (optimisticPlayheadFraction !== null) {
      return false;
    }
    if (!input.isPlaying) {
      return false;
    }
    const durationSec = Number(input.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return false;
    }
    return hasRenderableWaveform(input.analysis?.waveform);
  };

  const getEffectivePlayheadFraction = (input: PanelInput): number => {
    if (input.seekPending && Number.isFinite(input.seekPendingFraction)) {
      return Math.max(0, Math.min(1, Number(input.seekPendingFraction)));
    }
    if (optimisticPlayheadFraction !== null) {
      return Math.max(0, Math.min(1, optimisticPlayheadFraction));
    }
    const baseFraction = Number(input.playheadFraction);
    const normalizedBase = Number.isFinite(baseFraction) ? Math.max(0, Math.min(1, baseFraction)) : 0;
    if (!input.isPlaying) {
      return normalizedBase;
    }
    const durationSec = Number(input.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || !lastInputUpdatedAtMs) {
      return normalizedBase;
    }
    const elapsedMs = Math.max(0, performance.now() - lastInputUpdatedAtMs);
    const boundedElapsedMs = Math.min(elapsedMs, PLAYHEAD_INTERPOLATION_MAX_MS);
    const deltaFraction = boundedElapsedMs / (durationSec * 1000);
    return Math.max(0, Math.min(1, normalizedBase + deltaFraction));
  };

  const syncPlayheadAnimation = (): void => {
    if (!shouldAnimatePlayhead()) {
      cancelPlayheadAnimation();
      return;
    }
    if (playheadAnimationRafId) {
      return;
    }
    // The reveal animation already drives render() every frame; don't double-schedule.
    if (waveformRevealRafId) {
      return;
    }
    playheadAnimationRafId = window.requestAnimationFrame(() => {
      playheadAnimationRafId = 0;
      render();
      syncPlayheadAnimation();
    });
  };

  const ensureLoadingDots = (): void => {
    if (loading.dataset.dotsReady === '1') {
      return;
    }

    loading.replaceChildren();
    for (let index = 0; index < WAVE_LOADING_MAX_DOT_COUNT; index += 1) {
      const dot = dom('span', { class: 'bc-waveform-loading-dot' });
      const delaySec = index * 0.1;
      const durationSec = 0.9 + ((index * 11) % 7) * 0.34 + ((index * 13) % 3) * 0.21;
      const sizePx = 2.6 + ((index * 7) % 3) * 0.75;
      const tailPx = 22 + (index % 4) * 10;
      const alpha = 0.58 + (index % 3) * 0.1;
      const laneCount = 9;
      const lanePos = ((index * 5) % laneCount) / (laneCount - 1);
      const yOffsetPx = Math.round((lanePos * 2 - 1) * 22);
      const driftPx = (((index * 7) % 7) - 3) * 1.7;
      const dotRgb = WAVE_LOADING_DOT_RGBS[index % WAVE_LOADING_DOT_RGBS.length];

      dot.style.setProperty('--dot-delay', `${delaySec.toFixed(2)}s`);
      dot.style.setProperty('--dot-duration', `${durationSec.toFixed(2)}s`);
      dot.style.setProperty('--dot-size', `${sizePx.toFixed(1)}px`);
      dot.style.setProperty('--dot-tail', `${tailPx}px`);
      dot.style.setProperty('--dot-alpha', `${alpha.toFixed(2)}`);
      dot.style.setProperty('--dot-rgb', dotRgb);
      dot.style.setProperty('--dot-y', `${yOffsetPx}px`);
      dot.style.setProperty('--dot-drift', `${driftPx.toFixed(1)}px`);

      loading.appendChild(dot);
    }

    loading.dataset.dotsReady = '1';
  };

  const setLoadingDotCount = (dotCount: number): void => {
    const normalizedDotCount = Math.max(1, Math.min(WAVE_LOADING_MAX_DOT_COUNT, Math.floor(dotCount)));
    if (Number.parseInt(String(loading.dataset.dotCount || ''), 10) === normalizedDotCount) {
      return;
    }

    Array.from(loading.children).forEach((child, index) => {
      if (!(child instanceof HTMLElement)) {
        return;
      }
      child.classList.toggle('isInactive', index >= normalizedDotCount);
    });

    loading.dataset.dotCount = String(normalizedDotCount);
  };

  const syncLoadingState = (showLoading: boolean, hasWaveform: boolean, dotCount: number): void => {
    ensureLoadingDots();
    setLoadingDotCount(dotCount);

    if (showLoading) {
      clearLoadingFadeOutTimer();
      loading.classList.remove('isWaveReady');
      loading.classList.add('isVisible');
      startLoadingPerformanceMonitor();
      return;
    }

    if (hasWaveform) {
      const wasLoadingVisible =
        loading.classList.contains('isVisible') || loading.classList.contains('isWaveReady');

      if (!wasLoadingVisible) {
        clearLoadingFadeOutTimer();
        loading.classList.remove('isVisible', 'isWaveReady');
        return;
      }

      loading.classList.add('isVisible', 'isWaveReady');
      if (lastInput && loadingFadeOutTimer === null) {
        appendDebugTrace(
          'waveform-ui-loading-release',
          formatTraceContext(lastInput, [`holdMs=${WAVE_LOADING_STAGE_FADE_HOLD_MS}`])
        );
      }
      if (loadingFadeOutTimer === null) {
        loadingFadeOutTimer = window.setTimeout(() => {
          loadingFadeOutTimer = null;
          loading.classList.remove('isVisible', 'isWaveReady');
          stopLoadingPerformanceMonitor();
          const input = lastInput;
          if (input) {
            appendDebugTrace(
              'waveform-ui-loading-hidden',
              formatTraceContext(input, [`holdMs=${WAVE_LOADING_STAGE_FADE_HOLD_MS}`])
            );
          }
        }, WAVE_LOADING_STAGE_FADE_HOLD_MS);
      }
      return;
    }

    clearLoadingFadeOutTimer();
    loading.classList.remove('isVisible', 'isWaveReady');
    stopLoadingPerformanceMonitor();
  };

  const render = (): void => {
    const input = lastInput;
    if (!input) {
      return;
    }

    // Use ResizeObserver-cached dimensions; only fall back to getBoundingClientRect on first paint.
    if (!cachedCssWidth || !cachedCssHeight) {
      const rect = root.getBoundingClientRect();
      cachedCssWidth = Math.max(1, Math.floor(rect.width || 320));
      cachedCssHeight = Math.max(1, Math.floor(rect.height || 68));
    }
    const width = cachedCssWidth;
    const height = cachedCssHeight;
    if (width !== lastLoadingWidth) {
      loading.style.setProperty('--wave-loading-width', `${width}px`);
      lastLoadingWidth = width;
    }

    // Resize canvas backing store only when physical pixel size actually changes.
    // Setting canvas.width unconditionally resets the GPU texture every frame.
    const dpr = window.devicePixelRatio || 1;
    const physWidth = Math.max(1, Math.floor(width * dpr));
    const physHeight = Math.max(1, Math.floor(height * dpr));
    if (physWidth !== lastCanvasPhysWidth || physHeight !== lastCanvasPhysHeight || !cachedCtx) {
      cachedCtx = canvas.getContext('2d');
      if (!cachedCtx) {
        return;
      }
      canvas.width = physWidth;
      canvas.height = physHeight;
      lastCanvasPhysWidth = physWidth;
      lastCanvasPhysHeight = physHeight;
    }
    const context = cachedCtx;
    if (!context) {
      return;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const waveform = input.analysis?.waveform;
    const hasWaveform = hasRenderableWaveform(waveform);
    const effectivePlayheadFraction = getEffectivePlayheadFraction(input);
    seekOverlay.style.setProperty(
      '--wave-seek-overlay-width',
      `${Math.max(0, Math.min(width, Math.round(width * effectivePlayheadFraction)))}px`
    );
    if (hasWaveform) {
      const waveformKey = [
        String(input.analysis?.sourceUrl || '').trim(),
        String(input.analysis?.waveformDebugContentKey || input.analysis?.waveformDebugBackendKey || '').trim(),
        Math.round(Number(waveform.buckets) || 0),
        Math.round(Number(waveform.duration) || 0)
      ].join('|');
      if (waveformKey !== lastRenderableWaveformKey) {
        lastRenderableWaveformKey = waveformKey;
        startWaveformRevealAnimation();
      }

      // Rebuild the static layers only when the waveform, physical size, or palette
      // changes; the steady-state playhead loop just re-composites them.
      const palette = resolvePalette(canvas);
      const layersKey = [waveformKey, physWidth, physHeight, paletteSignature(palette)].join('|');
      if (!waveformLayers || waveformLayersKey !== layersKey) {
        waveformLayers = buildWaveformLayers(width, height, dpr, waveform, palette);
        waveformLayersKey = waveformLayers ? layersKey : '';
      }

      if (waveformLayers) {
        const revealWidth = Math.max(0, Math.min(width, Math.round(width * waveformRevealFraction)));
        context.save();
        context.beginPath();
        context.rect(0, 0, revealWidth, height);
        context.clip();
        compositeWaveformFrame(context, width, height, waveformLayers, effectivePlayheadFraction);
        context.restore();
      } else {
        context.clearRect(0, 0, width, height);
      }
    } else {
      cancelWaveformRevealAnimation();
      waveformRevealFraction = 1;
      lastRenderableWaveformKey = '';
      waveformLayers = null;
      waveformLayersKey = '';
      context.clearRect(0, 0, width, height);
    }

    const analysisStatus = String(input.analysis?.waveformStatus || '');
    const isIdle = isIdleInput(input);
    const seekPending = Boolean(input.seekPending);
    const dotCount = isIdle ? WAVE_LOADING_DOT_COUNT_IDLE : WAVE_LOADING_DOT_COUNT_ANALYZING;
    loading.style.setProperty(
      '--wave-dot-speed-multiplier',
      isIdle ? String(WAVE_LOADING_IDLE_SPEED_MULTIPLIER) : '1'
    );
    seekOverlay.classList.toggle('isVisible', seekPending);

    const showLoading = shouldShowWaveformLoading(input, hasWaveform, analysisStatus);
    if (showLoading && !lastLoadingVisible) {
      appendDebugTrace('waveform-ui-loading-visible', formatTraceContext(input, [`dots=${dotCount}`]));
    }
    if (hasWaveform && !lastWaveformReady) {
      appendDebugTrace(
        'waveform-ui-render-ready',
        formatTraceContext(input, [
          `buckets=${Number.isFinite(input.analysis?.waveform?.buckets) ? Math.round(Number(input.analysis?.waveform?.buckets)) : '-'}`,
          `waveformMs=${Number.isFinite(input.analysis?.waveformMs) ? Math.round(Number(input.analysis?.waveformMs)) : '-'}`
        ])
      );
    }
    syncLoadingState(showLoading, hasWaveform, dotCount);
    lastLoadingVisible = showLoading;
    lastWaveformReady = hasWaveform;

    root.classList.toggle('bc-waveform-idle', isIdle);
    root.classList.toggle('bc-waveform-ready', hasWaveform);
    root.classList.toggle('bc-waveform-seek-pending', seekPending);
    syncPlayheadAnimation();
  };

  const previewSeekFraction = (fraction: number): void => {
    const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
    optimisticPlayheadFraction = clamped;
    optimisticPlayheadSetAtMs = performance.now();
    render();
    syncPlayheadAnimation();
  };

  const applySeekFraction = (fraction: number): void => {
    const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
    previewSeekFraction(clamped);
    handlers.onSeekToFraction(clamped);
  };

  const seekFromClientX = (clientX: number, options: { commit: boolean }): void => {
    const input = lastInput;
    if (!input || input.durationSec <= 0) {
      return;
    }

    const fraction = fractionFromPointer(clientX, root);
    if (options.commit) {
      applySeekFraction(fraction);
      return;
    }
    previewSeekFraction(fraction);
  };

  let dragging = false;
  let dragSeekRafId = 0;
  let pendingDragFraction = Number.NaN;

  const flushQueuedDragSeek = (): void => {
    dragSeekRafId = 0;
    if (!Number.isFinite(pendingDragFraction)) {
      return;
    }
    const fraction = pendingDragFraction;
    pendingDragFraction = Number.NaN;
    if (resolveWaveformSeekMode(lastInput) === 'continuous') {
      applySeekFraction(fraction);
      return;
    }
    previewSeekFraction(fraction);
  };

  const queueDragSeek = (event: PointerEvent): void => {
    pendingDragFraction = fractionFromPointer(event.clientX, root);
    if (dragSeekRafId) {
      return;
    }
    dragSeekRafId = window.requestAnimationFrame(flushQueuedDragSeek);
  };

  const flushPendingSeekNow = (): void => {
    if (dragSeekRafId) {
      window.cancelAnimationFrame(dragSeekRafId);
      dragSeekRafId = 0;
    }
    if (!Number.isFinite(pendingDragFraction)) {
      return;
    }
    const fraction = pendingDragFraction;
    pendingDragFraction = Number.NaN;
    applySeekFraction(fraction);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragging = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail on unsupported environments.
    }
    seekFromClientX(event.clientX, {
      commit: resolveWaveformSeekMode(lastInput) === 'continuous'
    });
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    queueDragSeek(event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    event.preventDefault();
    dragging = false;
    pendingDragFraction = fractionFromPointer(event.clientX, root);
    flushPendingSeekNow();
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures.
    }
  };

  const onPointerCancel = (): void => {
    dragging = false;
    pendingDragFraction = Number.NaN;
    optimisticPlayheadFraction = null;
    if (dragSeekRafId) {
      window.cancelAnimationFrame(dragSeekRafId);
      dragSeekRafId = 0;
    }
    render();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }

    const input = lastInput;
    if (!input || input.durationSec <= 0) {
      return;
    }

    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 0.02 : -0.02;
    const nextFraction = Math.max(0, Math.min(1, input.playheadFraction + delta));
    applySeekFraction(nextFraction);
  };

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          cachedCssWidth = Math.max(1, Math.floor(cr.width || 320));
          cachedCssHeight = Math.max(1, Math.floor(cr.height || 68));
        }
        render();
      })
    : null;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('keydown', onKeyDown);
  resizeObserver?.observe(root);
  ensureLoadingDots();
  setLoadingDotCount(WAVE_LOADING_DOT_COUNT_IDLE);

  return {
    update(input) {
      lastInput = input;
      lastInputUpdatedAtMs = performance.now();
      if (!dragging && optimisticPlayheadFraction !== null && !input.seekPending) {
        const ageMs = performance.now() - optimisticPlayheadSetAtMs;
        const real = Number.isFinite(input.playheadFraction) ? input.playheadFraction : 0;
        if (ageMs > 2500 || Math.abs(real - optimisticPlayheadFraction) <= 0.04) {
          optimisticPlayheadFraction = null;
        }
      }
      const nextVisualState = buildVisualState(input);
      const shouldRenderImmediately =
        visualStateChanged(lastVisualState, nextVisualState)
        || waveformRevealRafId !== 0
        || playheadAnimationRafId !== 0
        || optimisticPlayheadFraction !== null;
      lastVisualState = nextVisualState;
      if (shouldRenderImmediately) {
        render();
      } else {
        syncPlayheadAnimation();
      }
    },
    destroy() {
      clearLoadingFadeOutTimer();
      stopLoadingPerformanceMonitor();
      cancelWaveformRevealAnimation();
      cancelPlayheadAnimation();
      waveformLayers = null;
      waveformLayersKey = '';
      if (dragSeekRafId) {
        window.cancelAnimationFrame(dragSeekRafId);
      }
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('keydown', onKeyDown);
      resizeObserver?.disconnect();
      root.remove();
    }
  };
}
