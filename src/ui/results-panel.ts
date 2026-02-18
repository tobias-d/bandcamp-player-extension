type WaveformData = {
  peaksLow?: number[];
  peaksMid?: number[];
  peaksHigh?: number[];
  peaks?: number[];
  duration?: number;
};

type PanelInput = {
  title?: string;
  artistName?: string;
  trackTitle?: string;
  bpm?: number;
  tempoScale?: number;
  confidence?: number;
  note?: string;
  waveform?: WaveformData | null;
  waveformStatus?: string;
  isAnalyzing?: boolean;
  isPlaying?: boolean;
  playheadFraction?: number;
  currentTimeSec?: number;
  durationSec?: number;
};

type PanelHandlers = {
  onTogglePlayPause?: (() => void) | null;
  onPrevTrack?: (() => void) | null;
  onNextTrack?: (() => void) | null;
  onSeekToFraction?: ((fraction: number) => void) | null;
};

const EMPTY_HANDLERS: PanelHandlers = {
  onTogglePlayPause: null,
  onPrevTrack: null,
  onNextTrack: null,
  onSeekToFraction: null,
};

let containerEl: HTMLDivElement | null = null;
let dragHandleEl: HTMLDivElement | null = null;
let artistEl: HTMLDivElement | null = null;
let trackTitleEl: HTMLDivElement | null = null;
let waveformWrapEl: HTMLDivElement | null = null;
let waveformCanvasEl: HTMLCanvasElement | null = null;
let waveformHintEl: HTMLDivElement | null = null;
let waveformHintTextEl: HTMLSpanElement | null = null;
let waveformHintDotsEl: HTMLSpanElement | null = null;
let transportRowEl: HTMLDivElement | null = null;
let playBtnEl: HTMLButtonElement | null = null;
let prevTrackBtnEl: HTMLButtonElement | null = null;
let timeBtnEl: HTMLButtonElement | null = null;
let nextTrackBtnEl: HTMLButtonElement | null = null;
let closeBtnEl: HTMLButtonElement | null = null;
let bpmMainEl: HTMLDivElement | null = null;
let bpmConfLabelEl: HTMLDivElement | null = null;
let tapBpmEl: HTMLDivElement | null = null;
let tapBtnEl: HTMLButtonElement | null = null;
let tapHintLine1El: HTMLDivElement | null = null;
let tapHintLine2El: HTMLDivElement | null = null;
let tapHintLine3El: HTMLDivElement | null = null;
let noteEl: HTMLDivElement | null = null;

let currentHandlers: PanelHandlers = { ...EMPTY_HANDLERS };

let currentIsPlaying = false;
let currentPlayheadFraction = NaN;
let currentTimeSec = NaN;
let currentDurationSec = NaN;
let showRemainingTime = false;
let currentWaveform: WaveformData | null = null;
let currentWaveformStatus = '';
let currentIsAnalyzing = false;
let tapTimesMs: number[] = [];
let tapBpm = NaN;
let tapLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let tapLongPressed = false;

const PANEL_ID = 'bc-bpm-panel';
const PANEL_UI_VERSION = 'alt-v34-edge-resize';
const PLAYED_BLUE = '#5aa7ff';
const TAP_LONG_PRESS_MS = 2000;
const CLOSED_FLAG = '__BC_BPM_PANEL_CLOSED__';
const POS_KEY = '__BC_BPM_PANEL_POS__';
const SCALE_KEY = '__BC_BPM_PANEL_SCALE__';
const PANEL_PREFS_STORAGE_KEY = '__BC_BPM_PANEL_PREFS__';
const PANEL_MIN_SCALE = 0.6;
const PANEL_MAX_SCALE = 1;
const PANEL_DEFAULT_SCALE = 0.8;
let panelScale = PANEL_MAX_SCALE;
let savedPosMem: { left: number; top: number } | null = null;
let savedScaleMem = PANEL_DEFAULT_SCALE;
let prefsLoaded = false;
let prefsLoadPromise: Promise<void> | null = null;
let panelPrefsTouched = false;

const win = window as unknown as Record<string, unknown>;
seedPanelPrefsFromLegacy();

function isPanelClosed(): boolean {
  try {
    return Boolean(win[CLOSED_FLAG]);
  } catch (_) {
    return false;
  }
}

function setPanelClosed(v: boolean): void {
  try {
    win[CLOSED_FLAG] = Boolean(v);
  } catch (_) {}
}

function readLegacyPos(): { left: number; top: number } | null {
  try {
    const raw = sessionStorage.getItem(POS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Number.isFinite(obj.left) || !Number.isFinite(obj.top)) return null;
    return { left: obj.left, top: obj.top };
  } catch (_) {
    return null;
  }
}

function readLegacyScale(): number {
  try {
    const fromLocal = localStorage.getItem(SCALE_KEY);
    const fromSession = sessionStorage.getItem(SCALE_KEY);
    const rawStr = fromLocal != null ? fromLocal : fromSession;
    if (rawStr == null) return PANEL_DEFAULT_SCALE;
    const raw = Number(rawStr);
    if (!Number.isFinite(raw)) return PANEL_DEFAULT_SCALE;
    return clamp(raw, PANEL_MIN_SCALE, PANEL_MAX_SCALE);
  } catch (_) {
    return PANEL_DEFAULT_SCALE;
  }
}

function seedPanelPrefsFromLegacy(): void {
  savedPosMem = readLegacyPos();
  savedScaleMem = readLegacyScale();
}

function getExtensionStorageArea(): any | null {
  try {
    const g = globalThis as any;
    if (g?.chrome?.storage?.local) return g.chrome.storage.local;
    if (g?.browser?.storage?.local) return g.browser.storage.local;
    if (g?.chrome?.storage?.sync) return g.chrome.storage.sync;
    if (g?.browser?.storage?.sync) return g.browser.storage.sync;
  } catch (_) {
    // Ignore.
  }
  return null;
}

