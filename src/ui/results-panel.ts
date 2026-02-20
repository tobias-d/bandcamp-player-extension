/**
 * Floating analysis panel renderer.
 *
 * Handles panel lifecycle, transport controls, waveform drawing, and playlist UI
 * rendering/sorting/autoscroll behavior from immutable input state snapshots.
 */
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
  trackKey?: string;
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
  playlistTracks?: PlaylistRowInput[];
  playlistCurrentIndex?: number;
  playlistExpanded?: boolean;
  playlistLoading?: boolean;
};

type PanelHandlers = {
  onTogglePlayPause?: (() => void) | null;
  onPrevTrack?: (() => void) | null;
  onNextTrack?: (() => void) | null;
  onSeekToFraction?: ((fraction: number) => void) | null;
  onTogglePlaylist?: (() => void) | null;
  onSelectPlaylistTrack?: ((index: number) => void) | null;
};

type PlaylistRowInput = {
  index?: number;
  title?: string;
  durationSec?: number;
  bpm?: number;
  isCurrent?: boolean;
};

const EMPTY_HANDLERS: PanelHandlers = {
  onTogglePlayPause: null,
  onPrevTrack: null,
  onNextTrack: null,
  onSeekToFraction: null,
  onTogglePlaylist: null,
  onSelectPlaylistTrack: null,
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
let playlistBtnEl: HTMLButtonElement | null = null;
let playlistBtnLabelEl: HTMLSpanElement | null = null;
let playlistWrapEl: HTMLDivElement | null = null;
let playlistScrollEl: HTMLDivElement | null = null;
let playlistBodyEl: HTMLDivElement | null = null;
let playlistStatusEl: HTMLDivElement | null = null;
let playlistHeadTrackBtnEl: HTMLButtonElement | null = null;
let playlistHeadBpmBtnEl: HTMLButtonElement | null = null;
let infoBtnEl: HTMLButtonElement | null = null;
let infoPanelEl: HTMLDivElement | null = null;
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
let revealedWaveformKey = '';
let tapTimesMs: number[] = [];
let tapBpm = NaN;
let tapLongPressTimer: ReturnType<typeof setTimeout> | null = null;
let tapLongPressed = false;
let lastTapTrackKey = '';
let currentPlaylistRows: PlaylistRowInput[] = [];
let currentPlaylistIndex = -1;
let currentPlaylistExpanded = false;
let currentPlaylistLoading = false;
let currentPlaylistSortMode: 'track' | 'bpm' = 'track';
let currentPlaylistSortDir: 1 | -1 = 1;
let lastPlaylistRenderKey = '';
let pendingPlaylistAutoCenter = false;
let skipNextAutoCenterFromPlaylistClick = false;
let playlistClickTargetIndex = -1;

const PANEL_ID = 'bc-bpm-panel';
const PANEL_UI_VERSION = 'alt-v39-playlist-glyph-center';
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
let infoGlobalListenersAttached = false;

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

function closeInfoPanel(): void {
  if (!infoPanelEl) return;
  infoPanelEl.style.display = 'none';
  if (infoBtnEl) {
    infoBtnEl.setAttribute('aria-expanded', 'false');
  }
}

function toggleInfoPanel(): void {
  if (!infoPanelEl || !infoBtnEl) return;
  const isOpen = infoPanelEl.style.display === 'block';
  if (isOpen) {
    closeInfoPanel();
    return;
  }
  infoPanelEl.style.display = 'block';
  infoBtnEl.setAttribute('aria-expanded', 'true');
}

function ensureInfoPanelGlobalListeners(): void {
  if (infoGlobalListenersAttached) return;
  infoGlobalListenersAttached = true;

  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (!infoPanelEl || infoPanelEl.style.display !== 'block') return;
      const target = ev.target as Node | null;
      if (!target) {
        closeInfoPanel();
        return;
      }
      if (infoPanelEl.contains(target)) return;
      if (infoBtnEl && infoBtnEl.contains(target)) return;
      closeInfoPanel();
    },
    true
  );

  window.addEventListener(
    'keydown',
    (ev) => {
      if ((ev as KeyboardEvent).key === 'Escape') {
        closeInfoPanel();
      }
    },
    true
  );
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

function waveformRevealKey(waveform, low, mid, high) {
  const duration = Number.isFinite(waveform?.duration) ? Math.round(waveform.duration * 1000) : -1;
  const lowLen = Array.isArray(low) ? low.length : 0;
  const midLen = Array.isArray(mid) ? mid.length : 0;
  const highLen = Array.isArray(high) ? high.length : 0;
  const sampleLow = lowLen ? Math.round(Number(low[0] || 0) * 1000) : 0;
  const sampleMid = midLen ? Math.round(Number(mid[0] || 0) * 1000) : 0;
  const sampleHigh = highLen ? Math.round(Number(high[0] || 0) * 1000) : 0;
  return `${duration}|${lowLen}|${midLen}|${highLen}|${sampleLow}|${sampleMid}|${sampleHigh}`;
}

