/**
 * Bandcamp player content script.
 *
 * Responsibilities:
 * - Detect and track the active Bandcamp `<audio>` element
 * - Bridge user actions (play/seek/skip) to native player controls
 * - Request analysis from background and consume progressive updates
 * - Assemble state for the floating results panel UI
 *
 * Design notes:
 * - Keeps rendering lightweight via scheduled animation-frame updates
 * - Uses runtime messaging wrappers compatible with Chrome + Firefox APIs
 *
 * @module content-scripts/bandcamp-player
 */

import showResultsPanel from '../ui/results-panel';
import { getTrackMeta } from './metadata-extractor';
import type { BeatMode } from '../shared/index';

interface WaveformData {
  peaksLow?: number[];
  peaksMid?: number[];
  peaksHigh?: number[];
  peaks?: number[];
  duration?: number;
  buckets?: number;
}

interface AnalysisResult {
  bpm?: number;
  confidence?: number;
  beatMode?: BeatMode;
  beatTypeAuto?: string;
  breakbeatScore?: number;
  note?: string;
  waveform?: WaveformData | null;
  waveformStatus?: string;
  error?: string;
  ts?: number;
}

interface AnalysisPartialMessage extends Partial<AnalysisResult> {
  type: 'ANALYSIS_PARTIAL';
  url: string;
}

interface PanelState {
  title: string;
  artistName: string;
  trackTitle: string;
  trackKey: string;
  tempoScale: number;
  beatMode: BeatMode;
  isPlaying: boolean;
  playheadFraction: number;
  currentTimeSec: number;
  durationSec: number;
  isAnalyzing: boolean;
  bpm?: number;
  confidence?: number;
  note?: string;
  waveform: WaveformData | null;
  waveformStatus: string;
}

interface PanelCallbacks {
  onTogglePlayPause: () => void;
  onSeekToFraction: (fraction: number) => void;
  onPrevTrack: () => void;
  onNextTrack: () => void;
}

interface BandcampTrackInfo {
  track_id?: number;
  id?: number;
  is_playing?: boolean;
  file?: Record<string, string>;
}

interface BandcampTralbumData {
  current?: {
    type?: 'track' | 'album';
  };
  trackinfo?: BandcampTrackInfo[];
}

interface PreloadTrackTarget {
  url: string;
  cacheKey: string;
}

type RuntimeApi = {
  runtime?: {
    sendMessage?: (...args: any[]) => any;
    onMessage?: {
      addListener?: (cb: (msg: any, sender: any, sendResponse: (response?: any) => void) => void | boolean) => void;
    };
  };
};

const api: RuntimeApi | null = (() => {
  const g = globalThis as any;
  if (g.chrome?.runtime) return g.chrome as RuntimeApi;
  if (g.browser?.runtime) return g.browser as RuntimeApi;
  return null;
})();

let beatMode: BeatMode = 'auto';
let tempoScale = 1.0;
let activeAudio: HTMLAudioElement | null = null;
let currentSrc = '';
let lastAnalysis: AnalysisResult | null = null;
let analysisInFlight = false;
let analysisRunId = 0;
let activeAnalysisSrc = '';
let preloadQueue: PreloadTrackTarget[] = [];
let preloadInFlight = false;
let preloadRunId = 0;
let activePreloadSrc = '';
let pendingSeekFraction: number | null = null;
let renderScheduled = false;
let rafId = 0;
const audioBound = new WeakSet<HTMLAudioElement>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(s: string | null | undefined): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function canMessage(): boolean {
  return Boolean(api?.runtime?.sendMessage);
}