function storageGetPanelPrefs(): Promise<any | null> {
  const area = getExtensionStorageArea();
  if (!area) return Promise.resolve(null);

  try {
    const maybePromise = area.get(PANEL_PREFS_STORAGE_KEY);
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise
        .then((res: any) => res?.[PANEL_PREFS_STORAGE_KEY] ?? null)
        .catch(() => null);
    }
  } catch (_) {
    // Fallback to callback API.
  }

  return new Promise((resolve) => {
    try {
      area.get(PANEL_PREFS_STORAGE_KEY, (res: any) => {
        resolve(res?.[PANEL_PREFS_STORAGE_KEY] ?? null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function storageSetPanelPrefs(value: any): Promise<void> {
  const area = getExtensionStorageArea();
  if (!area) return Promise.resolve();

  try {
    const maybePromise = area.set({ [PANEL_PREFS_STORAGE_KEY]: value });
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.then(() => undefined).catch(() => undefined);
    }
  } catch (_) {
    // Fallback to callback API.
  }

  return new Promise((resolve) => {
    try {
      area.set({ [PANEL_PREFS_STORAGE_KEY]: value }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function normalizeSavedPos(input: any): { left: number; top: number } | null {
  const left = Number(input?.left);
  const top = Number(input?.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
  return { left, top };
}

function normalizeSavedScale(input: any): number {
  const raw = Number(input);
  if (!Number.isFinite(raw)) return PANEL_DEFAULT_SCALE;
  return clamp(raw, PANEL_MIN_SCALE, PANEL_MAX_SCALE);
}

function persistPanelPrefs(): void {
  const payload = {
    pos: savedPosMem ? { left: savedPosMem.left, top: savedPosMem.top } : null,
    scale: savedScaleMem,
  };
  void storageSetPanelPrefs(payload);
}

function applySavedPosToPanel(): void {
  if (!containerEl) return;
  const pos = getSavedPos();
  if (!pos) return;

  const r = containerEl.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const left = clamp(pos.left, 0, Math.max(0, vw - r.width));
  const top = clamp(pos.top, 0, Math.max(0, vh - r.height));
  containerEl.style.left = `${Math.round(left)}px`;
  containerEl.style.top = `${Math.round(top)}px`;
  containerEl.style.right = 'auto';
  containerEl.style.bottom = 'auto';
}

function applyStoredPrefsToPanel(): void {
  if (!containerEl) return;
  applyPanelScale(getSavedScale());
  applySavedPosToPanel();
}

function ensurePanelPrefsLoaded(): void {
  if (prefsLoaded || prefsLoadPromise) return;

  prefsLoadPromise = (async () => {
    let hadStoredPrefs = false;
    try {
      const stored = await storageGetPanelPrefs();
      if (stored && typeof stored === 'object') {
        hadStoredPrefs = true;
        const pos = normalizeSavedPos((stored as any).pos);
        const scale = normalizeSavedScale((stored as any).scale);
        if (pos) savedPosMem = pos;
        savedScaleMem = scale;
      }
    } catch (_) {
      // Ignore storage read errors.
    } finally {
      prefsLoaded = true;
      prefsLoadPromise = null;
    }

    if (!hadStoredPrefs) {
      persistPanelPrefs();
    }

    if (containerEl && !panelPrefsTouched) {
      applyStoredPrefsToPanel();
      drawWaveform(currentWaveform, currentWaveformStatus, currentPlayheadFraction, currentIsAnalyzing);
    }
  })();
}

function getSavedPos(): { left: number; top: number } | null {
  return savedPosMem ? { left: savedPosMem.left, top: savedPosMem.top } : null;
}

function savePos(left: number, top: number): void {
  savedPosMem = { left, top };
  panelPrefsTouched = true;
  persistPanelPrefs();
}

function getSavedScale(): number {
  return normalizeSavedScale(savedScaleMem);
}

function saveScale(scale: number): void {
  savedScaleMem = normalizeSavedScale(scale);
  panelPrefsTouched = true;
  persistPanelPrefs();
}

function applyPanelScale(scale: number): void {
  panelScale = clamp(scale, PANEL_MIN_SCALE, PANEL_MAX_SCALE);
  if (!containerEl) return;
  containerEl.style.setProperty('--panel-scale', String(panelScale));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function pad2(n: number): string {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  return String(x).padStart(2, '0');
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${pad2(r)}`;
}

function confLevelLabel(x: number): string {
  if (!Number.isFinite(x)) return 'Confidence: Unknown';
  if (x >= 25) return 'Confidence: High';
  if (x >= 10) return 'Confidence: Medium';
  return 'Confidence: Low';
}

function confLevelClass(x: number): string {
  if (!Number.isFinite(x)) return 'level-unknown';
  if (x >= 25) return 'level-high';
  if (x >= 10) return 'level-medium';
  return 'level-low';
}

function confLevelClassForState(x: number, isAnalyzing: boolean): string {
  if (isAnalyzing) return 'level-unknown';
  return confLevelClass(x);
}

function norm(s?: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function parseArtistTitleFallback(title?: string): { artistName: string; trackTitle: string } {
  const t = norm(title);
  if (!t) return { artistName: '', trackTitle: '' };

  const by = t.match(/^(.+?),\s*by\s+(.+)$/i);
  if (by) return { trackTitle: norm(by[1]), artistName: norm(by[2]) };

  const dash = t.match(/^(.+?)\s*[—–]\s*(.+)$/);
  if (dash) return { artistName: norm(dash[1]), trackTitle: norm(dash[2]) };

  const hy = t.match(/^(.+?)\s+-\s+(.+)$/);
  if (hy) return { artistName: norm(hy[1]), trackTitle: norm(hy[2]) };

  return { artistName: '', trackTitle: '' };
}

function setupCanvasForDpr(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function getWaveArrays(waveform) {
  if (!waveform) return { low: null, mid: null, high: null };

  const low = Array.isArray(waveform.peaksLow) ? waveform.peaksLow : null;
  const mid = Array.isArray(waveform.peaksMid) ? waveform.peaksMid : null;
  const high = Array.isArray(waveform.peaksHigh) ? waveform.peaksHigh : null;

  if (low && mid && high) return { low, mid, high };

  const legacy = Array.isArray(waveform.peaks) ? waveform.peaks : null;
  if (legacy) return { low: legacy, mid: legacy, high: legacy };

  return { low: null, mid: null, high: null };
}

function setWaveHint(statusText, isAnalyzing) {
  if (!waveformHintEl || !waveformHintTextEl || !waveformHintDotsEl) return;
  const txt = String(statusText || '').trim();
  waveformHintTextEl.textContent = txt;
  waveformHintEl.style.display = txt ? 'block' : 'none';
  waveformHintDotsEl.style.display = isAnalyzing ? 'inline-flex' : 'none';
}

function drawWaveform(waveform, statusText, playheadFraction, isAnalyzing) {
  if (!waveformWrapEl || !waveformCanvasEl || !waveformHintEl) return;

  waveformWrapEl.style.display = 'flex';
  setWaveHint(statusText, isAnalyzing);

  const { low, mid, high } = getWaveArrays(waveform);
  const hasAny = (low && low.length) || (mid && mid.length) || (high && high.length);

  const rect = waveformCanvasEl.getBoundingClientRect();
  const W = Math.max(1, Math.floor(rect.width || waveformCanvasEl.clientWidth || 440));
  const H = Math.max(1, Math.floor(rect.height || 58));

  const ctx = setupCanvasForDpr(waveformCanvasEl, W, H);
  ctx.clearRect(0, 0, W, H);

  if (!hasAny) return;

  const baseY = H - 0.5;
  const maxAmp = H - 3;

  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.lineTo(W, baseY);
  ctx.stroke();

  const duration = Number.isFinite(waveform?.duration) ? waveform.duration : NaN;
  const nRaw = Math.max(low?.length || 0, mid?.length || 0, high?.length || 0);

  const blocksTarget =
    Number.isFinite(duration) && duration > 0 ? Math.max(1, Math.ceil(duration / 2)) : Math.min(nRaw, 160);

  const groupSize = Math.max(1, Math.round(nRaw / blocksTarget));

  const reduceRms = (arr) => {
    if (!arr || !arr.length) return null;
    const out = [];
    for (let i = 0; i < arr.length; i += groupSize) {
      let sumSq = 0;
      let c = 0;
      const end = Math.min(arr.length, i + groupSize);
      for (let j = i; j < end; j++) {
        const v = Number(arr[j] || 0);
        sumSq += v * v;
        c++;
      }
      out.push(Math.sqrt(sumSq / Math.max(1, c)));
    }
    return out;
  };

  const smooth3 = (arr) => {
    if (!arr || arr.length < 3) return arr;
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const a = arr[Math.max(0, i - 1)];
      const b = arr[i];
      const c = arr[Math.min(arr.length - 1, i + 1)];
      out[i] = (a + b + c) / 3;
    }
    return out;
  };

  const low2 = smooth3(reduceRms(low));
  const mid2 = smooth3(reduceRms(mid));
  const high2 = smooth3(reduceRms(high));

  const n = Math.max(low2?.length || 0, mid2?.length || 0, high2?.length || 0);
  if (!n) return;

  const step = W / n;

  const drawOutlineBlocks = (alpha) => {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    ctx.globalAlpha = alpha;
    for (let i = 0; i < n; i++) {
      const p = Math.max(Number(low2?.[i] || 0), Number(mid2?.[i] || 0), Number(high2?.[i] || 0));
      const pp = Math.max(0, Math.min(1, p));
      const amp = pp * maxAmp;
      const x0 = Math.floor(i * step);
      const x1 = Math.floor((i + 1) * step);
      const w = Math.max(1, x1 - x0);
      ctx.fillRect(x0, Math.round(baseY - amp), w, Math.max(1, Math.round(amp)));
    }
    ctx.restore();
  };

  const hasPlayhead = Number.isFinite(playheadFraction);
  const f = hasPlayhead ? clamp(playheadFraction, 0, 1) : 0;
  const playX = hasPlayhead ? Math.round(f * (W - 1)) : 0;

  const FUT_LOW = '#59486f';
  const FUT_MID = '#716aa9';
  const FUT_HIGH = '#af9bd3';
  const PAST_LOW = 'rgba(80,80,80,0.55)';
  const PAST_MID = 'rgba(110,110,110,0.50)';
  const PAST_HIGH = 'rgba(140,140,140,0.45)';

  const renderRegion = (palette, outlineAlpha) => {
    ctx.save();
    for (let i = 0; i < n; i++) {
      const pL = Math.max(0, Math.min(1, Number(low2?.[i] || 0)));
      const pM = Math.max(0, Math.min(1, Number(mid2?.[i] || 0)));
      const pH = Math.max(0, Math.min(1, Number(high2?.[i] || 0)));

      const sum = pL + pM + pH;
      if (!(sum > 0)) continue;

      const total = Math.min(1, sum);
      const amp = Math.max(1, Math.round(total * maxAmp));

      const hLow = Math.max(0, Math.round((pL / sum) * amp));
      const hMid = Math.max(0, Math.round((pM / sum) * amp));
      const hHigh = Math.max(0, amp - hLow - hMid);

      const x0 = Math.floor(i * step);
      const x1 = Math.floor((i + 1) * step);
      const w = Math.max(1, x1 - x0);

      let y = baseY;

      if (hLow > 0) {
        ctx.fillStyle = palette.low;
        ctx.fillRect(x0, Math.round(y - hLow), w, hLow);
        y -= hLow;
      }

      if (hMid > 0) {
        ctx.fillStyle = palette.mid;
        ctx.fillRect(x0, Math.round(y - hMid), w, hMid);
        y -= hMid;
      }

      if (hHigh > 0) {
        ctx.fillStyle = palette.high;
        ctx.fillRect(x0, Math.round(y - hHigh), w, hHigh);
      }
    }
    drawOutlineBlocks(outlineAlpha);
    ctx.restore();
  };

  if (!hasPlayhead || playX <= 0) {
    renderRegion({ low: FUT_LOW, mid: FUT_MID, high: FUT_HIGH }, 0.7);
  } else if (playX >= W) {
    renderRegion({ low: PAST_LOW, mid: PAST_MID, high: PAST_HIGH }, 0.65);
  } else {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, playX, H);
    ctx.clip();
    renderRegion({ low: PAST_LOW, mid: PAST_MID, high: PAST_HIGH }, 0.65);
    ctx.fillStyle = 'rgba(200,200,205,0.12)';
    ctx.fillRect(0, 0, playX, H);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(playX, 0, W - playX, H);
    ctx.clip();
    renderRegion({ low: FUT_LOW, mid: FUT_MID, high: FUT_HIGH }, 0.7);
    ctx.restore();
  }

  if (!hasPlayhead) return;

  ctx.save();
  ctx.strokeStyle = PLAYED_BLUE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX + 0.5, 0);
  ctx.lineTo(playX + 0.5, H);
  ctx.stroke();
  ctx.restore();
}

function refreshTransportUI() {
  if (!playBtnEl) return;
  playBtnEl.textContent = currentIsPlaying ? '❚❚' : '▶';
  playBtnEl.setAttribute('aria-label', currentIsPlaying ? 'Pause' : 'Play');
  playBtnEl.title = currentIsPlaying ? 'Pause' : 'Play';

  if (prevTrackBtnEl) {
    const enabled = typeof currentHandlers.onPrevTrack === 'function';
    prevTrackBtnEl.disabled = !enabled;
    prevTrackBtnEl.title = enabled ? 'Previous track' : 'Previous track (unavailable)';
  }

  if (nextTrackBtnEl) {
    const enabled = typeof currentHandlers.onNextTrack === 'function';
    nextTrackBtnEl.disabled = !enabled;
    nextTrackBtnEl.title = enabled ? 'Next track' : 'Next track (unavailable)';
  }

  if (!timeBtnEl) return;

  const dur = Number.isFinite(currentDurationSec)
    ? currentDurationSec
    : Number.isFinite(currentWaveform?.duration)
    ? currentWaveform.duration
    : NaN;

  let elapsed = Number.isFinite(currentTimeSec) ? currentTimeSec : NaN;

  if (!Number.isFinite(elapsed) && Number.isFinite(currentPlayheadFraction) && Number.isFinite(dur)) {
    elapsed = Math.max(0, Math.min(dur, currentPlayheadFraction * dur));
  }

  if (showRemainingTime && Number.isFinite(dur) && Number.isFinite(elapsed)) {
    const remaining = Math.max(0, dur - elapsed);
    timeBtnEl.textContent = `-${fmtTime(remaining)} / ${fmtTime(dur)}`;
    timeBtnEl.title = 'Click to show elapsed time';
  } else {
    timeBtnEl.textContent = `${fmtTime(elapsed)} / ${fmtTime(dur)}`;
    timeBtnEl.title = 'Click to show remaining time';
  }
}

function setTapperHintDefault() {
  if (tapHintLine1El) tapHintLine1El.textContent = 'Tap or click here';
  if (tapHintLine2El) tapHintLine2El.textContent = 'to detect BPM manually';
  if (tapHintLine3El) tapHintLine3El.textContent = 'Hold to reset';
}

function resetTapper() {
  tapTimesMs = [];
  tapBpm = NaN;
  if (tapBpmEl) tapBpmEl.textContent = '---';
  setTapperHintDefault();
}

function computeTapBpmFromTimes(times) {
  if (!Array.isArray(times) || times.length < 2) return NaN;

  const intervals = [];
  for (let i = 1; i < times.length; i++) {
    const dt = times[i] - times[i - 1];
    if (Number.isFinite(dt) && dt > 0) intervals.push(dt);
  }

  if (!intervals.length) return NaN;

  const lastIntervals = intervals.slice(-8);
  const sorted = [...lastIntervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const lo = median * 0.7;
  const hi = median * 1.3;
  const filtered = lastIntervals.filter((x) => x >= lo && x <= hi);
  const use = filtered.length >= 2 ? filtered : lastIntervals;

  const avg = use.reduce((a, b) => a + b, 0) / Math.max(1, use.length);
  const bpm = 60000 / avg;

  return Number.isFinite(bpm) ? bpm : NaN;
}

function handleTap() {
  const now = performance.now();
  const RESET_GAP_MS = 2500;

  if (tapTimesMs.length) {
    const gap = now - tapTimesMs[tapTimesMs.length - 1];
    if (gap > RESET_GAP_MS) tapTimesMs = [];
  }

  tapTimesMs.push(now);
  const bpm = computeTapBpmFromTimes(tapTimesMs);
  tapBpm = bpm;
  if (tapBpmEl) tapBpmEl.textContent = Number.isFinite(bpm) ? String(Math.round(bpm)) : '---';
  setTapperHintDefault();
}

function clearTapLongPressTimer() {
  if (tapLongPressTimer != null) {
    clearTimeout(tapLongPressTimer);
    tapLongPressTimer = null;
  }
}

function ensureWaveformSeeking() {
  if (!waveformCanvasEl) return;
  if (waveformCanvasEl.dataset.seekBound === '1') return;

  waveformCanvasEl.dataset.seekBound = '1';
  waveformCanvasEl.style.cursor = 'pointer';

  const seekFromEvent = (ev) => {
    if (!waveformCanvasEl) return;
    const r = waveformCanvasEl.getBoundingClientRect();
    const x = clamp(ev.clientX - r.left, 0, r.width);
    const frac = r.width > 1 ? x / r.width : 0;
    currentPlayheadFraction = frac;
    drawWaveform(currentWaveform, currentWaveformStatus, currentPlayheadFraction, currentIsAnalyzing);
    if (typeof currentHandlers.onSeekToFraction === 'function') currentHandlers.onSeekToFraction(frac);
  };

  let dragging = false;

  waveformCanvasEl.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    dragging = true;
    try {
      waveformCanvasEl.setPointerCapture(ev.pointerId);
    } catch (_) {}
    seekFromEvent(ev);
  });

  waveformCanvasEl.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    seekFromEvent(ev);
  });

  waveformCanvasEl.addEventListener('pointerup', (ev) => {
    ev.preventDefault();
    dragging = false;
  });

  waveformCanvasEl.addEventListener('pointercancel', () => {
    dragging = false;
  });
}

function ensurePanelDraggable(handleEls) {
  if (!containerEl || containerEl.dataset.dragBound === '1') return;
  containerEl.dataset.dragBound = '1';

  const startDrag = (ev) => {
    if (!containerEl) return;
    if (ev.button != null && ev.button !== 0) return;

    const t = ev.target;
    if (t && t.closest && t.closest('button')) return;

    ev.preventDefault();

    const r0 = containerEl.getBoundingClientRect();
    const offsetX = ev.clientX - r0.left;
    const offsetY = ev.clientY - r0.top;

    containerEl.style.left = `${Math.round(r0.left)}px`;
    containerEl.style.top = `${Math.round(r0.top)}px`;
    containerEl.style.right = 'auto';
    containerEl.style.bottom = 'auto';

    const onMove = (e) => {
      if (!containerEl) return;

      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const r = containerEl.getBoundingClientRect();

      let left = e.clientX - offsetX;
      let top = e.clientY - offsetY;

      left = clamp(left, 0, Math.max(0, vw - r.width));
      top = clamp(top, 0, Math.max(0, vh - r.height));

      containerEl.style.left = `${Math.round(left)}px`;
      containerEl.style.top = `${Math.round(top)}px`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);

      if (!containerEl) return;
      const r = containerEl.getBoundingClientRect();
      savePos(Math.round(r.left), Math.round(r.top));
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  for (const el of handleEls) {
    if (!el) continue;
    el.style.cursor = 'move';
    el.addEventListener('pointerdown', startDrag, true);
  }
}

function ensurePanelResizable() {
  if (!containerEl || containerEl.dataset.resizeBound === '1') return;
  containerEl.dataset.resizeBound = '1';
  const EDGE_PX = 8;

  const getResizeDir = (clientX: number, clientY: number) => {
    if (!containerEl) return '';
    const r = containerEl.getBoundingClientRect();
    const nearLeft = clientX - r.left <= EDGE_PX;
    const nearRight = r.right - clientX <= EDGE_PX;
    const nearTop = clientY - r.top <= EDGE_PX;
    const nearBottom = r.bottom - clientY <= EDGE_PX;
    if (!nearLeft && !nearRight && !nearTop && !nearBottom) return '';
    const v = nearTop ? 'n' : nearBottom ? 's' : '';
    const h = nearLeft ? 'w' : nearRight ? 'e' : '';
    return `${v}${h}`;
  };

  const cursorForDir = (dir: string) => {
    if (!dir) return '';
    if (dir === 'n' || dir === 's') return 'ns-resize';
    if (dir === 'w' || dir === 'e') return 'ew-resize';
    if (dir === 'ne' || dir === 'sw') return 'nesw-resize';
    return 'nwse-resize';
  };

  const startResize = (ev) => {
    if (!containerEl) return;
    if (ev.button != null && ev.button !== 0) return;
    const dir = getResizeDir(ev.clientX, ev.clientY);
    if (!dir) return;
    ev.preventDefault();
    ev.stopPropagation();

    const startRect = containerEl.getBoundingClientRect();
    const startScale = panelScale || PANEL_MAX_SCALE;
    const baseWidth = startRect.width / startScale;
    const baseHeight = startRect.height / startScale;
    const anchorLeft = startRect.left;
    const anchorTop = startRect.top;
    const anchorRight = startRect.right;
    const anchorBottom = startRect.bottom;
    const startX = ev.clientX;
    const startY = ev.clientY;

    const onMove = (e) => {
      if (!containerEl) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const widthPx = dir.includes('w')
        ? startRect.width - dx
        : dir.includes('e')
        ? startRect.width + dx
        : NaN;
      const heightPx = dir.includes('n')
        ? startRect.height - dy
        : dir.includes('s')
        ? startRect.height + dy
        : NaN;
      const targetScaleX = Number.isFinite(widthPx) ? widthPx / Math.max(1, baseWidth) : Infinity;
      const targetScaleY = Number.isFinite(heightPx) ? heightPx / Math.max(1, baseHeight) : Infinity;
      const nextScale = clamp(Math.min(targetScaleX, targetScaleY), PANEL_MIN_SCALE, PANEL_MAX_SCALE);
      applyPanelScale(nextScale);

      const nextWidth = baseWidth * nextScale;
      const nextHeight = baseHeight * nextScale;
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;

      let left = dir.includes('w') ? anchorRight - nextWidth : anchorLeft;
      let top = dir.includes('n') ? anchorBottom - nextHeight : anchorTop;
      left = clamp(left, 0, Math.max(0, vw - nextWidth));
      top = clamp(top, 0, Math.max(0, vh - nextHeight));

      containerEl.style.left = `${Math.round(left)}px`;
      containerEl.style.top = `${Math.round(top)}px`;
      containerEl.style.right = 'auto';
      containerEl.style.bottom = 'auto';
      drawWaveform(currentWaveform, currentWaveformStatus, currentPlayheadFraction, currentIsAnalyzing);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);

      if (!containerEl) return;
      const r = containerEl.getBoundingClientRect();
      savePos(Math.round(r.left), Math.round(r.top));
      saveScale(panelScale);
      drawWaveform(currentWaveform, currentWaveformStatus, currentPlayheadFraction, currentIsAnalyzing);
    };

    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  };

  const onHoverMove = (ev: PointerEvent) => {
    if (!containerEl) return;
    containerEl.style.cursor = cursorForDir(getResizeDir(ev.clientX, ev.clientY));
  };

  const onLeave = () => {
    if (!containerEl) return;
    containerEl.style.cursor = '';
  };

  containerEl.addEventListener('pointermove', onHoverMove, true);
  containerEl.addEventListener('pointerleave', onLeave, true);
  containerEl.addEventListener('pointerdown', startResize, true);
}

function closePanel() {
  setPanelClosed(true);
  if (containerEl && containerEl.remove) containerEl.remove();

  containerEl = null;
  dragHandleEl = null;
  artistEl = null;
  trackTitleEl = null;
  waveformWrapEl = null;
  waveformCanvasEl = null;
  waveformHintEl = null;
  waveformHintTextEl = null;
  waveformHintDotsEl = null;
  transportRowEl = null;
  playBtnEl = null;
  prevTrackBtnEl = null;
  timeBtnEl = null;
  nextTrackBtnEl = null;
  closeBtnEl = null;
  bpmMainEl = null;
  bpmConfLabelEl = null;
  tapBpmEl = null;
  tapBtnEl = null;
  tapHintLine1El = null;
  tapHintLine2El = null;
  tapHintLine3El = null;
  noteEl = null;

  clearTapLongPressTimer();
  tapLongPressed = false;
}

function bindRefsFromContainer() {
  if (!containerEl) return;
  const byRole = <T extends Element>(role: string) =>
    containerEl?.querySelector(`[data-role="${role}"]`) as T | null;

  dragHandleEl = byRole<HTMLDivElement>('dragHandle');
  artistEl = byRole<HTMLDivElement>('artist');
  trackTitleEl = byRole<HTMLDivElement>('trackTitle');
  waveformWrapEl = byRole<HTMLDivElement>('waveWrap');
  waveformCanvasEl = byRole<HTMLCanvasElement>('waveCanvas');
  waveformHintEl = byRole<HTMLDivElement>('waveHint');
  waveformHintTextEl = byRole<HTMLSpanElement>('waveHintText');
  waveformHintDotsEl = byRole<HTMLSpanElement>('waveHintDots');
  transportRowEl = byRole<HTMLDivElement>('transportRow');
  playBtnEl = byRole<HTMLButtonElement>('playPause');
  prevTrackBtnEl = byRole<HTMLButtonElement>('prevTrack');
  timeBtnEl = byRole<HTMLButtonElement>('timeBox');
  nextTrackBtnEl = byRole<HTMLButtonElement>('nextTrack');
  closeBtnEl = byRole<HTMLButtonElement>('closeX');
  bpmMainEl = byRole<HTMLDivElement>('bpmMain');
  bpmConfLabelEl = byRole<HTMLDivElement>('bpmConfLabel');
  tapBpmEl = byRole<HTMLDivElement>('tapBpm');
  tapBtnEl = byRole<HTMLButtonElement>('tapBtn');
  tapHintLine1El = byRole<HTMLDivElement>('tapHintLine1');
  tapHintLine2El = byRole<HTMLDivElement>('tapHintLine2');
  tapHintLine3El = byRole<HTMLDivElement>('tapHintLine3');
  noteEl = byRole<HTMLDivElement>('note');
}

function ensurePanel() {
  if (isPanelClosed()) return null;
  ensurePanelPrefsLoaded();

  if (containerEl && document.contains(containerEl)) return containerEl;

  containerEl = document.getElementById(PANEL_ID) as HTMLDivElement | null;
  if (containerEl && document.contains(containerEl)) {
    const ver = containerEl.getAttribute('data-ui-version');
    if (ver === PANEL_UI_VERSION) {
      bindRefsFromContainer();
      ensurePanelDraggable([
        containerEl?.querySelector('[data-role="topRow"]') as HTMLDivElement | null,
      ]);
      ensurePanelResizable();
      applyStoredPrefsToPanel();
      ensureWaveformSeeking();
      return containerEl;
    }
    containerEl.remove();
    containerEl = null;
  }

  containerEl = document.createElement('div');
  containerEl.id = PANEL_ID;
  containerEl.setAttribute('data-ui-version', PANEL_UI_VERSION);

  const STYLE_ID = `${PANEL_ID}-style`;
  const oldStyle = document.getElementById(STYLE_ID);
  if (oldStyle) oldStyle.remove();

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = `
#${PANEL_ID}{
position:fixed;
right:16px;
bottom:16px;
z-index:2147483647;
width:460px;
--panel-scale:1;
transform-origin:top left;
transform:scale(var(--panel-scale));
font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
background:rgba(235,235,235,0.62);
color:#111;
border:1px solid rgba(0,0,0,0.14);
border-radius:12px;
padding:12px;
box-shadow:0 10px 26px rgba(0,0,0,0.18);
backdrop-filter:blur(10px);
}

#${PANEL_ID} .inner{ position:relative; }

#${PANEL_ID} .dragHandle{
display:none;
}

#${PANEL_ID} .dragHandle .dragLine{
width:50px;
height:3px;
border-radius:999px;
background:rgba(0,0,0,0.30);
}

#${PANEL_ID} .dragHandle:hover .dragLine{
background:rgba(0,0,0,0.40);
}

/* macOS close button */
#${PANEL_ID} .closeX{
position:absolute;
top:4px;
right:4px;
width:16px;
height:16px;
display:flex;
align-items:center;
justify-content:center;
padding:0;
border-radius:6px;
font-size:12px;
line-height:1;
font-weight:500;
background:transparent;
border:none;
user-select:none;
cursor:pointer;
color:rgba(0,0,0,0.45);
transition:background 0.15s ease, color 0.15s ease;
overflow:hidden;
z-index:10;
}

#${PANEL_ID} .closeX::before{
content:'×';
font-size:12px;
color:currentColor;
}

#${PANEL_ID} .closeX:hover{
background:rgba(0,0,0,0.08);
color:rgba(0,0,0,0.72);
}

#${PANEL_ID} .closeX:active{
background:rgba(0,0,0,0.14);
color:rgba(0,0,0,0.82);
}

#${PANEL_ID} .topRow{
display:flex;
justify-content:flex-start;
align-items:center;
margin-bottom:6px;
min-height:32px;
padding-right:24px;
cursor:move;
user-select:none;
touch-action:none;
}

#${PANEL_ID} .artist{
flex:1 1 auto;
min-width:0;
font-size:16px;
font-weight:750;
line-height:32px;
opacity:0.85;
white-space:nowrap;
overflow:hidden;
text-overflow:ellipsis;
}

#${PANEL_ID} .title{
font-size:16px;
font-weight:750;
margin:10px 0 14px 0;
opacity:0.95;
white-space:nowrap;
overflow:hidden;
text-overflow:ellipsis;
line-height:1.15;
}

/* FIXED HEIGHT: Waveform wrapper */
#${PANEL_ID} .waveWrap{
margin:2px 0 0 0;
padding:6px 8px 2px 8px;
border-radius:10px;
background:rgba(255,255,255,0.26);
border:1px solid rgba(0,0,0,0.10);
min-height:80px;
display:flex;
flex-direction:column;
justify-content:flex-end;
}

#${PANEL_ID} canvas.wave{
display:block;
width:100%;
height:58px;
order:2;
}