function triggerWaveformReveal(waveform, low, mid, high) {
  if (!waveformCanvasEl) return;
  const key = waveformRevealKey(waveform, low, mid, high);
  if (!key || key === revealedWaveformKey) return;
  revealedWaveformKey = key;
  waveformCanvasEl.classList.remove('waveRevealReady');
  void waveformCanvasEl.offsetWidth;
  waveformCanvasEl.classList.add('waveRevealReady');
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

  if (!hasAny) {
    revealedWaveformKey = '';
    if (waveformCanvasEl.classList.contains('waveRevealReady')) {
      waveformCanvasEl.classList.remove('waveRevealReady');
    }
    return;
  }

  if (!isAnalyzing && !String(statusText || '').trim()) {
    triggerWaveformReveal(waveform, low, mid, high);
  }

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

function renderPlaylistUI() {
  if (!playlistWrapEl || !playlistScrollEl || !playlistBodyEl || !playlistStatusEl) return;
  const playlistViewportEl = playlistScrollEl.parentElement as HTMLElement | null;
  const prevScrollTop = playlistScrollEl.scrollTop;

  const hasTracks = currentPlaylistRows.length > 0;
  const shouldShow = currentPlaylistExpanded && (hasTracks || currentPlaylistLoading);
  const playlistKey = JSON.stringify({
    shouldShow,
    loading: currentPlaylistLoading,
    currentIndex: currentPlaylistIndex,
    sortMode: currentPlaylistSortMode,
    sortDir: currentPlaylistSortDir,
    rows: currentPlaylistRows.map((row, i) => ({
      i: Number.isFinite(row?.index) ? Number(row.index) : i,
      t: norm(row?.title),
      d: Number.isFinite(row?.durationSec) ? Number(row.durationSec) : NaN,
      b: Number.isFinite(row?.bpm) ? Math.round(Number(row.bpm)) : NaN,
      c: Boolean(row?.isCurrent),
    })),
  });

  if (playlistKey === lastPlaylistRenderKey) {
    refreshPlaylistSortUI();
    syncPlaylistCurrentHighlight();
    if (pendingPlaylistAutoCenter) {
      const centered = maybeCenterCurrentPlaylistRow(true);
      if (centered) pendingPlaylistAutoCenter = false;
    }
    return;
  }
  lastPlaylistRenderKey = playlistKey;

  playlistWrapEl.style.display = shouldShow ? 'block' : 'none';

  if (!shouldShow) {
    playlistBodyEl.innerHTML = '';
    if (playlistViewportEl) playlistViewportEl.style.display = 'none';
    playlistScrollEl.style.display = 'none';
    playlistStatusEl.style.display = 'none';
    return;
  }

  playlistBodyEl.innerHTML = '';

  if (currentPlaylistLoading) {
    if (playlistViewportEl) playlistViewportEl.style.display = 'none';
    playlistScrollEl.style.display = 'none';
    playlistStatusEl.style.display = 'block';
    playlistStatusEl.textContent = 'Loading playlist…';
    return;
  }

  if (!hasTracks) {
    if (playlistViewportEl) playlistViewportEl.style.display = 'none';
    playlistScrollEl.style.display = 'none';
    playlistStatusEl.style.display = 'block';
    playlistStatusEl.textContent = 'No playlist tracks found.';
    return;
  }

  if (playlistViewportEl) playlistViewportEl.style.display = 'block';
  playlistScrollEl.style.display = 'block';
  playlistStatusEl.style.display = 'none';
  if (playlistViewportEl) {
    const scrollbarW = Math.max(0, playlistScrollEl.offsetWidth - playlistScrollEl.clientWidth);
    playlistViewportEl.style.setProperty('--playlist-scrollbar-w', `${scrollbarW}px`);
  }
  refreshPlaylistSortUI();

  const rowsToRender = getSortedPlaylistRows();
  for (const rowData of rowsToRender) {
    const { row, playlistIndex, title, bpm, durationSec, isCurrent } = rowData;
    const numberedTitle = `${pad2(playlistIndex + 1)} - ${title}`;

    const rowBtn = document.createElement('button');
    rowBtn.type = 'button';
    rowBtn.className = `playlistRow${isCurrent ? ' current' : ''}`;
    rowBtn.setAttribute('data-playlist-index', String(playlistIndex));
    rowBtn.setAttribute('aria-label', `Play ${title}`);
    rowBtn.title = `Play ${title}`;

    const titleEl = document.createElement('span');
    titleEl.className = 'playlistTitle';
    titleEl.textContent = numberedTitle;

    const bpmEl = document.createElement('span');
    bpmEl.className = 'playlistBpm';
    bpmEl.textContent = Number.isFinite(bpm) ? String(Math.round(bpm)) : '---';

    const timeEl = document.createElement('span');
    timeEl.className = 'playlistTime';
    timeEl.textContent = fmtTime(durationSec);

    rowBtn.appendChild(titleEl);
    rowBtn.appendChild(bpmEl);
    rowBtn.appendChild(timeEl);

    rowBtn.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        skipNextAutoCenterFromPlaylistClick = true;
        playlistClickTargetIndex = playlistIndex;
        if (typeof currentHandlers.onSelectPlaylistTrack === 'function') {
          currentHandlers.onSelectPlaylistTrack(playlistIndex);
        }
      },
      true
    );

    playlistBodyEl.appendChild(rowBtn);
  }

  if (!pendingPlaylistAutoCenter && Number.isFinite(prevScrollTop)) {
    const maxTop = Math.max(0, playlistScrollEl.scrollHeight - playlistScrollEl.clientHeight);
    playlistScrollEl.scrollTop = clamp(prevScrollTop, 0, maxTop);
  }

  syncPlaylistCurrentHighlight();
  if (pendingPlaylistAutoCenter) {
    const centered = maybeCenterCurrentPlaylistRow(true);
    if (centered) pendingPlaylistAutoCenter = false;
  }
}

