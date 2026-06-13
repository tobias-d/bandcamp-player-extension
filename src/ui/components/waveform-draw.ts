import type { WaveformBands } from '@/shared/types';

interface WaveArrays {
  low: number[];
  mid: number[];
  high: number[];
}

export interface WavePalette {
  baseline: string;
  futureLow: string;
  futureMid: string;
  futureHigh: string;
  pastLow: string;
  pastMid: string;
  pastHigh: string;
  playedOverlay: string;
  playhead: string;
  outline: string;
}

const WAVE_BLOCK_PX_TARGET = 1.7;
const WAVE_HEIGHT_FILL_RATIO = 0.8;
const REDUCED_BAND_CACHE_MAX_WIDTHS = 6;

const DEFAULT_PALETTE: WavePalette = {
  baseline: 'rgba(0, 0, 0, 0.10)',
  futureLow: '#59486f',
  futureMid: '#716aa9',
  futureHigh: '#af9bd3',
  pastLow: 'rgba(80, 80, 80, 0.55)',
  pastMid: 'rgba(110, 110, 110, 0.50)',
  pastHigh: 'rgba(140, 140, 140, 0.45)',
  playedOverlay: 'rgba(200, 200, 205, 0.12)',
  playhead: 'rgba(30, 33, 40, 0.95)',
  outline: 'rgba(0, 0, 0, 0.22)'
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function getWaveArrays(waveform: WaveformBands): WaveArrays {
  const low = Array.isArray(waveform.peaksLow) ? waveform.peaksLow : [];
  const mid = Array.isArray(waveform.peaksMid) ? waveform.peaksMid : [];
  const high = Array.isArray(waveform.peaksHigh) ? waveform.peaksHigh : [];

  if (low.length && mid.length && high.length) {
    return { low, mid, high };
  }

  const fallback = low.length ? low : mid.length ? mid : high;
  return {
    low: fallback,
    mid: fallback,
    high: fallback
  };
}

function reduceRms(values: number[], groupSize: number): number[] {
  if (!values.length) {
    return [];
  }

  const out: number[] = [];
  for (let start = 0; start < values.length; start += groupSize) {
    const end = Math.min(values.length, start + groupSize);
    let sumSq = 0;
    let count = 0;

    for (let index = start; index < end; index += 1) {
      const value = Number(values[index] || 0);
      sumSq += value * value;
      count += 1;
    }

    out.push(Math.sqrt(sumSq / Math.max(1, count)));
  }

  return out;
}

function buildReducedBands(arrays: WaveArrays, width: number): WaveArrays {
  const rawCount = Math.max(arrays.low.length, arrays.mid.length, arrays.high.length);
  if (!rawCount) {
    return { low: [], mid: [], high: [] };
  }

  const blocksTarget = Math.min(rawCount, Math.max(1, Math.floor(width / WAVE_BLOCK_PX_TARGET)));
  const groupSize = Math.max(1, Math.round(rawCount / blocksTarget));

  // No post-smoothing: a moving average rounds sharp bass cuts into gradient ramps. The
  // bucket steps are kept as-is so a one-beat transition reads as a crisp edge.
  return {
    low: reduceRms(arrays.low, groupSize),
    mid: reduceRms(arrays.mid, groupSize),
    high: reduceRms(arrays.high, groupSize)
  };
}

const reducedBandsCache = new WeakMap<WaveformBands, Map<number, WaveArrays>>();

// Palette is derived from CSS custom properties that only change on theme toggle (rare).
// Cache per root element with a short TTL to avoid getComputedStyle on every RAF frame.
const PALETTE_CACHE_TTL_MS = 1_500;
let cachedPaletteRoot: Element | null = null;
let cachedPalette: WavePalette | null = null;
let cachedPaletteAt = 0;

function getCachedReducedBands(waveform: WaveformBands, width: number): WaveArrays {
  const safeWidth = Math.max(1, Math.floor(width));
  let byWidth = reducedBandsCache.get(waveform);
  if (!byWidth) {
    byWidth = new Map<number, WaveArrays>();
    reducedBandsCache.set(waveform, byWidth);
  }

  const cached = byWidth.get(safeWidth);
  if (cached) {
    return cached;
  }

  const built = buildReducedBands(getWaveArrays(waveform), safeWidth);
  byWidth.set(safeWidth, built);
  if (byWidth.size > REDUCED_BAND_CACHE_MAX_WIDTHS) {
    const oldestKey = byWidth.keys().next().value;
    if (typeof oldestKey === 'number') {
      byWidth.delete(oldestKey);
    }
  }
  return built;
}

function readCssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value || fallback;
}