function sendRuntimeMessage<T = any>(message: any): Promise<T> {
  if (!canMessage()) {
    return Promise.reject(new Error('Runtime messaging API not available'));
  }

  const sendMessage = api!.runtime!.sendMessage!;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const resolveOnce = (value: T) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const rejectOnce = (error: any) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    try {
      const maybePromise = sendMessage(message, (response: T) => {
        const lastErr = (globalThis as any)?.chrome?.runtime?.lastError;
        if (lastErr) {
          rejectOnce(new Error(lastErr.message || String(lastErr)));
          return;
        }
        resolveOnce(response);
      });

      if (maybePromise && typeof maybePromise.then === 'function') {
        (maybePromise as Promise<T>).then(resolveOnce).catch(rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function cancelAnalysis(url?: string): Promise<void> {
  if (!canMessage()) return;
  try {
    await sendRuntimeMessage({
      type: 'CANCEL_ANALYSIS',
      url,
    });
  } catch (_) {
    // Ignore cancellation errors.
  }
}

function onSourceChanged(nextSrc: string): void {
  if (nextSrc === currentSrc) return;
  if (activeAnalysisSrc && activeAnalysisSrc !== nextSrc) {
    void cancelAnalysis(activeAnalysisSrc);
  }
  if (activePreloadSrc && activePreloadSrc !== nextSrc) {
    void cancelAnalysis(activePreloadSrc);
  }
  analysisRunId += 1;
  preloadRunId += 1;
  activeAnalysisSrc = '';
  activePreloadSrc = '';
  analysisInFlight = false;
  preloadInFlight = false;
  preloadQueue = [];
  currentSrc = nextSrc;
  lastAnalysis = null;
}

function extractDataAttribute(selector: string, attr: string): any | null {
  const element = document.querySelector(selector);
  if (!element) return null;
  const raw = element.getAttribute(attr);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getTralbumData(): BandcampTralbumData | null {
  return extractDataAttribute('script[data-tralbum]', 'data-tralbum') as BandcampTralbumData | null;
}

function extractTrackIdFromSrc(src: string): string {
  const m = String(src || '').match(/\/(\d+)(?:\?|$)/);
  return m?.[1] || '';
}

function normalizeTrackUrl(raw: string): string {
  const url = String(raw || '').trim();
  if (!url) return '';
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return '';
  }
}

function pickTrackFileUrl(file?: Record<string, string>): string {
  if (!file || typeof file !== 'object') return '';
  const preferred = ['mp3-128', 'mp3-v0', 'aac-hi'];
  for (const key of preferred) {
    const normalized = normalizeTrackUrl(file[key] || '');
    if (normalized) return normalized;
  }
  for (const value of Object.values(file)) {
    const normalized = normalizeTrackUrl(value || '');
    if (normalized) return normalized;
  }
  return '';
}

function getCurrentTrackIndex(tracks: BandcampTrackInfo[], currentAudioSrc: string): number {
  const currentTrackId = extractTrackIdFromSrc(currentAudioSrc);
  let index = -1;
  if (currentTrackId) {
    index = tracks.findIndex(
      (t) => String(t?.track_id ?? '') === currentTrackId || String(t?.id ?? '') === currentTrackId
    );
  }

  if (index < 0) {
    const normalizedCurrent = normalizeTrackUrl(currentAudioSrc);
    if (normalizedCurrent) {
      index = tracks.findIndex((t) => pickTrackFileUrl(t?.file) === normalizedCurrent);
    }
  }

  if (index < 0) {
    index = tracks.findIndex((t) => Boolean(t?.is_playing));
  }

  return index;
}

function getTrackStableCacheKey(currentAudioSrc: string): string {
  const tralbum = getTralbumData();
  const tracks = Array.isArray(tralbum?.trackinfo) ? tralbum.trackinfo : [];

  if (tracks.length) {
    const index = getCurrentTrackIndex(tracks, currentAudioSrc);
    if (index >= 0) {
      const track = tracks[index];
      const trackId = String(track?.track_id ?? track?.id ?? '').trim();
      if (trackId) return `bandcamp-track-id:${trackId}`;
      const trackUrl = pickTrackFileUrl(track?.file);
      if (trackUrl) return `bandcamp-track-url:${trackUrl}`;
    }
  }

  const srcTrackId = extractTrackIdFromSrc(currentAudioSrc);
  if (srcTrackId) return `stream-track-id:${srcTrackId}`;

  const normalized = normalizeTrackUrl(currentAudioSrc);
  if (normalized) return `stream-url:${normalized}`;

  return '';
}

function getTrackCacheKey(track: BandcampTrackInfo, fallbackUrl: string): string {
  const trackId = String(track?.track_id ?? track?.id ?? '').trim();
  if (trackId) return `bandcamp-track-id:${trackId}`;

  const trackUrl = pickTrackFileUrl(track?.file);
  if (trackUrl) return `bandcamp-track-url:${trackUrl}`;

  const srcTrackId = extractTrackIdFromSrc(fallbackUrl);
  if (srcTrackId) return `stream-track-id:${srcTrackId}`;

  const normalized = normalizeTrackUrl(fallbackUrl);
  if (normalized) return `stream-url:${normalized}`;

  return '';
}

function isAlbumPage(): boolean {
  return window.location.pathname.includes('/album/');
}

function buildPreloadQueue(currentAudioSrc: string): PreloadTrackTarget[] {
  if (!isAlbumPage()) return [];

  const tralbum = getTralbumData();
  const tracks = Array.isArray(tralbum?.trackinfo) ? tralbum.trackinfo : [];
  if (!tracks.length) return [];

  const currentIndex = getCurrentTrackIndex(tracks, currentAudioSrc);
  const normalizedCurrent = normalizeTrackUrl(currentAudioSrc);
  const ordered =
    currentIndex >= 0
      ? [...tracks.slice(currentIndex + 1), ...tracks.slice(0, currentIndex)]
      : tracks;

  const queue: PreloadTrackTarget[] = [];
  const seen = new Set<string>();

  for (const track of ordered) {
    const url = pickTrackFileUrl(track?.file);
    if (!url) continue;
    if (url === normalizedCurrent) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    queue.push({
      url,
      cacheKey: getTrackCacheKey(track, url),
    });
  }

  return queue;
}

function stopPreloadWorker(): void {
  preloadRunId += 1;
  preloadInFlight = false;
  preloadQueue = [];
  if (activePreloadSrc) {
    void cancelAnalysis(activePreloadSrc);
    activePreloadSrc = '';
  }
}

function maybeKickoffPreload(): void {
  if (!canMessage()) return;
  if (!isAlbumPage()) return;
  if (!currentSrc) return;
  if (analysisInFlight) return;
  if (preloadInFlight) return;

  const el = ensureActiveAudio();
  if (!isPlayingNow(el)) return;

  if (!preloadQueue.length) {
    preloadQueue = buildPreloadQueue(currentSrc);
  }
  if (!preloadQueue.length) return;

  const target = preloadQueue.shift();
  if (!target?.url) return;

  const runId = preloadRunId;
  preloadInFlight = true;
  activePreloadSrc = target.url;

  void sendRuntimeMessage<AnalysisResult>({
    type: 'ANALYZE_TRACK',
    url: target.url,
    beatMode,
    cacheKey: target.cacheKey,
  })
    .then(() =>
      sendRuntimeMessage<WaveformData>({
        type: 'GETWAVEFORM',
        url: target.url,
      }).catch(() => {
        // Ignore waveform preload errors.
      })
    )
    .catch(() => {
      // Ignore preload errors and continue queueing.
    })
    .finally(() => {
      if (runId !== preloadRunId) return;
      preloadInFlight = false;
      activePreloadSrc = '';
      setTimeout(() => {
        if (runId !== preloadRunId) return;
        maybeKickoffPreload();
      }, 0);
    });
}

function pickActiveAudio(): HTMLAudioElement | null {
  if (activeAudio && document.contains(activeAudio)) return activeAudio;

  const audios = Array.from(document.querySelectorAll('audio'));
  if (!audios.length) return null;

  const playing = audios.find((a) => !a.paused && (a.currentSrc || a.src));
  if (playing) return playing;

  const ready = audios.find((a) => (a.currentSrc || a.src) && a.readyState > 0);
  if (ready) return ready;

  const withSrc = audios.find((a) => (a.currentSrc || a.src));
  if (withSrc) return withSrc;

  return audios[0] || null;
}

function getAudioSrc(el: HTMLAudioElement | null): string {
  if (!el) return '';
  return String(el.currentSrc || el.src || '').trim();
}

function isPlayingNow(el: HTMLAudioElement | null): boolean {
  if (!el) return false;
  return !el.paused && !el.ended;
}

function getPlayheadFraction(el: HTMLAudioElement | null): number {
  if (!el) return NaN;
  const dur = Number.isFinite(el.duration) ? el.duration : NaN;
  const cur = Number.isFinite(el.currentTime) ? el.currentTime : NaN;
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(cur)) return NaN;
  return cur / dur;
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;

  requestAnimationFrame(() => {
    renderScheduled = false;
    renderPanel();
  });
}

function startRafPlayheadLoop(): void {
  if (rafId) return;

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!activeAudio || !isPlayingNow(activeAudio)) return;
    renderPanel();
  };

  rafId = requestAnimationFrame(tick);
}

function stopRafPlayheadLoop(): void {
  if (!rafId) return;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

function bindAudio(el: HTMLAudioElement): void {
  if (audioBound.has(el)) return;
  audioBound.add(el);

  const onAny = () => scheduleRender();
  el.addEventListener('play', onAny);
  el.addEventListener('pause', onAny);
  el.addEventListener('ended', onAny);
  el.addEventListener('timeupdate', onAny);
  el.addEventListener('seeking', onAny);
  el.addEventListener('seeked', onAny);
  el.addEventListener('durationchange', onAny);
  el.addEventListener('emptied', onAny);

  el.addEventListener('loadedmetadata', () => {
    if (pendingSeekFraction === null) return;
    const fraction = pendingSeekFraction;
    pendingSeekFraction = null;
    seekToFraction(el, fraction);
    scheduleRender();
  });
}

function ensureActiveAudio(): HTMLAudioElement | null {
  const el = pickActiveAudio();
  if (!el) return null;

  if (activeAudio !== el) {
    activeAudio = el;
    bindAudio(activeAudio);

    const src = getAudioSrc(activeAudio);
    if (src !== currentSrc) {
      onSourceChanged(src);
      if (currentSrc) {
        void analyzeCurrentTrack();
      }
    }
  }

  return activeAudio;
}

function tryClickBandcampPlayButton(): void {
  const selectors = ['.playbutton', '#big_play_button', '[data-bind*="play"]'];

  for (const selector of selectors) {
    const btn = document.querySelector(selector) as HTMLElement | null;
    if (btn && typeof btn.click === 'function') {
      btn.click();
      return;
    }
  }
}

function togglePlayPause(): void {
  const el = ensureActiveAudio();

  if (!el) {
    tryClickBandcampPlayButton();
    return;
  }

  if (el.paused) {
    const maybePromise = el.play();
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {
        tryClickBandcampPlayButton();
      });
    }
    startRafPlayheadLoop();
  } else {
    el.pause();
    stopRafPlayheadLoop();
  }

  scheduleRender();
}

