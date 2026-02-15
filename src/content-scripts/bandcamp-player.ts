/**
 * ============================================================================
 * BANDCAMP PLAYER INTEGRATION - TYPESCRIPT VERSION
 * ============================================================================
 * 
 * VERSION: 2.0 (2026-02-15)
 * 
 * @module content-scripts/bandcamp-player
 * @version 2026-02-15-v2.0
 * ============================================================================
 */

import showResultsPanel from '../ui/results-panel.js';
import { getTrackMeta } from './metadata-extractor';

/* ============================================================================
 * TYPE DEFINITIONS
 * ============================================================================ */

interface AnalysisResult {
  bpm?: number;
  confidence?: number;
  keyConfidence?: number;
  note?: string;
  waveform?: WaveformData | null;
  waveformStatus?: string;
  error?: string;
}

interface WaveformData {
  peaksLow?: number[];
  peaksMid?: number[];
  peaksHigh?: number[];
  peaks?: number[];
  duration?: number;
  buckets?: number;
}

interface PanelState {
  title: string;
  artistName: string;
  trackTitle: string;
  beatportQuery: string;
  tempoScale: number;
  beatMode: BeatMode;
  isPlaying: boolean;
  playheadFraction: number;
  currentTimeSec: number;
  durationSec: number;
  isAnalyzing: boolean;
  bpm?: number;
  confidence?: number;
  keyName: string;
  camelot: string;
  keyConfidence?: number;
  note?: string;
  waveform: WaveformData | null;
  waveformStatus: string;
}

interface PanelCallbacks {
  onOpenBeatportSearch: (query: string) => void;
  onTogglePlayPause: () => void;
  onSeekToFraction: (fraction: number) => void;
  onPrevTrack: () => void;
  onNextTrack: () => void;
  onSetBeatMode: (mode: BeatMode) => void;
  onSetTempoScale: (scale: number) => void;
}

type BeatMode = 'auto' | 'straight' | 'breakbeat';

/* ============================================================================
 * BROWSER API POLYFILL
 * ============================================================================ */

// Fix type issues by casting to chrome API
const api = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

/* ============================================================================
 * UTILITY FUNCTIONS
 * ============================================================================ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function norm(s: string | null | undefined): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/* ============================================================================
 * EXTERNAL SEARCH INTEGRATION
 * ============================================================================ */