function getSortedPlaylistRows(): Array<{
  row: PlaylistRowInput;
  playlistIndex: number;
  title: string;
  bpm: number;
  durationSec: number;
  isCurrent: boolean;
}> {
  const rows = currentPlaylistRows.map((row, i) => {
    const playlistIndex = Number.isFinite(row?.index) ? Number(row.index) : i;
    const title = norm(row?.title) || `Track ${i + 1}`;
    const bpm = Number(row?.bpm);
    const durationSec = Number(row?.durationSec);
    const isCurrent = Boolean(row?.isCurrent) || playlistIndex === currentPlaylistIndex;
    return { row, playlistIndex, title, bpm, durationSec, isCurrent };
  });

  if (currentPlaylistSortMode === 'track') {
    rows.sort((a, b) => a.playlistIndex - b.playlistIndex);
    return rows;
  }

  // Avoid unstable "current track jumps to top" behavior when only one
  // track has a resolved BPM. In that case, keep track-number ordering.
  const knownBpmCount = rows.reduce((count, item) => (Number.isFinite(item.bpm) ? count + 1 : count), 0);
  if (knownBpmCount < 2) {
    rows.sort((a, b) => a.playlistIndex - b.playlistIndex);
    return rows;
  }

  rows.sort((a, b) => {
    const aHas = Number.isFinite(a.bpm);
    const bHas = Number.isFinite(b.bpm);
    if (!aHas && !bHas) return a.playlistIndex - b.playlistIndex;
    if (!aHas) return 1;
    if (!bHas) return -1;
    const diff = (a.bpm - b.bpm) * currentPlaylistSortDir;
    if (Math.abs(diff) > 0.001) return diff;
    return a.playlistIndex - b.playlistIndex;
  });

  return rows;
}

function setPlaylistSort(mode: 'track' | 'bpm'): void {
  if (mode === 'track') {
    currentPlaylistSortMode = 'track';
    currentPlaylistSortDir = 1;
    renderPlaylistUI();
    return;
  }

  if (currentPlaylistSortMode === 'bpm') {
    currentPlaylistSortDir = currentPlaylistSortDir === 1 ? -1 : 1;
  } else {
    currentPlaylistSortMode = 'bpm';
    currentPlaylistSortDir = 1;
  }
  renderPlaylistUI();
}

function refreshPlaylistSortUI(): void {
  if (playlistHeadTrackBtnEl) {
    const active = currentPlaylistSortMode === 'track';
    playlistHeadTrackBtnEl.classList.toggle('active', active);
    playlistHeadTrackBtnEl.setAttribute('aria-pressed', active ? 'true' : 'false');
    playlistHeadTrackBtnEl.title = 'Sort by track number';
  }

  if (playlistHeadBpmBtnEl) {
    const active = currentPlaylistSortMode === 'bpm';
    playlistHeadBpmBtnEl.classList.toggle('active', active);
    playlistHeadBpmBtnEl.setAttribute('aria-pressed', active ? 'true' : 'false');
    playlistHeadBpmBtnEl.setAttribute('data-dir', currentPlaylistSortDir === 1 ? 'asc' : 'desc');
    playlistHeadBpmBtnEl.title = active
      ? currentPlaylistSortDir === 1
        ? 'Sort by BPM (ascending)'
        : 'Sort by BPM (descending)'
      : 'Sort by BPM';
  }
}

function syncPlaylistCurrentHighlight(): void {
  if (!playlistBodyEl) return;
  const rowButtons = Array.from(playlistBodyEl.querySelectorAll('[data-playlist-index]')) as HTMLElement[];
  if (!rowButtons.length) return;

  const explicitCurrent = new Set<number>();
  for (let i = 0; i < currentPlaylistRows.length; i += 1) {
    const row = currentPlaylistRows[i];
    const rowIndex = Number.isFinite(row?.index) ? Number(row.index) : i;
    if (row?.isCurrent) explicitCurrent.add(rowIndex);
  }

  for (const button of rowButtons) {
    const idx = Number(button.getAttribute('data-playlist-index'));
    const isCurrent = idx === currentPlaylistIndex || explicitCurrent.has(idx);
    button.classList.toggle('current', isCurrent);
  }
}