function seekToFraction(el: HTMLAudioElement | null, fraction: number): void {
  if (!el) return;

  const f = Math.max(0, Math.min(1, Number(fraction)));
  if (!Number.isFinite(f)) return;

  const dur = Number.isFinite(el.duration) ? el.duration : NaN;
  if (!Number.isFinite(dur) || dur <= 0) {
    pendingSeekFraction = f;
    return;
  }

  const t = f * dur;
  try {
    if (typeof el.fastSeek === 'function') {
      el.fastSeek(t);
    } else {
      el.currentTime = t;
    }
  } catch (_) {
    pendingSeekFraction = f;
    setTimeout(() => {
      if (pendingSeekFraction === null) return;
      const retry = pendingSeekFraction;
      pendingSeekFraction = null;
      seekToFraction(el, retry);
    }, 120);
  }

  scheduleRender();
}

function findTrackRows(): HTMLElement[] {
  const selectors = [
    '.track_list .track_row',
    '.tracklist .trackrow',
    '#track_list .track_row',
    '#tracklist .trackrow',
    'table.track_list tr.track_row_view',
    'tr.track_row_view',
  ];

  const rows: HTMLElement[] = [];
  for (const selector of selectors) {
    const els = document.querySelectorAll(selector);
    els.forEach((el) => {
      if (el.querySelector('a, .title, .track-title, .track_title')) {
        rows.push(el as HTMLElement);
      }
    });
  }

  return rows;
}