export function resolvePalette(canvas: HTMLCanvasElement): WavePalette {
  const themedRoot = canvas.closest('.bc-panel-root') as HTMLElement | null;
  const cacheRoot = themedRoot || canvas;
  const now = Date.now();

  if (cachedPaletteRoot === cacheRoot && cachedPalette && (now - cachedPaletteAt) < PALETTE_CACHE_TTL_MS) {
    return cachedPalette;
  }

  const style = window.getComputedStyle(cacheRoot);
  const palette: WavePalette = {
    baseline: readCssVar(style, '--wave-baseline', DEFAULT_PALETTE.baseline),
    futureLow: readCssVar(style, '--wave-future-low', DEFAULT_PALETTE.futureLow),
    futureMid: readCssVar(style, '--wave-future-mid', DEFAULT_PALETTE.futureMid),
    futureHigh: readCssVar(style, '--wave-future-high', DEFAULT_PALETTE.futureHigh),
    pastLow: readCssVar(style, '--wave-past-low', DEFAULT_PALETTE.pastLow),
    pastMid: readCssVar(style, '--wave-past-mid', DEFAULT_PALETTE.pastMid),
    pastHigh: readCssVar(style, '--wave-past-high', DEFAULT_PALETTE.pastHigh),
    playedOverlay: readCssVar(style, '--wave-played-overlay', DEFAULT_PALETTE.playedOverlay),
    playhead: readCssVar(style, '--wave-playhead', DEFAULT_PALETTE.playhead),
    outline: readCssVar(style, '--wave-outline', DEFAULT_PALETTE.outline)
  };

  cachedPaletteRoot = cacheRoot;
  cachedPalette = palette;
  cachedPaletteAt = now;
  return palette;
}

function drawBandArea(params: {
  context: CanvasRenderingContext2D;
  xForIndex: (index: number) => number;
  upper: number[];
  lower: number[] | null;
  lowerConst: number | null;
  fill: string;
}): void {
  const { context, xForIndex, upper, lower, lowerConst, fill } = params;
  const count = upper.length;
  if (!count) {
    return;
  }

  context.beginPath();
  context.moveTo(xForIndex(0), lower ? lower[0] : Number(lowerConst || 0));

  for (let index = 1; index < count; index += 1) {
    context.lineTo(xForIndex(index), lower ? lower[index] : Number(lowerConst || 0));
  }

  for (let index = count - 1; index >= 0; index -= 1) {
    context.lineTo(xForIndex(index), upper[index]);
  }

  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

export function hasRenderableWaveform(waveform: WaveformBands | null | undefined): waveform is WaveformBands {
  if (!waveform) {
    return false;
  }

  return Array.isArray(waveform.peaksLow)
    && Array.isArray(waveform.peaksMid)
    && Array.isArray(waveform.peaksHigh)
    && waveform.buckets > 0;
}

interface BandGeometry {
  count: number;
  baseline: number;
  topLow: number[];
  topMid: number[];
  topHigh: number[];
  xForIndex: (index: number) => number;
}

// The per-bucket band heights are static for a given waveform + width, so they are
// computed once when the layers are (re)built rather than every animation frame.
function computeBandGeometry(
  waveform: WaveformBands,
  width: number,
  height: number
): BandGeometry | null {
  const arrays = getCachedReducedBands(waveform, width);
  const count = Math.max(arrays.low.length, arrays.mid.length, arrays.high.length);
  if (!count) {
    return null;
  }

  const baseline = height - 0.5;
  const maxAmplitude = Math.max(1, (height - 3) * WAVE_HEIGHT_FILL_RATIO);
  const xForIndex = (index: number): number => (count <= 1 ? 0 : (index / (count - 1)) * (width - 1));

  const topLow: number[] = new Array(count);
  const topMid: number[] = new Array(count);
  const topHigh: number[] = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const low = clamp01(Number(arrays.low[index] || 0));
    const mid = clamp01(Number(arrays.mid[index] || 0));
    const high = clamp01(Number(arrays.high[index] || 0));
    const sum = low + mid + high;

    if (!(sum > 0)) {
      topLow[index] = baseline;
      topMid[index] = baseline;
      topHigh[index] = baseline;
      continue;
    }

    const total = Math.min(1, sum);
    const amplitude = total * maxAmplitude;
    const lowHeight = (low / sum) * amplitude;
    const midHeight = (mid / sum) * amplitude;
    const highHeight = Math.max(0, amplitude - lowHeight - midHeight);

    topLow[index] = baseline - lowHeight;
    topMid[index] = topLow[index] - midHeight;
    topHigh[index] = topMid[index] - highHeight;
  }

  return { count, baseline, topLow, topMid, topHigh, xForIndex };
}