#${PANEL_ID} .waveHint{
margin-bottom:6px;
order:1;
font-size:11px;
opacity:0.78;
display:none;
user-select:none;
}

#${PANEL_ID} .waveHint .dots{
display:none;
margin-left:6px;
gap:2px;
align-items:center;
}

#${PANEL_ID} .waveHint .dots span{
width:4px;
height:4px;
border-radius:999px;
background:rgba(0,0,0,0.55);
opacity:0.25;
animation: bcDots 1.0s infinite;
}

#${PANEL_ID} .waveHint .dots span:nth-child(2){ animation-delay:0.15s; }
#${PANEL_ID} .waveHint .dots span:nth-child(3){ animation-delay:0.30s; }

@keyframes bcDots{
0%{ opacity:0.20; transform: translateY(0px); }
50%{ opacity:0.90; transform: translateY(-1px); }
100%{ opacity:0.20; transform: translateY(0px); }
}

#${PANEL_ID} .transportRow{
display:flex;
align-items:center;
justify-content:flex-start;
gap:8px;
margin-top:10px;
}

#${PANEL_ID} .lower{
margin-top:10px;
display:grid;
grid-template-columns: 1fr;
gap:10px;
}

/* FIXED HEIGHT: Card */
#${PANEL_ID} .card{
border-radius:14px;
background:rgba(255,255,255,0.22);
border:1px solid rgba(0,0,0,0.10);
padding:10px;
min-height:156px;
}