function maybeCenterCurrentPlaylistRow(force = false): boolean {
  if (!playlistScrollEl || !playlistBodyEl) return false;
  if (!force) return false;
  if (!currentPlaylistExpanded) return false;
  if (!currentPlaylistRows.length) return false;
  if (!Number.isFinite(currentPlaylistIndex) || currentPlaylistIndex < 0) return false;
  if (currentPlaylistSortMode === 'bpm') return false;

  const row = playlistBodyEl.querySelector(`[data-playlist-index="${currentPlaylistIndex}"]`) as HTMLElement | null;
  if (!row) return false;

  const viewportRect = playlistScrollEl.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const viewportCenterY = viewportRect.top + playlistScrollEl.clientHeight / 2;
  const rowCenterY = rowRect.top + rowRect.height / 2;
  const centerDelta = rowCenterY - viewportCenterY;
  const targetTop = playlistScrollEl.scrollTop + centerDelta;
  const maxTop = Math.max(0, playlistScrollEl.scrollHeight - playlistScrollEl.clientHeight);
  const clampedTop = clamp(targetTop, 0, maxTop);
  const delta = Math.abs(playlistScrollEl.scrollTop - clampedTop);

  if (delta > 1) {
    playlistScrollEl.scrollTo({
      top: clampedTop,
      behavior: 'auto',
    });
  }

  return true;
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

  if (playlistBtnEl) {
    const hasTracks = currentPlaylistRows.length > 0;
    const enabled = hasTracks || currentPlaylistLoading;
    playlistBtnEl.disabled = !enabled;
    playlistBtnEl.classList.toggle('noPlaylist', !enabled);
    playlistBtnEl.classList.toggle('active', currentPlaylistExpanded && enabled);
    playlistBtnEl.setAttribute('aria-pressed', currentPlaylistExpanded && enabled ? 'true' : 'false');
    playlistBtnEl.setAttribute(
      'aria-label',
      currentPlaylistExpanded && enabled ? 'Hide playlist' : 'Show playlist'
    );
    playlistBtnEl.title = enabled
      ? currentPlaylistExpanded
        ? 'Hide playlist'
        : 'Show playlist'
      : 'Playlist unavailable';
    if (playlistBtnLabelEl) {
      playlistBtnLabelEl.textContent = '';
    }
  }

  renderPlaylistUI();
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

function computeTapTrackKey(
  inputTrackKey: string,
  artistName: string,
  trackTitle: string,
  fallbackTitle: string
): string {
  const explicit = norm(inputTrackKey);
  if (explicit) return `k:${explicit}`;

  const artist = norm(artistName);
  const track = norm(trackTitle);
  if (artist || track) return `m:${artist}|${track}`;

  const title = norm(fallbackTitle);
  if (title) return `t:${title}`;

  return '';
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
  playlistBtnEl = null;
  playlistBtnLabelEl = null;
  playlistWrapEl = null;
  playlistScrollEl = null;
  playlistBodyEl = null;
  playlistStatusEl = null;
  playlistHeadTrackBtnEl = null;
  playlistHeadBpmBtnEl = null;
  infoBtnEl = null;
  infoPanelEl = null;
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
  lastTapTrackKey = '';
  currentPlaylistRows = [];
  currentPlaylistIndex = -1;
  currentPlaylistExpanded = false;
  currentPlaylistLoading = false;
  currentPlaylistSortMode = 'track';
  currentPlaylistSortDir = 1;
  lastPlaylistRenderKey = '';
  pendingPlaylistAutoCenter = false;
  skipNextAutoCenterFromPlaylistClick = false;
  playlistClickTargetIndex = -1;
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
  playlistBtnEl = byRole<HTMLButtonElement>('playlistToggle');
  playlistBtnLabelEl = byRole<HTMLSpanElement>('playlistToggleLabel');
  playlistWrapEl = byRole<HTMLDivElement>('playlistWrap');
  playlistScrollEl = byRole<HTMLDivElement>('playlistScroll');
  playlistBodyEl = byRole<HTMLDivElement>('playlistBody');
  playlistStatusEl = byRole<HTMLDivElement>('playlistStatus');
  playlistHeadTrackBtnEl = byRole<HTMLButtonElement>('playlistHeadTrackSort');
  playlistHeadBpmBtnEl = byRole<HTMLButtonElement>('playlistHeadBpmSort');
  infoBtnEl = byRole<HTMLButtonElement>('infoBtn');
  infoPanelEl = byRole<HTMLDivElement>('infoPanel');
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
--surface-soft:rgba(228,228,228,0.25);
transform-origin:top left;
transform:scale(var(--panel-scale));
font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;
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

/* Top-right compact actions: [ i | x ] */
#${PANEL_ID} .topActions{
position:absolute;
top:4px;
right:4px;
display:flex;
align-items:stretch;
height:18px;
border:1px solid rgba(0,0,0,0.14);
background:rgba(255,255,255,0.24);
border-radius:999px;
overflow:hidden;
z-index:10;
}

#${PANEL_ID} .topActions button{
appearance:none;
width:20px;
height:18px;
padding:0;
margin:0;
border:none;
background:transparent;
position:relative;
display:flex;
align-items:center;
justify-content:center;
cursor:pointer;
color:rgba(0,0,0,0.64);
transition:background 0.15s ease, color 0.15s ease;
}

#${PANEL_ID} .topActions button:not(:last-child)::after{
content:'';
position:absolute;
right:0;
top:3px;
bottom:3px;
width:1px;
background:rgba(0,0,0,0.14);
}

#${PANEL_ID} .topActions button:hover{
background:rgba(255,255,255,0.42);
color:rgba(0,0,0,0.86);
}

#${PANEL_ID} .topActions button:active{
background:rgba(255,255,255,0.16);
}

@keyframes infoEdgeSpin{
0%{ transform:rotate(0deg); }
100%{ transform:rotate(360deg); }
}

#${PANEL_ID} .topActions .infoBtn::before{
content:'';
position:absolute;
inset:0;
border-radius:999px 0 0 999px;
padding:1px;
background:conic-gradient(
  from 0deg,
  rgba(203,112,255,0.96) 0deg,
  rgba(242,96,194,0.96) 120deg,
  rgba(203,112,255,0.96) 240deg,
  rgba(242,96,194,0.96) 360deg
);
opacity:0;
transition:opacity 160ms ease;
pointer-events:none;
z-index:0;
-webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
-webkit-mask-composite:xor;
mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
mask-composite:exclude;
}

#${PANEL_ID} .topActions .infoBtn:hover{
background:rgba(255,255,255,0.30);
color:rgba(64,18,86,0.96);
}

#${PANEL_ID} .topActions .infoBtn:hover::before{
opacity:1;
animation:infoEdgeSpin 1.2s linear infinite;
}

#${PANEL_ID} .topActions .infoBtn:active{
background:rgba(255,255,255,0.16);
}

#${PANEL_ID} .closeX .closeIcon,
#${PANEL_ID} .infoBtn .infoIcon{
position:relative;
display:block;
width:10px;
height:10px;
}