function findCurrentTrackRow(): HTMLElement | null {
  const selectors = [
    '.track_list .track_row.playing',
    '.track_list .track_row.current',
    '.track_list .track_row.now_playing',
    '.tracklist .trackrow.playing',
    '.tracklist .trackrow.current',
    '.tracklist .trackrow.nowplaying',
    'table.track_list tr.track_row_view.current_track',
    'tr.track_row_view.current_track',
    'table.track_list tr.track_row_view.playing',
    'tr.track_row_view.playing',
  ];

  for (const selector of selectors) {
    const row = document.querySelector(selector);
    if (row) return row as HTMLElement;
  }

  return null;
}

function clickPlayOnRow(row: HTMLElement | null): boolean {
  if (!row) return false;

  const selectors = [
    '.play_col .play_status',
    '.play_col .playbutton',
    '.play_col a',
    '.playbutton',
    'button.playbutton',
    'a.playbutton',
    'a',
  ];

  for (const selector of selectors) {
    const btn = row.querySelector(selector) as HTMLElement | null;
    if (btn && typeof btn.click === 'function') {
      try {
        btn.click();
        return true;
      } catch (_) {
        // Try next selector.
      }
    }
  }

  try {
    row.click();
    return true;
  } catch (_) {
    return false;
  }
}