/* Layout: EQUAL columns (50/50) with centered divider */
#${PANEL_ID} .bpmBox{
display:grid;
grid-template-columns: 1fr 1fr;
gap:0;
align-items:stretch;
position:relative;
}

/* Centered vertical divider - FIXED for true vertical centering */
#${PANEL_ID} .bpmBox::after{
content:'';
position:absolute;
left:50%;
top:8px;
bottom:8px;
transform:translateX(-50%);
width:2px;
border-radius:999px;
background:rgba(120,120,120,0.50);
z-index:1;
}

/* FIXED HEIGHT: BPM values container */
#${PANEL_ID} .bpmValues{
display:flex;
flex-direction:column;
gap:16px;
min-height:136px;
padding:14px 16px 0 10px;
}

/* FIXED HEIGHT: BPM column */
#${PANEL_ID} .bpmColumn{
display:flex;
flex-direction:column;
gap:8px;
min-width:0;
min-height:60px;
}

/* FIXED HEIGHT: Label line */
#${PANEL_ID} .labelLine{
display:flex;
align-items:baseline;
gap:6px;
min-height:22px;
height:22px;
white-space:nowrap;
}

#${PANEL_ID} .label{
font-size:11px;
letter-spacing:0.02em;
opacity:0.78;
margin:0;
white-space:nowrap;
}