#${PANEL_ID} .closeX .closeIcon::before,
#${PANEL_ID} .closeX .closeIcon::after{
content:'';
position:absolute;
left:4px;
top:0;
width:1.5px;
height:10px;
background:currentColor;
border-radius:999px;
}

#${PANEL_ID} .closeX .closeIcon::before{ transform:rotate(45deg); }
#${PANEL_ID} .closeX .closeIcon::after{ transform:rotate(-45deg); }

#${PANEL_ID} .infoBtn .infoIcon::before{
content:'';
position:absolute;
left:4px;
top:3px;
width:1.5px;
height:6px;
background:currentColor;
border-radius:999px;
}

#${PANEL_ID} .infoBtn .infoIcon::after{
content:'';
position:absolute;
left:4px;
top:1px;
width:1.5px;
height:1.5px;
background:currentColor;
border-radius:999px;
}

#${PANEL_ID} .infoPanel{
position:absolute;
top:24px;
right:4px;
display:none;
min-width:170px;
padding:8px;
border-radius:10px;
border:1px solid rgba(0,0,0,0.14);
background:rgba(245,245,245,0.95);
backdrop-filter:blur(8px);
box-shadow:0 8px 18px rgba(0,0,0,0.16);
z-index:20;
}

#${PANEL_ID} .infoPanel a{
display:block;
padding:6px 8px;
border-radius:7px;
font-size:12px;
font-weight:600;
line-height:1.2;
color:#111;
text-decoration:none;
}

#${PANEL_ID} .infoPanel a:hover{
background:rgba(0,0,0,0.08);
text-decoration:none;
}

#${PANEL_ID} .closeX:focus-visible,
#${PANEL_ID} .infoBtn:focus-visible{
outline:2px solid rgba(0,0,0,0.20);
outline-offset:1px;
}

#${PANEL_ID} .topRow{
display:flex;
justify-content:flex-start;
align-items:center;
margin-bottom:6px;
min-height:32px;
padding-right:44px;
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

/* Waveform container */
#${PANEL_ID} .waveWrap{
margin:2px 0 0 0;
padding:6px 8px 2px 8px;
border-radius:10px;
background:var(--surface-soft);
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

#${PANEL_ID} canvas.wave.waveRevealReady{
animation: bcWaveReveal 520ms cubic-bezier(0.22, 0.61, 0.36, 1);
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

@keyframes bcWaveReveal{
0%{
opacity:0;
clip-path:inset(0 100% 0 0);
}
100%{
opacity:1;
clip-path:inset(0 0 0 0);
}
}

#${PANEL_ID} .transportRow{
position:relative;
display:flex;
align-items:center;
justify-content:flex-start;
gap:10px;
margin-top:10px;
min-height:38px;
padding:2px 0;
}

#${PANEL_ID} .transportRow > *{
margin:0 !important;
}

#${PANEL_ID} .lower{
margin-top:10px;
display:grid;
grid-template-columns: 1fr;
gap:10px;
}

/* Shared card surface */
#${PANEL_ID} .card{
border-radius:14px;
background:var(--surface-soft);
border:1px solid rgba(0,0,0,0.10);
padding:10px;
min-height:156px;
}

/* Two-column BPM/tap layout with centered divider */
#${PANEL_ID} .bpmBox{
display:grid;
grid-template-columns: 1fr 1fr;
gap:0;
align-items:stretch;
position:relative;
}

/* Centered divider */
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

/* BPM values column wrapper */
#${PANEL_ID} .bpmValues{
display:flex;
flex-direction:column;
gap:16px;
min-height:136px;
padding:14px 16px 0 10px;
}

/* Individual BPM column */
#${PANEL_ID} .bpmColumn{
display:flex;
flex-direction:column;
gap:8px;
min-width:0;
min-height:60px;
}

/* Label row */
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
transform:translateY(-1px);
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

/* Value row */
#${PANEL_ID} .value{
font-size:26px;
font-weight:750;
line-height:1.05;
color:#111;
min-height:28px;
}

#${PANEL_ID} .value.mono{ font-variant-numeric:tabular-nums; }

/* BPM pulsing animation during analysis */
#${PANEL_ID} .value.analyzing{
animation:bpmPulsing 1.5s ease-in-out infinite;
}

@keyframes bpmPulsing{
0%, 100%{ opacity:0.4; }
50%{ opacity:1; }
}

/* Full-column tap target */
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
height:36px;
border:1px solid rgba(0,0,0,0.14);
background:rgba(255,255,255,0.16);
border-radius:12px;
overflow:hidden;
justify-self:start;
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
color:#111;
}

/* Rounded hover effect - only around symbol */
#${PANEL_ID} .transportControls button::before{
content:'';
position:absolute;
width:30px;
height:30px;
border-radius:9px;
background:transparent;
transition:background 0.15s ease;
z-index:-1;
}

#${PANEL_ID} .transportControls button:hover::before{
background:rgba(0,0,0,0.09);
}

#${PANEL_ID} .transportControls button:active::before{
background:rgba(0,0,0,0.14);
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
background:rgba(0,0,0,0.12);
}

#${PANEL_ID} button.timebox{
position:relative;
left:auto;
top:auto;
transform:none;
height:36px;
display:flex;
align-items:center;
justify-content:center;
padding:0 14px;
font-size:12px;
font-weight:720;
letter-spacing:0.01em;
border-radius:12px;
font-variant-numeric:tabular-nums;
white-space:nowrap;
user-select:none;
background:rgba(255,255,255,0.16);
border:1px solid rgba(0,0,0,0.14);
min-width:108px;
line-height:1.1;
color:#111;
z-index:0;
box-shadow:none;
transition:background 0.15s ease, border-color 0.15s ease;
}