// Draw one full-width coloured copy of the waveform (baseline + 3 stacked bands +
// outline). This is the expensive ~O(buckets) path tracing; it runs once per layer
// at build time instead of per frame.
function renderRegionTo(
  context: CanvasRenderingContext2D,
  width: number,
  geom: BandGeometry,
  palette: WavePalette,
  region: { low: string; mid: string; high: string }
): void {
  const { count, baseline, topLow, topMid, topHigh, xForIndex } = geom;

  context.strokeStyle = palette.baseline;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, baseline);
  context.lineTo(width, baseline);
  context.stroke();

  drawBandArea({ context, xForIndex, upper: topLow, lower: null, lowerConst: baseline, fill: region.low });
  drawBandArea({ context, xForIndex, upper: topMid, lower: topLow, lowerConst: null, fill: region.mid });
  drawBandArea({ context, xForIndex, upper: topHigh, lower: topMid, lowerConst: null, fill: region.high });

  context.save();
  context.strokeStyle = palette.outline;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(xForIndex(0), topHigh[0]);
  for (let index = 1; index < count; index += 1) {
    context.lineTo(xForIndex(index), topHigh[index]);
  }
  context.stroke();
  context.restore();
}

export interface WaveformLayers {
  /** Full-width played/greyed copy. */
  past: HTMLCanvasElement;
  /** Full-width unplayed/coloured copy. */
  future: HTMLCanvasElement;
  cssWidth: number;
  cssHeight: number;
  playedOverlay: string;
  playheadColor: string;
}

function createLayerCanvas(
  cssWidth: number,
  cssHeight: number,
  dpr: number
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, context };
}

// Pre-render the static waveform once into two full-width layers — a "future"
// (unplayed, coloured) layer and a "past" (played, greyed) layer. Per frame the
// playhead only moves the boundary between them, so compositeWaveformFrame can
// blit these two images instead of re-tracing ~2.6k canvas paths every frame.
// Output is pixel-identical to the previous per-frame full redraw.
export function buildWaveformLayers(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  waveform: WaveformBands,
  palette: WavePalette
): WaveformLayers | null {
  const geom = computeBandGeometry(waveform, cssWidth, cssHeight);
  if (!geom) {
    return null;
  }

  const future = createLayerCanvas(cssWidth, cssHeight, dpr);
  const past = createLayerCanvas(cssWidth, cssHeight, dpr);
  if (!future || !past) {
    return null;
  }

  renderRegionTo(future.context, cssWidth, geom, palette, {
    low: palette.futureLow,
    mid: palette.futureMid,
    high: palette.futureHigh
  });
  renderRegionTo(past.context, cssWidth, geom, palette, {
    low: palette.pastLow,
    mid: palette.pastMid,
    high: palette.pastHigh
  });

  return {
    past: past.canvas,
    future: future.canvas,
    cssWidth,
    cssHeight,
    playedOverlay: palette.playedOverlay,
    playheadColor: palette.playhead
  };
}

// Cheap per-frame paint: clear, blit the two cached layers split at the playhead,
// and stroke the playhead. ~3 ops/frame vs ~2.6k path ops in the old drawWaveformCanvas.
export function compositeWaveformFrame(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  layers: WaveformLayers,
  playheadFraction: number
): void {
  context.clearRect(0, 0, width, height);

  const hasPlayhead = Number.isFinite(playheadFraction);
  const playX = hasPlayhead ? clamp(playheadFraction, 0, 1) * (width - 1) : 0;

  if (!hasPlayhead || playX <= 0.001) {
    context.drawImage(layers.future, 0, 0, width, height);
  } else if (playX >= width - 0.001) {
    context.drawImage(layers.past, 0, 0, width, height);
  } else {
    context.save();
    context.beginPath();
    context.rect(0, 0, playX, height);
    context.clip();
    context.drawImage(layers.past, 0, 0, width, height);
    // Played-area tint, applied only mid-track to match the original draw exactly.
    context.fillStyle = layers.playedOverlay;
    context.fillRect(0, 0, playX, height);
    context.restore();

    context.save();
    context.beginPath();
    context.rect(playX, 0, width - playX, height);
    context.clip();
    context.drawImage(layers.future, 0, 0, width, height);
    context.restore();
  }

  if (!hasPlayhead) {
    return;
  }

  context.strokeStyle = layers.playheadColor;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(playX, 0);
  context.lineTo(playX, height);
  context.stroke();
}

export function paletteSignature(palette: WavePalette): string {
  return [
    palette.baseline,
    palette.futureLow,
    palette.futureMid,
    palette.futureHigh,
    palette.pastLow,
    palette.pastMid,
    palette.pastHigh,
    palette.playedOverlay,
    palette.playhead,
    palette.outline
  ].join('|');
}

export function setupCanvasForDevicePixelRatio(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number
): CanvasRenderingContext2D | null {
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}