#${PANEL_ID} .confLabel{
opacity:1;
margin:0;
display:inline-flex;
align-items:center;
justify-content:center;
width:7px;
height:7px;
flex:0 0 auto;
margin-left:8px;
}

#${PANEL_ID} .confLabel::before{
content:'';
width:7px;
height:7px;
border-radius:50%;
background:#98a2b3;
flex:0 0 auto;
box-shadow:0 0 0 1px rgba(0,0,0,0.10) inset;
}

#${PANEL_ID} .confLabel.level-low{
filter:saturate(1.05);
}

#${PANEL_ID} .confLabel.level-low::before{
background:#f04438;
}

#${PANEL_ID} .confLabel.level-medium{
filter:saturate(1.05);
}

#${PANEL_ID} .confLabel.level-medium::before{
background:#f79009;
}

#${PANEL_ID} .confLabel.level-high{
filter:saturate(1.05);
}

#${PANEL_ID} .confLabel.level-high::before{
background:#12b76a;
}

/* FIXED HEIGHT: Value */
#${PANEL_ID} .value{
font-size:26px;
font-weight:750;
line-height:1.05;
color:#111;
min-height:28px;
}

#${PANEL_ID} .value.mono{ font-variant-numeric:tabular-nums; }

/* BPM value pulsing animation during analysis */
#${PANEL_ID} .value.analyzing{
animation:bpmPulsing 1.5s ease-in-out infinite;
}