#${PANEL_ID} button.timebox:hover{
background:rgba(255,255,255,0.24);
border-color:rgba(0,0,0,0.18);
}

#${PANEL_ID} button.timebox:active{
background:rgba(255,255,255,0.12);
}

#${PANEL_ID} button.timebox:focus-visible{
outline:2px solid rgba(0,0,0,0.22);
outline-offset:1px;
}

#${PANEL_ID} button.playlistToggle{
appearance:none;
position:relative;
right:auto;
top:auto;
transform:none;
background:rgba(255,255,255,0.16);
border:1px solid rgba(0,0,0,0.14);
border-radius:12px;
padding:0 12px;
margin:0;
display:inline-flex;
align-items:center;
justify-content:center;
gap:6px;
min-width:40px;
height:36px;
line-height:1.2;
color:#111;
cursor:pointer;
overflow:hidden;
flex-direction:row-reverse;
z-index:0;
box-shadow:none;
transition:background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

#${PANEL_ID} button.playlistToggle.active{
color:#111;
}

#${PANEL_ID} button.playlistToggle:hover{
background:rgba(255,255,255,0.24);
border-color:rgba(0,0,0,0.18);
color:rgba(64,64,64,0.96);
}

#${PANEL_ID} button.playlistToggle:active{
background:rgba(255,255,255,0.12);
}

#${PANEL_ID} .playlistToggleGlyph{
position:relative;
display:inline-block;
width:12px;
height:12px;
overflow:visible;
flex:0 0 auto;
}

#${PANEL_ID} .playlistToggleGlyph .line{
position:absolute;
left:0;
background:currentColor;
border-radius:999px;
transform:translateZ(0);
}

#${PANEL_ID} .playlistToggleGlyph .line.line1{
top:0;
width:10px;
height:1.5px;
}

#${PANEL_ID} .playlistToggleGlyph .line.line2{
top:5px;
width:10px;
height:1.5px;
}

#${PANEL_ID} .playlistToggleGlyph .line.line3{
top:10px;
width:10px;
height:1.5px;
}

#${PANEL_ID} .playlistToggleLabel{
display:none;
}

#${PANEL_ID} .playlistWrap{
--playlist-bpm-col:56px;
--playlist-time-col:56px;
--playlist-right-gap:18px;
--playlist-header-h:36px;
--playlist-max-h:220px;
margin-top:10px;
display:none;
}

#${PANEL_ID} .playlistViewport{
--playlist-scrollbar-w:0px;
position:relative;
border-radius:12px;
border:1px solid rgba(0,0,0,0.10);
background:var(--surface-soft);
overflow:hidden;
max-height:var(--playlist-max-h);
}

#${PANEL_ID} .playlistViewport::after{
content:'';
position:absolute;
left:0;
right:calc(var(--playlist-scrollbar-w) + 2px);
bottom:0;
height:16px;
background:linear-gradient(to bottom, rgba(255,255,255,0), var(--surface-soft));
pointer-events:none;
z-index:2;
}

#${PANEL_ID} .playlistScroll{
max-height:calc(var(--playlist-max-h) - var(--playlist-header-h));
overflow-y:auto;
overflow-x:hidden;
scrollbar-gutter:stable;
scrollbar-width:thin;
scrollbar-color:rgba(0,0,0,0.30) transparent;
}

#${PANEL_ID} .playlistScroll::-webkit-scrollbar{
width:10px;
height:10px;
}

#${PANEL_ID} .playlistScroll::-webkit-scrollbar-track{
background:transparent;
border-radius:999px;
margin:10px 2px;
}

#${PANEL_ID} .playlistScroll::-webkit-scrollbar-thumb{
background:rgba(0,0,0,0.30);
border-radius:999px;
border:2px solid var(--surface-soft);
background-clip:padding-box;
}

#${PANEL_ID} .playlistScroll::-webkit-scrollbar-thumb:hover{
background:rgba(0,0,0,0.40);
background-clip:padding-box;
}

#${PANEL_ID} .playlistScroll::-webkit-scrollbar-corner{
background:transparent;
}

#${PANEL_ID} .playlistHead{
display:grid;
grid-template-columns:minmax(0,1fr) var(--playlist-bpm-col) var(--playlist-time-col);
gap:10px;
font-size:10px;
letter-spacing:0.05em;
text-transform:uppercase;
opacity:1;
color:rgba(0,0,0,0.9);
padding:0 calc(var(--playlist-right-gap) + var(--playlist-scrollbar-w)) 0 6px;
padding-left:12px;
min-height:var(--playlist-header-h);
align-items:center;
background:transparent;
border-bottom:1px solid rgba(0,0,0,0.12);
box-shadow:none;
font-weight:700;
}

#${PANEL_ID} .playlistHead button{
appearance:none;
background:transparent;
border:none;
padding:0;
margin:0;
display:block;
width:100%;
text-align:left;
font:inherit;
font-size:10px;
letter-spacing:0.05em;
text-transform:uppercase;
font-weight:700;
color:inherit;
opacity:0.88;
cursor:pointer;
}

#${PANEL_ID} .playlistHead > *{
justify-self:start;
align-self:center;
width:100%;
text-align:left;
}

#${PANEL_ID} .playlistHead button:hover{
background:transparent;
border-color:transparent;
opacity:1;
}