function clickGlobalPrevNext(direction: number): boolean {
  const nextSelectors = [
    '.inline_player .nextbutton',
    '.inline_player .next',
    '.inlineplayer .nextbutton',
    '.inlineplayer .next',
    '.play_controls .nextbutton',
    '.play_controls .next',
    '.player .nextbutton',
    '.player .next',
    '[data-bind*="next"]',
  ];

  const prevSelectors = [
    '.inline_player .prevbutton',
    '.inline_player .prev',
    '.inlineplayer .prevbutton',
    '.inlineplayer .prev',
    '.play_controls .prevbutton',
    '.play_controls .prev',
    '.player .prevbutton',
    '.player .prev',
    '[data-bind*="prev"]',
    '[data-bind*="previous"]',
  ];

  const selectors = direction > 0 ? nextSelectors : prevSelectors;

  for (const selector of selectors) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el && typeof el.click === 'function') {
      try {
        el.click();
        return true;
      } catch (_) {
        // Continue to fallback selectors.
      }
    }
  }

  return false;
}

function skipTrack(direction: number): void {
  if (clickGlobalPrevNext(direction)) {
    setTimeout(() => {
      ensureActiveAudio();
      scheduleRender();
    }, 50);
    return;
  }

  const rows = findTrackRows();
  if (!rows.length) return;

  const currentRow = findCurrentTrackRow();
  const currentIndex = currentRow ? rows.indexOf(currentRow) : -1;
  const nextIndex =
    currentIndex < 0
      ? direction > 0
        ? 0
        : rows.length - 1
      : (currentIndex + direction + rows.length) % rows.length;

  if (clickPlayOnRow(rows[nextIndex])) {
    setTimeout(() => {
      ensureActiveAudio();
      scheduleRender();
    }, 50);
  }
}

function listenForPartialUpdates(): void {
  const listener = api?.runtime?.onMessage?.addListener;
  if (!listener) return;

  listener((msg: AnalysisPartialMessage) => {
    try {
      if (!msg || msg.type !== 'ANALYSIS_PARTIAL') return;
      if (!msg.url || msg.url !== currentSrc) return;

      const { type: _type, url: _url, ...partial } = msg;
      lastAnalysis = { ...(lastAnalysis || {}), ...partial };
      scheduleRender();
    } catch (error) {
      console.warn('[Player] Failed to handle ANALYSIS_PARTIAL:', error);
    }
  });
}

async function analyzeCurrentTrack(): Promise<void> {
  const el = ensureActiveAudio();
  if (!el || !canMessage()) return;

  const src = getAudioSrc(el);
  if (!src) return;
  if (analysisInFlight && src === activeAnalysisSrc) return;
  if (analysisInFlight && activeAnalysisSrc && activeAnalysisSrc !== src) {
    void cancelAnalysis(activeAnalysisSrc);
  }
  if (preloadInFlight && activePreloadSrc && activePreloadSrc !== src) {
    void cancelAnalysis(activePreloadSrc);
    preloadRunId += 1;
    preloadInFlight = false;
    activePreloadSrc = '';
  }

  const runId = ++analysisRunId;
  activeAnalysisSrc = src;
  analysisInFlight = true;
  scheduleRender();

  try {
    const cacheKey = getTrackStableCacheKey(src);
    const result = await sendRuntimeMessage<AnalysisResult>({
      type: 'ANALYZE_TRACK',
      url: src,
      beatMode,
      cacheKey,
    });

    if (runId !== analysisRunId || src !== currentSrc) return;
    if ((result as any)?.cancelled) return;
    lastAnalysis = result || null;

    if (lastAnalysis && !lastAnalysis.waveform && !lastAnalysis.waveformStatus) {
      lastAnalysis = {
        ...lastAnalysis,
        waveformStatus: 'Computing waveform…',
      };
    }

    if (!lastAnalysis?.waveform) {
      const fallbackUrl = src;
      setTimeout(async () => {
        try {
          if (runId !== analysisRunId) return;
          if (fallbackUrl !== currentSrc || lastAnalysis?.waveform) return;

          const waveform = await sendRuntimeMessage<WaveformData>({
            type: 'GETWAVEFORM',
            url: fallbackUrl,
          });

          if (waveform && (waveform.peaksLow || waveform.peaks)) {
            if (runId !== analysisRunId) return;
            lastAnalysis = {
              ...(lastAnalysis || {}),
              waveform,
              waveformStatus: '',
            };
            scheduleRender();
          }
        } catch (error) {
          console.warn('[Player] Deferred waveform fetch failed:', error);
        }
      }, 5000);
    }
  } catch (error) {
    if (runId !== analysisRunId || src !== currentSrc) return;
    lastAnalysis = {
      error: String((error as Error)?.message || error),
      waveformStatus: 'Analysis failed',
      ts: Date.now(),
    };
  } finally {
    if (runId === analysisRunId) {
      analysisInFlight = false;
      activeAnalysisSrc = '';
      scheduleRender();
      maybeKickoffPreload();
    }
  }
}