@keyframes bpmPulsing{
0%, 100%{ opacity:0.4; }
50%{ opacity:1; }
}

/* Tapper button - SEAMLESS, entire right column clickable, NO HOVER EFFECT */
#${PANEL_ID} .tapperButton{
width:100%;
height:100%;
min-height:120px;
border-radius:0;
display:flex;
align-items:center;
justify-content:center;
padding:18px;
margin:0;
user-select:none;
touch-action: manipulation;
box-sizing:border-box;
background:transparent;
border:none;
color:#111;
cursor:pointer;
transition:none;
position:relative;
z-index:0;
}

#${PANEL_ID} .tapperButton:hover{
background:transparent;
}

#${PANEL_ID} .tapperButton:active{
background:rgba(0,0,0,0.08);
}

#${PANEL_ID} .tapperButton:focus{ outline:none; }

#${PANEL_ID} .tapperButton:focus-visible{
outline:2px solid rgba(0,0,0,0.22);
outline-offset:2px;
}

#${PANEL_ID} .tapperButton .tapHint{
display:flex;
flex-direction:column;
align-items:center;
justify-content:center;
gap:3px;
text-align:center;
font-size:13px;
font-weight:400;
line-height:1.2;
}

#${PANEL_ID} .tapperButton .tapLine1{
font-size:13px;
font-weight:400;
opacity:0.82;
line-height:1.2;
}

#${PANEL_ID} .tapperButton .tapLine2{
font-size:13px;
font-weight:400;
opacity:0.82;
line-height:1.2;
}

#${PANEL_ID} .tapperButton .tapLine3{
font-size:13px;
font-weight:400;
opacity:0.72;
line-height:1.2;
}

#${PANEL_ID} button{
appearance:none;
border:1px solid rgba(0,0,0,0.16);
background:rgba(255,255,255,0.28);
color:#111;
padding:6px 10px;
border-radius:10px;
font-size:12px;
cursor:pointer;
text-decoration:none;
}

#${PANEL_ID} button:hover{
background:rgba(0,0,0,0.08);
border-color:rgba(0,0,0,0.24);
text-decoration:none;
}

#${PANEL_ID} button:focus{ outline:none; }

#${PANEL_ID} button:focus-visible{
outline:2px solid rgba(0,0,0,0.22);
outline-offset:2px;
}

#${PANEL_ID} button:disabled{
opacity:0.45;
cursor:default;
}

/* Unified transport controls box */
#${PANEL_ID} .transportControls{
display:flex;
align-items:stretch;
height:34px;
border:1px solid rgba(0,0,0,0.16);
background:rgba(255,255,255,0.28);
border-radius:10px;
overflow:hidden;
}

#${PANEL_ID} .transportControls button{
flex:1;
display:flex;
align-items:center;
justify-content:center;
padding:0;
margin:0;
border:none;
border-radius:0;
background:transparent;
position:relative;
user-select:none;
min-width:42px;
}

/* Rounded hover effect - only around symbol */
#${PANEL_ID} .transportControls button::before{
content:'';
position:absolute;
width:28px;
height:28px;
border-radius:8px;
background:transparent;
transition:background 0.15s ease;
z-index:-1;
}