#${PANEL_ID} .playlistHead button.active{
opacity:1;
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.sortable::after{
content:' ▲▼';
font-size:9px;
color:rgba(0,0,0,0.78);
opacity:0.95;
vertical-align:1px;
letter-spacing:-0.12em;
margin-left:6px;
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.track.active::after{
opacity:0.9;
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.bpm.active::after{
opacity:0.9;
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.bpm.active[data-dir="asc"]::after{
content:' ▲';
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.bpm.active[data-dir="desc"]::after{
content:' ▼';
}

#${PANEL_ID} .playlistHead .playlistHeadBtn.bpm,
#${PANEL_ID} .playlistHead span.timeHead{
text-align:left;
}

#${PANEL_ID} .playlistHead span.timeHead{
display:block;
}

#${PANEL_ID} .playlistBody{
display:flex;
flex-direction:column;
gap:4px;
}

#${PANEL_ID} .playlistStatus{
font-size:12px;
opacity:0.75;
padding:6px;
display:none;
}

#${PANEL_ID} .playlistRow{
display:grid;
grid-template-columns:minmax(0,1fr) var(--playlist-bpm-col) var(--playlist-time-col);
align-items:center;
gap:10px;
padding:6px var(--playlist-right-gap) 6px 6px;
padding-left:12px;
border:none;
border-radius:8px;
background:transparent;
text-align:left;
width:100%;
box-sizing:border-box;
box-shadow:inset 0 0 0 1px transparent;
font-weight:400;
}

#${PANEL_ID} .playlistRow:hover{
background:rgba(0,0,0,0.08);
box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);
}

#${PANEL_ID} .playlistRow.current{
background:rgba(113,106,169,0.22);
box-shadow:none;
}

#${PANEL_ID} .playlistTitle{
min-width:0;
overflow:hidden;
text-overflow:ellipsis;
white-space:nowrap;
font-size:12px;
font-weight:400;
}

#${PANEL_ID} .playlistBpm,
#${PANEL_ID} .playlistTime{
font-size:11px;
font-variant-numeric:tabular-nums;
opacity:0.85;
white-space:nowrap;
font-weight:400;
}

#${PANEL_ID} .playlistBpm{
text-align:left;
justify-self:start;
}

#${PANEL_ID} .playlistTime{
text-align:left;
justify-self:start;
}