function buildPanelState(): PanelState {
  const el = ensureActiveAudio();
  const meta = getTrackMeta();

  const title = meta.combined || norm(document.title) || '---';
  const isPlaying = isPlayingNow(el);
  const playheadFraction = getPlayheadFraction(el);

  if (isPlaying) startRafPlayheadLoop();
  else stopRafPlayheadLoop();

  const src = getAudioSrc(el);
  if (src && src !== currentSrc) {
    onSourceChanged(src);
    void analyzeCurrentTrack();
  } else if (isPlaying) {
    maybeKickoffPreload();
  } else {
    stopPreloadWorker();
  }

  const waveformStatus = analysisInFlight ? 'Analyzing…' : lastAnalysis?.waveformStatus || '';

  return {
    title,
    artistName: meta.artistName,
    trackTitle: meta.trackTitle,
    trackKey: getTrackStableCacheKey(src) || src || `${norm(meta.artistName)}|${norm(meta.trackTitle)}|${title}`,
    tempoScale,
    beatMode,
    isPlaying,
    playheadFraction,
    currentTimeSec: el && Number.isFinite(el.currentTime) ? el.currentTime : NaN,
    durationSec: el && Number.isFinite(el.duration) ? el.duration : NaN,
    isAnalyzing: analysisInFlight,
    bpm: lastAnalysis?.bpm,
    confidence: lastAnalysis?.confidence,
    note: lastAnalysis?.note,
    waveform: lastAnalysis?.waveform || null,
    waveformStatus,
  };
}

function renderPanel(): void {
  const state = buildPanelState();

  const callbacks: PanelCallbacks = {
    onTogglePlayPause: () => togglePlayPause(),
    onSeekToFraction: (fraction: number) => {
      const audio = ensureActiveAudio();
      if (!audio) return;
      seekToFraction(audio, fraction);
    },
    onPrevTrack: () => skipTrack(-1),
    onNextTrack: () => skipTrack(1),
  };

  showResultsPanel(state, callbacks);
}

async function restoreBeatMode(): Promise<void> {
  if (!canMessage()) return;

  try {
    const result = await sendRuntimeMessage<{ beatMode?: BeatMode }>({ type: 'GETBEATMODE' });
    if (result && typeof result.beatMode === 'string') {
      const mode = result.beatMode;
      beatMode = mode === 'straight' || mode === 'breakbeat' || mode === 'auto' ? mode : 'auto';
    }
  } catch (error) {
    console.warn('[Player] Failed to restore beat mode:', error);
  }
}

function listenForPlayEvents(): void {
  document.addEventListener(
    'play',
    (event) => {
      const target = event.target;
      if (!target || (target as HTMLElement).tagName !== 'AUDIO') return;

      activeAudio = target as HTMLAudioElement;
      bindAudio(activeAudio);

      const src = getAudioSrc(activeAudio);
      if (src !== currentSrc) {
        onSourceChanged(src);
        if (currentSrc) {
          void analyzeCurrentTrack();
        }
      } else {
        maybeKickoffPreload();
      }

      scheduleRender();
    },
    true
  );
}

async function waitForAudio(timeoutMs = 20000): Promise<void> {
  const stepMs = 250;
  const iterations = Math.ceil(timeoutMs / stepMs);

  for (let i = 0; i < iterations; i += 1) {
    if (pickActiveAudio()) return;
    await sleep(stepMs);
  }
}

async function init(): Promise<void> {
  console.log('[Player] Initializing Bandcamp player integration');

  listenForPartialUpdates();
  listenForPlayEvents();
  await restoreBeatMode();
  await waitForAudio();

  ensureActiveAudio();
  scheduleRender();

  console.log('[Player] Initialization complete');
}

void init();