#${PANEL_ID} .transportControls button:hover::before{
background:rgba(0,0,0,0.12);
}

#${PANEL_ID} .transportControls button:active::before{
background:rgba(0,0,0,0.18);
}

#${PANEL_ID} .transportControls button.play{
font-size:16px;
font-weight:800;
}

#${PANEL_ID} .transportControls button.trk{
font-size:14px;
font-weight:750;
}

/* Vertical dividers between buttons */
#${PANEL_ID} .transportControls button:not(:last-child)::after{
content:'';
position:absolute;
right:0;
top:50%;
transform:translateY(-50%);
width:1px;
height:60%;
background:rgba(0,0,0,0.16);
}

#${PANEL_ID} button.timebox{
height:34px;
display:flex;
align-items:center;
justify-content:center;
padding:0 10px;
font-size:12px;
font-weight:750;
border-radius:10px;
font-variant-numeric:tabular-nums;
white-space:nowrap;
user-select:none;
}

/* Note removed - using inline indicator */
`;

  document.documentElement.appendChild(styleEl);

  const inner = document.createElement('div');
  inner.className = 'inner';

  closeBtnEl = document.createElement('button');
  closeBtnEl.type = 'button';
  closeBtnEl.className = 'closeX';
  closeBtnEl.setAttribute('data-role', 'closeX');
  closeBtnEl.textContent = '';
  closeBtnEl.setAttribute('aria-label', 'Close');
  closeBtnEl.title = 'Close panel';
  closeBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closePanel();
    },
    true
  );

  dragHandleEl = document.createElement('div');
  dragHandleEl.className = 'dragHandle';
  dragHandleEl.setAttribute('data-role', 'dragHandle');
  const dragLine = document.createElement('div');
  dragLine.className = 'dragLine';
  dragHandleEl.appendChild(dragLine);

  const topRowEl = document.createElement('div');
  topRowEl.className = 'topRow';
  topRowEl.setAttribute('data-role', 'topRow');

  artistEl = document.createElement('div');
  artistEl.className = 'artist';
  artistEl.setAttribute('data-role', 'artist');
  artistEl.textContent = '---';
  topRowEl.appendChild(artistEl);

  trackTitleEl = document.createElement('div');
  trackTitleEl.className = 'title';
  trackTitleEl.setAttribute('data-role', 'trackTitle');
  trackTitleEl.textContent = '---';

  waveformWrapEl = document.createElement('div');
  waveformWrapEl.className = 'waveWrap';
  waveformWrapEl.setAttribute('data-role', 'waveWrap');

  waveformCanvasEl = document.createElement('canvas');
  waveformCanvasEl.className = 'wave';
  waveformCanvasEl.setAttribute('data-role', 'waveCanvas');

  waveformHintEl = document.createElement('div');
  waveformHintEl.className = 'waveHint';
  waveformHintEl.setAttribute('data-role', 'waveHint');

  waveformHintTextEl = document.createElement('span');
  waveformHintTextEl.setAttribute('data-role', 'waveHintText');
  waveformHintTextEl.textContent = '';

  waveformHintDotsEl = document.createElement('span');
  waveformHintDotsEl.className = 'dots';
  waveformHintDotsEl.setAttribute('data-role', 'waveHintDots');
  waveformHintDotsEl.appendChild(document.createElement('span'));
  waveformHintDotsEl.appendChild(document.createElement('span'));
  waveformHintDotsEl.appendChild(document.createElement('span'));

  waveformHintEl.appendChild(waveformHintTextEl);
  waveformHintEl.appendChild(waveformHintDotsEl);

  waveformWrapEl.appendChild(waveformHintEl);
  waveformWrapEl.appendChild(waveformCanvasEl);

  transportRowEl = document.createElement('div');
  transportRowEl.className = 'transportRow';
  transportRowEl.setAttribute('data-role', 'transportRow');

  playBtnEl = document.createElement('button');
  playBtnEl.type = 'button';
  playBtnEl.className = 'play';
  playBtnEl.setAttribute('data-role', 'playPause');
  playBtnEl.textContent = '▶';
  playBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof currentHandlers.onTogglePlayPause === 'function') currentHandlers.onTogglePlayPause();
    },
    true
  );

  prevTrackBtnEl = document.createElement('button');
  prevTrackBtnEl.type = 'button';
  prevTrackBtnEl.className = 'trk';
  prevTrackBtnEl.setAttribute('data-role', 'prevTrack');
  prevTrackBtnEl.textContent = '⏮';
  prevTrackBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof currentHandlers.onPrevTrack === 'function') currentHandlers.onPrevTrack();
    },
    true
  );

  nextTrackBtnEl = document.createElement('button');
  nextTrackBtnEl.type = 'button';
  nextTrackBtnEl.className = 'trk';
  nextTrackBtnEl.setAttribute('data-role', 'nextTrack');
  nextTrackBtnEl.textContent = '⏭';
  nextTrackBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof currentHandlers.onNextTrack === 'function') currentHandlers.onNextTrack();
    },
    true
  );

  timeBtnEl = document.createElement('button');
  timeBtnEl.type = 'button';
  timeBtnEl.className = 'timebox';
  timeBtnEl.setAttribute('data-role', 'timeBox');
  timeBtnEl.textContent = '--:-- / --:--';
  timeBtnEl.title = 'Click to show remaining time';
  timeBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showRemainingTime = !showRemainingTime;
      refreshTransportUI();
    },
    true
  );

  // Create unified transport controls container
  const transportControlsEl = document.createElement('div');
  transportControlsEl.className = 'transportControls';

  transportControlsEl.appendChild(playBtnEl);
  transportControlsEl.appendChild(prevTrackBtnEl);
  transportControlsEl.appendChild(nextTrackBtnEl);

  transportRowEl.appendChild(transportControlsEl);
  transportRowEl.appendChild(timeBtnEl);

  const lower = document.createElement('div');
  lower.className = 'lower';

  const bpmCard = document.createElement('div');
  bpmCard.className = 'card';

  const bpmBox = document.createElement('div');
  bpmBox.className = 'bpmBox';

  const bpmValues = document.createElement('div');
  bpmValues.className = 'bpmValues';

  const detectedCol = document.createElement('div');
  detectedCol.className = 'bpmColumn';

  const bpmLine = document.createElement('div');
  bpmLine.className = 'labelLine';

  const bpmLabel = document.createElement('div');
  bpmLabel.className = 'label';
  bpmLabel.textContent = 'Detected BPM';

  bpmConfLabelEl = document.createElement('div');
  bpmConfLabelEl.className = 'confLabel level-unknown';
  bpmConfLabelEl.setAttribute('data-role', 'bpmConfLabel');
  bpmConfLabelEl.textContent = '';
  bpmConfLabelEl.title = 'Confidence: Unknown';
  bpmConfLabelEl.setAttribute('aria-label', 'Confidence: Unknown');

  bpmLine.appendChild(bpmLabel);
  bpmLine.appendChild(bpmConfLabelEl);

  bpmMainEl = document.createElement('div');
  bpmMainEl.className = 'value mono';
  bpmMainEl.setAttribute('data-role', 'bpmMain');
  bpmMainEl.textContent = '---';

  detectedCol.appendChild(bpmLine);
  detectedCol.appendChild(bpmMainEl);

  const manualCol = document.createElement('div');
  manualCol.className = 'bpmColumn';

  const tapLine = document.createElement('div');
  tapLine.className = 'labelLine';

  const tapLabelEl = document.createElement('div');
  tapLabelEl.className = 'label';
  tapLabelEl.setAttribute('data-role', 'tapLabel');
  tapLabelEl.textContent = 'Manual BPM';
  tapLine.appendChild(tapLabelEl);

  tapBpmEl = document.createElement('div');
  tapBpmEl.className = 'value mono';
  tapBpmEl.setAttribute('data-role', 'tapBpm');
  tapBpmEl.textContent = '---';

  manualCol.appendChild(tapLine);
  manualCol.appendChild(tapBpmEl);

  bpmValues.appendChild(detectedCol);
  bpmValues.appendChild(manualCol);

  tapBtnEl = document.createElement('button');
  tapBtnEl.type = 'button';
  tapBtnEl.className = 'tapperButton';
  tapBtnEl.setAttribute('data-role', 'tapBtn');

  const tapHintWrap = document.createElement('div');
  tapHintWrap.className = 'tapHint';

  tapHintLine1El = document.createElement('div');
  tapHintLine1El.className = 'tapLine1';
  tapHintLine1El.setAttribute('data-role', 'tapHintLine1');
  tapHintLine1El.textContent = 'Tap or click here';

  tapHintLine2El = document.createElement('div');
  tapHintLine2El.className = 'tapLine2';
  tapHintLine2El.setAttribute('data-role', 'tapHintLine2');
  tapHintLine2El.textContent = 'to detect BPM manually';

  tapHintLine3El = document.createElement('div');
  tapHintLine3El.className = 'tapLine3';
  tapHintLine3El.setAttribute('data-role', 'tapHintLine3');
  tapHintLine3El.textContent = 'Hold to reset';

  tapHintWrap.appendChild(tapHintLine1El);
  tapHintWrap.appendChild(tapHintLine2El);
  tapHintWrap.appendChild(tapHintLine3El);
  tapBtnEl.appendChild(tapHintWrap);

  const onTapPointerDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    tapLongPressed = false;
    clearTapLongPressTimer();
    try {
      tapBtnEl.setPointerCapture(ev.pointerId);
    } catch (_) {}
    tapLongPressTimer = setTimeout(() => {
      tapLongPressed = true;
      resetTapper();
    }, TAP_LONG_PRESS_MS);
  };

  const onTapPointerUp = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    clearTapLongPressTimer();
    if (!tapLongPressed) handleTap();
    tapLongPressed = false;
  };

  const onTapPointerCancel = (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    clearTapLongPressTimer();
    tapLongPressed = false;
  };

  tapBtnEl.addEventListener('pointerdown', onTapPointerDown, true);
  tapBtnEl.addEventListener('pointerup', onTapPointerUp, true);
  tapBtnEl.addEventListener('pointercancel', onTapPointerCancel, true);
  tapBtnEl.addEventListener('pointerleave', onTapPointerCancel, true);

  bpmBox.appendChild(bpmValues);
  bpmBox.appendChild(tapBtnEl);

  bpmCard.appendChild(bpmBox);

  lower.appendChild(bpmCard);

  noteEl = document.createElement('div');
  noteEl.className = 'note';
  noteEl.setAttribute('data-role', 'note');
  noteEl.textContent = '';
  noteEl.style.display = 'none';

  inner.appendChild(closeBtnEl);
  inner.appendChild(topRowEl);
  inner.appendChild(trackTitleEl);
  inner.appendChild(waveformWrapEl);
  inner.appendChild(transportRowEl);
  inner.appendChild(lower);
  inner.appendChild(noteEl);

  containerEl.appendChild(inner);
  document.documentElement.appendChild(containerEl);

  const r0 = containerEl.getBoundingClientRect();
  containerEl.style.left = `${Math.round(r0.left)}px`;
  containerEl.style.top = `${Math.round(r0.top)}px`;
  containerEl.style.right = 'auto';
  containerEl.style.bottom = 'auto';

  applyStoredPrefsToPanel();
  ensurePanelDraggable([topRowEl]);
  ensurePanelResizable();
  ensureWaveformSeeking();
  refreshTransportUI();
  drawWaveform(null, '', NaN, false);
  resetTapper();

  return containerEl;
}

export default function showResultsPanel(input: PanelInput = {}, handlers: PanelHandlers = EMPTY_HANDLERS): void {
  if (isPanelClosed()) return;
  ensurePanel();
  if (!containerEl) return;

  currentHandlers = { ...EMPTY_HANDLERS, ...handlers };

  const rawArtist = norm(input?.artistName);
  const rawTrack = norm(input?.trackTitle);
  const fallbackTitle = norm(input?.title);

  let artistName = rawArtist;
  let trackTitle = rawTrack;

  if ((!artistName || !trackTitle) && fallbackTitle) {
    const parsed = parseArtistTitleFallback(fallbackTitle);
    if (!artistName && parsed.artistName) artistName = parsed.artistName;
    if (!trackTitle && parsed.trackTitle) trackTitle = parsed.trackTitle;
  }

  if (artistEl) artistEl.textContent = artistName || '---';
  if (trackTitleEl) trackTitleEl.textContent = trackTitle || fallbackTitle || '---';

  const bpm = input?.bpm;
  const tempoScale = Number.isFinite(input?.tempoScale) ? input.tempoScale : 1;
  const bpmConfidence = input?.confidence ?? NaN;
  currentWaveform = input?.waveform || null;
  currentWaveformStatus = input?.waveformStatus || '';
  currentIsAnalyzing = Boolean(input?.isAnalyzing);

  if (typeof input?.isPlaying === 'boolean') currentIsPlaying = input.isPlaying;

  currentPlayheadFraction = Number.isFinite(input?.playheadFraction) ? input.playheadFraction : NaN;
  currentTimeSec = Number.isFinite(input?.currentTimeSec) ? input.currentTimeSec : NaN;
  currentDurationSec = Number.isFinite(input?.durationSec) ? input.durationSec : NaN;

  const shownBpm = Number.isFinite(bpm) ? bpm * tempoScale : NaN;

  if (bpmMainEl) bpmMainEl.textContent = Number.isFinite(shownBpm) ? String(Math.round(shownBpm)) : '---';
  if (bpmConfLabelEl) {
    const label = confLevelLabel(bpmConfidence);
    bpmConfLabelEl.textContent = '';
    bpmConfLabelEl.title = label;
    bpmConfLabelEl.setAttribute('aria-label', label);
    bpmConfLabelEl.classList.remove('level-low', 'level-medium', 'level-high', 'level-unknown');
    bpmConfLabelEl.classList.add('confLabel', confLevelClassForState(bpmConfidence, currentIsAnalyzing));
  }
  if (tapBpmEl) tapBpmEl.textContent = Number.isFinite(tapBpm) ? String(Math.round(tapBpm)) : '---';

  // Control BPM pulsing animation during analysis
  if (bpmMainEl) {
    if (currentIsAnalyzing) {
      bpmMainEl.classList.add('analyzing');
    } else {
      bpmMainEl.classList.remove('analyzing');
    }
  }

  if (noteEl) {
    noteEl.style.display = 'none';
  }

  refreshTransportUI();
  drawWaveform(currentWaveform, currentWaveformStatus, currentPlayheadFraction, currentIsAnalyzing);
}