`;

  document.documentElement.appendChild(styleEl);

  const inner = document.createElement('div');
  inner.className = 'inner';

  closeBtnEl = document.createElement('button');
  closeBtnEl.type = 'button';
  closeBtnEl.className = 'closeX';
  closeBtnEl.setAttribute('data-role', 'closeX');
  const closeIconEl = document.createElement('span');
  closeIconEl.className = 'closeIcon';
  closeBtnEl.appendChild(closeIconEl);
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

  infoBtnEl = document.createElement('button');
  infoBtnEl.type = 'button';
  infoBtnEl.className = 'infoBtn';
  infoBtnEl.setAttribute('data-role', 'infoBtn');
  const infoIconEl = document.createElement('span');
  infoIconEl.className = 'infoIcon';
  infoBtnEl.appendChild(infoIconEl);
  infoBtnEl.setAttribute('aria-label', 'Information');
  infoBtnEl.setAttribute('aria-expanded', 'false');
  infoBtnEl.title = 'Information';
  infoBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleInfoPanel();
    },
    true
  );

  infoPanelEl = document.createElement('div');
  infoPanelEl.className = 'infoPanel';
  infoPanelEl.setAttribute('data-role', 'infoPanel');

  const feedbackLinkEl = document.createElement('a');
  feedbackLinkEl.href = 'https://forms.gle/CMyrodpNPThdr5Aw8';
  feedbackLinkEl.target = '_blank';
  feedbackLinkEl.rel = 'noopener noreferrer';
  feedbackLinkEl.textContent = 'Send feedback 💬';

  const coffeeLinkEl = document.createElement('a');
  coffeeLinkEl.href = 'https://ko-fi.com/lany_';
  coffeeLinkEl.target = '_blank';
  coffeeLinkEl.rel = 'noopener noreferrer';
  coffeeLinkEl.textContent = 'Buy me a coffee ☕';

  infoPanelEl.appendChild(feedbackLinkEl);
  infoPanelEl.appendChild(coffeeLinkEl);
  ensureInfoPanelGlobalListeners();

  const topActionsEl = document.createElement('div');
  topActionsEl.className = 'topActions';
  topActionsEl.setAttribute('data-role', 'topActions');
  topActionsEl.appendChild(infoBtnEl);
  topActionsEl.appendChild(closeBtnEl);

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

  playlistBtnEl = document.createElement('button');
  playlistBtnEl.type = 'button';
  playlistBtnEl.className = 'playlistToggle';
  playlistBtnEl.setAttribute('data-role', 'playlistToggle');
  playlistBtnEl.title = 'Show playlist';
  playlistBtnEl.setAttribute('aria-label', 'Toggle playlist');

  const playlistGlyphEl = document.createElement('span');
  playlistGlyphEl.className = 'playlistToggleGlyph';
  const playlistGlyphLine1El = document.createElement('span');
  playlistGlyphLine1El.className = 'line line1';
  const playlistGlyphLine2El = document.createElement('span');
  playlistGlyphLine2El.className = 'line line2';
  const playlistGlyphLine3El = document.createElement('span');
  playlistGlyphLine3El.className = 'line line3';
  playlistGlyphEl.appendChild(playlistGlyphLine1El);
  playlistGlyphEl.appendChild(playlistGlyphLine2El);
  playlistGlyphEl.appendChild(playlistGlyphLine3El);

  const playlistLabelEl = document.createElement('span');
  playlistLabelEl.className = 'playlistToggleLabel';
  playlistLabelEl.setAttribute('data-role', 'playlistToggleLabel');
  playlistLabelEl.textContent = '';

  playlistBtnEl.appendChild(playlistGlyphEl);
  playlistBtnEl.appendChild(playlistLabelEl);
  playlistBtnEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof currentHandlers.onTogglePlaylist === 'function') {
        currentHandlers.onTogglePlaylist();
      }
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
  transportRowEl.appendChild(playlistBtnEl);

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

  playlistWrapEl = document.createElement('div');
  playlistWrapEl.className = 'playlistWrap';
  playlistWrapEl.setAttribute('data-role', 'playlistWrap');

  const playlistHeadEl = document.createElement('div');
  playlistHeadEl.className = 'playlistHead';

  const playlistHeadTitleEl = document.createElement('button');
  playlistHeadTitleEl.type = 'button';
  playlistHeadTitleEl.className = 'playlistHeadBtn track sortable';
  playlistHeadTitleEl.setAttribute('data-role', 'playlistHeadTrackSort');
  playlistHeadTitleEl.textContent = 'Track';
  playlistHeadTitleEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setPlaylistSort('track');
    },
    true
  );

  const playlistHeadBpmEl = document.createElement('button');
  playlistHeadBpmEl.type = 'button';
  playlistHeadBpmEl.className = 'playlistHeadBtn bpm sortable';
  playlistHeadBpmEl.setAttribute('data-role', 'playlistHeadBpmSort');
  playlistHeadBpmEl.textContent = 'BPM';
  playlistHeadBpmEl.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setPlaylistSort('bpm');
    },
    true
  );

  const playlistHeadTimeEl = document.createElement('span');
  playlistHeadTimeEl.className = 'timeHead';
  playlistHeadTimeEl.textContent = 'Time';

  playlistHeadEl.appendChild(playlistHeadTitleEl);
  playlistHeadEl.appendChild(playlistHeadBpmEl);
  playlistHeadEl.appendChild(playlistHeadTimeEl);

  playlistScrollEl = document.createElement('div');
  playlistScrollEl.className = 'playlistScroll';
  playlistScrollEl.setAttribute('data-role', 'playlistScroll');

  const playlistViewportEl = document.createElement('div');
  playlistViewportEl.className = 'playlistViewport';

  playlistBodyEl = document.createElement('div');
  playlistBodyEl.className = 'playlistBody';
  playlistBodyEl.setAttribute('data-role', 'playlistBody');

  playlistStatusEl = document.createElement('div');
  playlistStatusEl.className = 'playlistStatus';
  playlistStatusEl.setAttribute('data-role', 'playlistStatus');
  playlistStatusEl.textContent = '';

  playlistViewportEl.appendChild(playlistHeadEl);
  playlistScrollEl.appendChild(playlistBodyEl);
  playlistViewportEl.appendChild(playlistScrollEl);
  playlistWrapEl.appendChild(playlistViewportEl);
  playlistWrapEl.appendChild(playlistStatusEl);

  noteEl = document.createElement('div');
  noteEl.className = 'note';
  noteEl.setAttribute('data-role', 'note');
  noteEl.textContent = '';
  noteEl.style.display = 'none';

  inner.appendChild(topActionsEl);
  inner.appendChild(infoPanelEl);
  inner.appendChild(topRowEl);
  inner.appendChild(trackTitleEl);
  inner.appendChild(waveformWrapEl);
  inner.appendChild(transportRowEl);
  inner.appendChild(lower);
  inner.appendChild(playlistWrapEl);
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

/**
 * Render or update the floating panel from the latest player/analysis state.
 */
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

  const tapTrackKey = computeTapTrackKey(input?.trackKey || '', artistName, trackTitle, fallbackTitle);
  if (tapTrackKey && tapTrackKey !== lastTapTrackKey) {
    resetTapper();
  }
  if (tapTrackKey) {
    lastTapTrackKey = tapTrackKey;
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
  const prevPlaylistIndex = currentPlaylistIndex;
  const prevPlaylistExpanded = currentPlaylistExpanded;
  currentPlaylistRows = Array.isArray(input?.playlistTracks) ? input.playlistTracks : [];
  currentPlaylistIndex = Number.isFinite(input?.playlistCurrentIndex) ? Number(input.playlistCurrentIndex) : -1;
  currentPlaylistExpanded = Boolean(input?.playlistExpanded);
  currentPlaylistLoading = Boolean(input?.playlistLoading);

  const indexChangedToValid = Number.isFinite(currentPlaylistIndex) && currentPlaylistIndex >= 0 && prevPlaylistIndex !== currentPlaylistIndex;
  const playlistOpened = currentPlaylistExpanded && !prevPlaylistExpanded;
  if (indexChangedToValid && currentIsPlaying) {
    const isExpectedPlaylistClickTarget =
      Number.isFinite(playlistClickTargetIndex) && playlistClickTargetIndex >= 0 && currentPlaylistIndex === playlistClickTargetIndex;
    if (skipNextAutoCenterFromPlaylistClick && (isExpectedPlaylistClickTarget || playlistClickTargetIndex < 0)) {
      pendingPlaylistAutoCenter = false;
      skipNextAutoCenterFromPlaylistClick = false;
      playlistClickTargetIndex = -1;
    } else {
      pendingPlaylistAutoCenter = true;
      skipNextAutoCenterFromPlaylistClick = false;
      playlistClickTargetIndex = -1;
    }
  } else if (playlistOpened) {
    pendingPlaylistAutoCenter = true;
  }

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