function openBeatportSearch(query: string): void {
  const q = String(query || '').trim();
  if (!q) return;
  
  const url = `https://www.beatport.com/search/tracks?q=${encodeURIComponent(q)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* ============================================================================
 * STATE MANAGEMENT
 * ============================================================================ */

let beatMode: BeatMode = 'auto';
let tempoScale = 1.0;
let activeAudio: HTMLAudioElement | null = null;
const audioBound = new WeakSet<HTMLAudioElement>();
let currentSrc = '';
let lastAnalysis: AnalysisResult | null = null;
let analysisInFlight = false;
let pendingSeekFraction: number | null = null;
let renderScheduled = false;
let rafId = 0;

/* ============================================================================
 * AUDIO ELEMENT DETECTION & MANAGEMENT
 * ============================================================================ */

function pickActiveAudio(): HTMLAudioElement | null {
  if (activeAudio && document.contains(activeAudio)) {
    return activeAudio;
  }

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

function getPlayheadFraction(el: HTMLAudioElement | null): number {
  if (!el) return NaN;
  
  const dur = Number.isFinite(el.duration) ? el.duration : NaN;
  const cur = Number.isFinite(el.currentTime) ? el.currentTime : NaN;
  
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(cur)) {
    return NaN;
  }
  
  return cur / dur;
}

function isPlayingNow(el: HTMLAudioElement | null): boolean {
  if (!el) return false;
  return !el.paused && !el.ended;
}

function bindAudio(el: HTMLAudioElement): void {
  if (!el || audioBound.has(el)) return;

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
    if (pendingSeekFraction !== null) {
      const fraction = pendingSeekFraction;
      pendingSeekFraction = null;
      seekToFraction(el, fraction);
      scheduleRender();
    }
  });
}

function ensureActiveAudio(): HTMLAudioElement | null {
  const el = pickActiveAudio();
  if (!el) return null;

  if (activeAudio !== el) {
    activeAudio = el;
    bindAudio(activeAudio);
    
    const newSrc = getAudioSrc(activeAudio);
    if (newSrc !== currentSrc) {
      currentSrc = newSrc;
      lastAnalysis = null;
      if (currentSrc) {
        analyzeCurrentTrack();
      }
    }
  }

  return activeAudio;
}

/* ============================================================================
 * RENDERING & RAF LOOP
 * ============================================================================ */

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
    
    if (!activeAudio || !isPlayingNow(activeAudio)) {
      return;
    }
    
    renderPanel();
  };

  rafId = requestAnimationFrame(tick);
}

function stopRafPlayheadLoop(): void {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

/* ============================================================================
 * PLAYBACK CONTROLS
 * ============================================================================ */

function tryClickBandcampPlayButton(): void {
  const selectors = [
    '.playbutton',
    '#big_play_button',
    '[data-bind*="play"]',
  ];

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
    const playPromise = el.play();
    
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
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

  const targetTime = f * dur;

  try {
    if (typeof el.fastSeek === 'function') {
      el.fastSeek(targetTime);
    } else {
      el.currentTime = targetTime;
    }
  } catch (error) {
    pendingSeekFraction = f;
    setTimeout(() => {
      if (pendingSeekFraction !== null) {
        const retryFraction = pendingSeekFraction;
        pendingSeekFraction = null;
        seekToFraction(el, retryFraction);
      }
    }, 120);
  }

  scheduleRender();
}

/* ============================================================================
 * TRACK NAVIGATION
 * ============================================================================ */

function findTrackRows(): HTMLElement[] {
  const selectors = [
    '.track_list .track_row',
    '.tracklist .trackrow',
    '#track_list .track_row',
    '#tracklist .trackrow',
  ];

  const rows: HTMLElement[] = [];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el) => {
      if (el && el.querySelector) {
        const hasContent = el.querySelector('a, .title, .track-title, .track_title');
        if (hasContent) {
          rows.push(el as HTMLElement);
        }
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
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el as HTMLElement;
  }

  return null;
}

function clickPlayOnRow(row: HTMLElement | null): boolean {
  if (!row) return false;

  const playSelectors = [
    '.play_col .play_status',
    '.play_col .playbutton',
    '.play_col a',
    '.playbutton',
    'button.playbutton',
    'a.playbutton',
    'a',
  ];

  for (const selector of playSelectors) {
    const btn = row.querySelector(selector) as HTMLElement | null;
    if (btn && typeof btn.click === 'function') {
      try {
        btn.click();
        return true;
      } catch (error) {
        // Continue to next selector
      }
    }
  }

  try {
    row.click();
    return true;
  } catch (error) {
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
      } catch (error) {
        // Continue
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
  let currentIndex = currentRow ? rows.indexOf(currentRow) : -1;

  const nextIndex =
    currentIndex < 0
      ? (direction > 0 ? 0 : rows.length - 1)
      : (currentIndex + direction + rows.length) % rows.length;

  if (clickPlayOnRow(rows[nextIndex])) {
    setTimeout(() => {
      ensureActiveAudio();
      scheduleRender();
    }, 50);
  }
}

/* ============================================================================
 * ANALYSIS INTEGRATION
 * ============================================================================ */

api.runtime.onMessage.addListener((msg: any) => {
  try {
    if (!msg || msg.type !== 'ANALYSIS_PARTIAL') return;
    if (!msg.url || msg.url !== currentSrc) return;
    
    const { type, url, ...partial } = msg;
    lastAnalysis = { ...(lastAnalysis || {}), ...partial };
    scheduleRender();
  } catch (error) {
    console.warn('[Player] Error handling message:', error);
  }
});

async function analyzeCurrentTrack(): Promise<void> {
  const el = ensureActiveAudio();
  if (!el) return;

  const src = getAudioSrc(el);
  if (!src) return;

  if (analysisInFlight) return;

  analysisInFlight = true;
  scheduleRender();

  try {
    const result = await api.runtime.sendMessage({
      type: 'ANALYZETRACK',
      url: src,
      beatMode,
    });

    lastAnalysis = result || null;

    if (lastAnalysis && !lastAnalysis.waveform && !lastAnalysis.waveformStatus) {
      lastAnalysis = { 
        ...lastAnalysis, 
        waveformStatus: 'Computing waveform…' 
      };
    }

    if (!lastAnalysis?.waveform) {
      const fallbackUrl = src;
      setTimeout(async () => {
        try {
          if (fallbackUrl !== currentSrc || lastAnalysis?.waveform) {
            return;
          }
          
          const waveformResult = await api.runtime.sendMessage({ 
            type: 'GETWAVEFORM', 
            url: fallbackUrl 
          });
          
          if (waveformResult && (waveformResult.peaksLow || waveformResult.peaks)) {
            lastAnalysis = { 
              ...(lastAnalysis || {}), 
              waveform: waveformResult, 
              waveformStatus: '' 
            };
            scheduleRender();
          }
        } catch (error) {
          console.warn('[Player] Waveform fetch failed:', error);
        }
      }, 5000);
    }
  } catch (error) {
    lastAnalysis = { 
      error: String((error as Error)?.message || error), 
      waveformStatus: 'Analysis failed' 
    };
  } finally {
    analysisInFlight = false;
    scheduleRender();
  }
}

/* ============================================================================
 * UI PANEL RENDERING
 * ============================================================================ */

function renderPanel(): void {
  const el = ensureActiveAudio();
  const meta = getTrackMeta();

  const title = meta.combined || norm(document.title) || '---';
  const isPlaying = isPlayingNow(el);
  const playheadFraction = getPlayheadFraction(el);

  if (isPlaying) {
    startRafPlayheadLoop();
  } else {
    stopRafPlayheadLoop();
  }

  const src = getAudioSrc(el);
  if (src && src !== currentSrc) {
    currentSrc = src;
    lastAnalysis = null;
    analyzeCurrentTrack();
  }

  const waveformStatus = analysisInFlight 
    ? 'Analyzing…' 
    : (lastAnalysis?.waveformStatus || '');

  const state: PanelState = {
    title,
    artistName: meta.artistName,
    trackTitle: meta.trackTitle,
    beatportQuery: title,
    tempoScale,
    beatMode,
    isPlaying,
    playheadFraction,
    currentTimeSec: el && Number.isFinite(el.currentTime) ? el.currentTime : NaN,
    durationSec: el && Number.isFinite(el.duration) ? el.duration : NaN,
    isAnalyzing: analysisInFlight,
    bpm: lastAnalysis?.bpm,
    confidence: lastAnalysis?.confidence,
    keyName: '',
    camelot: '',
    keyConfidence: lastAnalysis?.keyConfidence,
    note: lastAnalysis?.note,
    waveform: lastAnalysis?.waveform || null,
    waveformStatus,
  };

  const callbacks: PanelCallbacks = {
    onOpenBeatportSearch: (query: string) => openBeatportSearch(query),
    onTogglePlayPause: () => togglePlayPause(),
    onSeekToFraction: (fraction: number) => {
      const audio = ensureActiveAudio();
      if (!audio) return;
      seekToFraction(audio, fraction);
    },
    onPrevTrack: () => skipTrack(-1),
    onNextTrack: () => skipTrack(+1),
    onSetBeatMode: async (mode: BeatMode) => {
      beatMode = mode || 'auto';
      try {
        await api.runtime.sendMessage({ 
          type: 'SETBEATMODE', 
          beatMode 
        });
      } catch (error) {
        console.warn('[Player] Failed to set beat mode:', error);
      }
      if (src) {
        analyzeCurrentTrack();
      }
      scheduleRender();
    },
    onSetTempoScale: (scale: number) => {
      const value = Number(scale);
      tempoScale = Number.isFinite(value) ? value : 1.0;
      scheduleRender();
    },
  };

  showResultsPanel(state, callbacks);
}

/* ============================================================================
 * INITIALIZATION
 * ============================================================================ */

async function init(): Promise<void> {
  console.log('[Player] Initializing Bandcamp player integration');

  try {
    const result = await api.runtime.sendMessage({ type: 'GETBEATMODE' });
    if (result && typeof result.beatMode === 'string') {
      beatMode = result.beatMode as BeatMode;
    }
  } catch (error) {
    console.warn('[Player] Failed to restore beat mode:', error);
  }

  document.addEventListener(
    'play',
    (event) => {
      const target = event.target;
      if (target && (target as HTMLElement).tagName === 'AUDIO') {
        activeAudio = target as HTMLAudioElement;
        bindAudio(activeAudio);
        
        const newSrc = getAudioSrc(activeAudio);
        if (newSrc !== currentSrc) {
          currentSrc = newSrc;
          lastAnalysis = null;
          if (currentSrc) {
            analyzeCurrentTrack();
          }
        }
        
        scheduleRender();
      }
    },
    true
  );

  for (let i = 0; i < 80; i++) {
    const el = pickActiveAudio();
    if (el) {
      console.log('[Player] Found audio element after', i * 250, 'ms');
      break;
    }
    await sleep(250);
  }

  ensureActiveAudio();
  scheduleRender();
  
  console.log('[Player] Initialization complete');
}

init();
