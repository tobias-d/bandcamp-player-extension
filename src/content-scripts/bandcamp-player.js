/**
 * ============================================================================
 * BANDCAMP PLAYER INTEGRATION
 * ============================================================================
 * 
 * Content script that integrates BPM analysis functionality into Bandcamp's
 * web player. Monitors audio playback, extracts track metadata, communicates
 * with the background analysis service, and displays results via the UI panel.
 * 
 * FEATURES:
 * - Automatic track metadata extraction from Bandcamp pages
 * - Audio element monitoring and playback state tracking
 * - Integration with Bandcamp's native player controls
 * - Real-time playback position tracking with RAF loop
 * - BPM analysis via background service communication
 * - Track navigation (prev/next) with album/playlist support
 * - Beatport search integration for cross-reference
 * - Waveform data capture and visualization
 * 
 * PAGE TYPES SUPPORTED:
 * - Album pages (with track list)
 * - Single track pages
 * - Artist feed pages
 * - Inline player variants
 * 
 * STRUCTURE:
 * - Imports & Configuration
 * - Utility Functions (string parsing, DOM queries)
 * - Metadata Extraction (track info from various page types)
 * - Audio Element Management (detection, binding, playback state)
 * - Playback Controls (play/pause, seek, track navigation)
 * - Analysis Integration (background communication)
 * - Panel Rendering (UI updates with track data)
 * - Initialization (event setup, audio detection)
 * 
 * DEPENDENCIES:
 * - results-panel.js: UI panel module
 * - Background service: BPM analysis engine (essentia.js-based)
 * 
 * Last Updated: 2026-02-13
 * ============================================================================
 */

import showResultsPanel from '../ui/results-panel.js';

const api = typeof browser !== 'undefined' ? browser : chrome;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripLeadingBy(s) {
  return norm(s).replace(/^by\s+/i, '').trim();
}

function parseArtistDashTitle(s) {
  const str = norm(s);
  if (!str) return { artistName: '', trackTitle: '' };

  const m1 = str.match(/^(.+?)\s*[—–]\s*(.+)$/);
  if (m1) return { artistName: norm(m1[1]), trackTitle: norm(m1[2]) };

  const m2 = str.match(/^(.+?)\s+-\s+(.+)$/);
  if (m2) return { artistName: norm(m2[1]), trackTitle: norm(m2[2]) };

  return { artistName: '', trackTitle: str };
}

function parseOgTitleBy(s) {
  const str = norm(s);
  if (!str) return { artistName: '', trackTitle: '' };

  const m = str.match(/^(.+?),\s*by\s+(.+)$/i);
  if (m) return { artistName: stripLeadingBy(m[2]), trackTitle: norm(m[1]) };

  return { artistName: '', trackTitle: '' };
}

function pickText(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const t = norm(el?.textContent);
    if (t) return t;
  }
  return '';
}

function pickAttr(selectors, attr) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const v = norm(el?.getAttribute?.(attr));
    if (v) return v;
  }
  return '';
}

function getTrackMeta() {
  // Prefer "track title" selectors before generic ".title" on feed pages.
  const npTitle = pickText([
    '#collection-player .track-title',
    '#collection-player .trackTitle',
    '#collection-player .song-title',
    '#collection-player .song_title',
    '#collection-player .title',
    '.collection-player .track-title',
    '.collection-player .trackTitle',
    '.collection-player .song-title',
    '.collection-player .title',
    '.queue_player .track-title',
    '.queue_player .trackTitle',
    '.queue_player .song-title',
    '.queue_player .title',
    '.queueplayer .track-title',
    '.queueplayer .trackTitle',
    '.queueplayer .song-title',
    '.queueplayer .title',

    // Bandcamp inline/bottom player variants
    '.play_status .track-title',
    '.play_status .trackTitle',
    '.play_status .song-title',
    '.play_status .song_title',
    '.play_status .subtitle',
    '.play_status .subhead',
    '.play_status .title',

    '#trackInfo .trackTitle',
    '#trackInfo .title',
  ]);

  const npArtist = pickText([
    '#collection-player .track-artist',
    '#collection-player .artist',
    '#collection-player .byline',
    '#collection-player .byline a',
    '.collection-player .track-artist',
    '.collection-player .artist',
    '.collection-player .byline',
    '.collection-player .byline a',
    '.queue_player .track-artist',
    '.queue_player .artist',
    '.queueplayer .track-artist',
    '.queueplayer .artist',
    '.play_status .artist',
    '.play_status .byline',
    '.play_status .byline a',
    '#trackInfo .artist',
  ]);

  if (npTitle || npArtist) {
    let titleCandidate = norm(npTitle);
    let artistCandidate = stripLeadingBy(npArtist);

    // Sometimes the artist is put into the "title" slot as "by Artist".
    if (!artistCandidate && /^by\s+/i.test(titleCandidate)) {
      artistCandidate = stripLeadingBy(titleCandidate);
      titleCandidate = '';
    }

    const parsedFromTitle = parseArtistDashTitle(titleCandidate);

    let artistName = stripLeadingBy(artistCandidate || parsedFromTitle.artistName);
    let trackTitle = norm(parsedFromTitle.trackTitle || titleCandidate);

    // Fix common feed bug: title slot contains artist (or equals artist after stripping).
    if (
      artistName &&
      trackTitle &&
      norm(trackTitle).toLowerCase() === norm(artistName).toLowerCase()
    ) {
      const altTitle = pickText([
        '.play_status .track-title',
        '.play_status .trackTitle',
        '.play_status .song-title',
        '.play_status .song_title',
        '.play_status .subtitle',
        '.play_status .subhead',
        '#collection-player .track-title',
        '#collection-player .trackTitle',
        '.collection-player .track-title',
        '.collection-player .trackTitle',
      ]);

      const altParsed = parseArtistDashTitle(altTitle);
      const altTrack = norm(altParsed.trackTitle || altTitle);

      if (altTrack && altTrack.toLowerCase() !== norm(artistName).toLowerCase()) {
        trackTitle = altTrack;
      }
    }

    const combined =
      artistName && trackTitle ? `${artistName} — ${trackTitle}` : (trackTitle || artistName || '---');

    return { artistName, trackTitle, combined };
  }

  // 1) Track list row marked playing/current (album/track pages)
  const row = document.querySelector(
    '.track_list .track_row.playing, .track_list .track_row.current, .track_list .track_row.now_playing,' +
      ' .tracklist .trackrow.playing, .tracklist .trackrow.current, .tracklist .trackrow.nowplaying'
  );

  if (row) {
    const t = norm(row.querySelector('.track-title, .title, .track_title, .tracktitle, a')?.textContent);
    if (t) {
      const parsed = parseArtistDashTitle(t);
      const artistName = stripLeadingBy(parsed.artistName);
      const trackTitle = norm(parsed.trackTitle || t);
      const combined = artistName ? `${artistName} — ${trackTitle}` : trackTitle;
      return { artistName, trackTitle, combined };
    }
  }

  // 2) Collection/grid item marked playing/current (collection/feed pages)
  const collectionPlaying = document.querySelector(
    '.collection-item-container.playing, .collection-item-container.current, .collection-item-container.now_playing,' +
      ' .collection-item.playing, .collection-item.current, .collection-item.now_playing,' +
      ' .feed-item.playing, .feed-item.current, .feed-item.now_playing'
  );

  if (collectionPlaying) {
    const titleText = norm(
      collectionPlaying.querySelector('.item-title, .collection-item-title, .track-title, .title, a')?.textContent
    );
    const artistText = stripLeadingBy(
      collectionPlaying.querySelector('.item-artist, .collection-item-artist, .artist, .byline, .byline a')?.textContent
    );

    if (titleText || artistText) {
      const parsed = parseArtistDashTitle(titleText);
      const artistName = stripLeadingBy(artistText || parsed.artistName);
      const trackTitle = norm(parsed.trackTitle || titleText);

      const combined =
        artistName && trackTitle ? `${artistName} — ${trackTitle}` : (trackTitle || artistName || '---');

      return { artistName, trackTitle, combined };
    }
  }

  // 3) Page header (single track / album pages)
  const headerTrack = pickText(['#name-section .trackTitle', 'h2.trackTitle', '.trackTitle']);
  const headerArtist = stripLeadingBy(pickText(['#name-section .artist', '.artist']));

  if (headerTrack || headerArtist) {
    const artistName = headerArtist;
    const trackTitle = norm(headerTrack);
    const combined =
      artistName && trackTitle
        ? `${artistName} — ${trackTitle}`
        : (trackTitle || artistName || norm(document.title) || '---');

    return { artistName, trackTitle, combined };
  }

  // 4) OG/meta title fallback
  const ogTitle =
    pickAttr(['meta[property="og:title"]'], 'content') ||
    pickAttr(['meta[name="title"]'], 'content');

  const ogParsed = parseOgTitleBy(ogTitle);
  if (ogParsed.artistName || ogParsed.trackTitle) {
    const artistName = stripLeadingBy(ogParsed.artistName);
    const trackTitle = norm(ogParsed.trackTitle);

    const combined =
      artistName && trackTitle ? `${artistName} — ${trackTitle}` : (trackTitle || artistName || '---');

    return { artistName, trackTitle, combined };
  }

  // 5) Last fallback: document.title parsing
  const doc = norm(document.title).replace(/\s*\|\s*Bandcamp\s*$/i, '').trim();

  const docBy = parseOgTitleBy(doc);
  if (docBy.artistName || docBy.trackTitle) {
    const artistName = stripLeadingBy(docBy.artistName);
    const trackTitle = norm(docBy.trackTitle);

    const combined =
      artistName && trackTitle ? `${artistName} — ${trackTitle}` : (trackTitle || artistName || '---');

    return { artistName, trackTitle, combined };
  }

  const docDash = parseArtistDashTitle(doc);
  if (docDash.artistName || docDash.trackTitle) {
    const artistName = stripLeadingBy(docDash.artistName);
    const trackTitle = norm(docDash.trackTitle);

    const combined =
      artistName && trackTitle ? `${artistName} — ${trackTitle}` : (trackTitle || artistName || '---');

    return { artistName, trackTitle, combined };
  }

  return { artistName: '', trackTitle: '', combined: doc || '---' };
}

function openBeatportSearch(q) {
  const query = String(q || '').trim();
  if (!query) return;
  const url = `https://www.beatport.com/search/tracks?q=${encodeURIComponent(query)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

let beatMode = 'auto';
let tempoScale = 1;

let activeAudio = null;
let audioBound = new WeakSet();

let currentSrc = '';
let lastAnalysis = null;
let analysisInFlight = false;

let pendingSeekFraction = null;
let renderScheduled = false;
let rafId = 0;

function pickActiveAudio() {
  if (activeAudio && document.contains(activeAudio)) return activeAudio;

  const audios = Array.from(document.querySelectorAll('audio'));
  if (!audios.length) return null;

  const playing = audios.find((a) => !a.paused && (a.currentSrc || a.src));
  if (playing) return playing;

  const ready = audios.find((a) => (a.currentSrc || a.src) && a.readyState > 0);
  if (ready) return ready;

  const withSrc = audios.find((a) => (a.currentSrc || a.src));
  return withSrc || audios[0] || null;
}

function getAudioSrc(el) {
  if (!el) return '';
  return String(el.currentSrc || el.src || '').trim();
}

function getPlayheadFraction(el) {
  if (!el) return NaN;
  const dur = Number.isFinite(el.duration) ? el.duration : NaN;
  const cur = Number.isFinite(el.currentTime) ? el.currentTime : NaN;
  if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(cur)) return NaN;
  return cur / dur;
}

function isPlayingNow(el) {
  if (!el) return false;
  return !el.paused && !el.ended;
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderPanel();
  });
}


api.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'ANALYSIS_PARTIAL') return;
    if (!msg.url || msg.url !== currentSrc) return;
    const { type, url, ...partial } = msg;
    lastAnalysis = { ...(lastAnalysis || {}), ...partial };
    scheduleRender();
  } catch (_) {}
});

function bindAudio(el) {
  if (!el || audioBound.has(el)) return;

  audioBound.add(el);

  const onAny = () => scheduleRender();

  el.addEventListener('play', onAny);
  el.addEventListener('pause', onAny);
  el.addEventListener('timeupdate', onAny);
  el.addEventListener('seeking', onAny);
  el.addEventListener('seeked', onAny);
  el.addEventListener('durationchange', onAny);
  el.addEventListener('emptied', onAny);
  el.addEventListener('ended', onAny);

  el.addEventListener('loadedmetadata', () => {
    if (pendingSeekFraction !== null) {
      const f = pendingSeekFraction;
      pendingSeekFraction = null;
      seekToFraction(el, f);
      scheduleRender();
    }
  });
}

function startRafPlayheadLoop() {
  if (rafId) return;

  const tick = () => {
    rafId = requestAnimationFrame(tick);
    if (!activeAudio) return;
    if (!isPlayingNow(activeAudio)) return;
    renderPanel();
  };

  rafId = requestAnimationFrame(tick);
}

function stopRafPlayheadLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function ensureActiveAudio() {
  const el = pickActiveAudio();
  if (!el) return null;

  if (activeAudio !== el) {
    activeAudio = el;
    bindAudio(activeAudio);
    currentSrc = getAudioSrc(activeAudio);
    lastAnalysis = null;
    if (currentSrc) analyzeCurrentTrack();
  }

  return activeAudio;
}

function tryClickBandcampPlayButton() {
  const btn =
    document.querySelector('.playbutton') ||
    document.querySelector('#big_play_button') ||
    document.querySelector('[data-bind*="play"]');

  if (btn && typeof btn.click === 'function') btn.click();
}

function togglePlayPause() {
  const el = ensureActiveAudio();
  if (!el) {
    tryClickBandcampPlayButton();
    return;
  }

  if (el.paused) {
    const p = el.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
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

function seekToFraction(el, frac) {
  if (!el) return;

  const f = Math.max(0, Math.min(1, Number(frac)));
  if (!Number.isFinite(f)) return;

  const dur = Number.isFinite(el.duration) ? el.duration : NaN;
  if (!Number.isFinite(dur) || dur <= 0) {
    pendingSeekFraction = f;
    return;
  }

  const t = f * dur;

  try {
    if (typeof el.fastSeek === 'function') el.fastSeek(t);
    else el.currentTime = t;
  } catch (_) {
    pendingSeekFraction = f;
    setTimeout(() => {
      if (pendingSeekFraction !== null) {
        const ff = pendingSeekFraction;
        pendingSeekFraction = null;
        seekToFraction(el, ff);
      }
    }, 120);
  }

  scheduleRender();
}

function findTrackRows() {
  const rows = Array.from(
    document.querySelectorAll('.track_list .track_row, .tracklist .trackrow, #track_list .track_row, #tracklist .trackrow')
  );
  return rows.filter((r) => r && r.querySelector && r.querySelector('a, .title, .track-title, .track_title'));
}

function findCurrentTrackRow() {
  return (
    document.querySelector('.track_list .track_row.playing, .track_list .track_row.current, .track_list .track_row.now_playing') ||
    document.querySelector('.tracklist .trackrow.playing, .tracklist .trackrow.current, .tracklist .trackrow.nowplaying') ||
    null
  );
}

function clickPlayOnRow(row) {
  if (!row) return false;

  const btn =
    row.querySelector('.play_col .play_status, .play_col .playbutton, .play_col a') ||
    row.querySelector('.playbutton, button.playbutton, a.playbutton') ||
    row.querySelector('a');

  try {
    if (btn && typeof btn.click === 'function') {
      btn.click();
      return true;
    }
  } catch (_) {}

  try {
    row.click();
    return true;
  } catch (_) {
    return false;
  }
}

function clickGlobalPrevNext(dir) {
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

  const sels = dir > 0 ? nextSelectors : prevSelectors;

  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (el && typeof el.click === 'function') {
      try {
        el.click();
        return true;
      } catch (_) {}
    }
  }

  return false;
}

function skipTrack(dir) {
  if (clickGlobalPrevNext(dir)) {
    setTimeout(() => {
      ensureActiveAudio();
      scheduleRender();
    }, 50);
    return;
  }

  const rows = findTrackRows();
  if (!rows.length) return;

  const cur = findCurrentTrackRow();
  let idx = cur ? rows.indexOf(cur) : -1;

  const nextIdx =
    idx < 0
      ? (dir > 0 ? 0 : rows.length - 1)
      : (idx + dir + rows.length) % rows.length;

  if (clickPlayOnRow(rows[nextIdx])) {
    setTimeout(() => {
      ensureActiveAudio();
      scheduleRender();
    }, 50);
  }
}

async function analyzeCurrentTrack() {
  const el = ensureActiveAudio();
  if (!el) return;

  const src = getAudioSrc(el);
  if (!src) return;

  if (analysisInFlight) return;

  analysisInFlight = true;
  scheduleRender();

  try {
    const res = await api.runtime.sendMessage({
      type: 'ANALYZETRACK',
      url: src,
      beatMode,
    });

    lastAnalysis = res || null;

    if (lastAnalysis && !lastAnalysis.waveform && !lastAnalysis.waveformStatus) {
      lastAnalysis = { ...lastAnalysis, waveformStatus: 'Computing waveform…' };
    }

    if (!lastAnalysis?.waveform) {
      const fallbackUrl = src;
      setTimeout(async () => {
        try {
          if (fallbackUrl !== currentSrc || lastAnalysis?.waveform) return;
          const wf = await api.runtime.sendMessage({ type: 'GETWAVEFORM', url: fallbackUrl });
          if (wf && (wf.peaksLow || wf.peaks)) {
            lastAnalysis = { ...(lastAnalysis || {}), waveform: wf, waveformStatus: '' };
            scheduleRender();
          }
        } catch (_) {}
      }, 5000);
    }
} catch (e) {
    lastAnalysis = { error: String(e?.message || e), waveformStatus: 'Analysis failed' };
  } finally {
    analysisInFlight = false;
    scheduleRender();
  }
}

function renderPanel() {
  const el = ensureActiveAudio();
  const meta = getTrackMeta();

  const title = meta.combined || norm(document.title) || '---';
  const isPlaying = isPlayingNow(el);
  const playheadFraction = getPlayheadFraction(el);

  if (isPlaying) startRafPlayheadLoop();
  else stopRafPlayheadLoop();

  const src = getAudioSrc(el);
  if (src && src !== currentSrc) {
    currentSrc = src;
    lastAnalysis = null;
    analyzeCurrentTrack();
  }

  const waveformStatus = analysisInFlight ? 'Analyzing' : (lastAnalysis?.waveformStatus || '');

  showResultsPanel(
    {
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
    },
    {
      onOpenBeatportSearch: (q) => openBeatportSearch(q),
      onTogglePlayPause: () => togglePlayPause(),
      onSeekToFraction: (frac) => {
        const a = ensureActiveAudio();
        if (!a) return;
        seekToFraction(a, frac);
      },
      onPrevTrack: () => skipTrack(-1),
      onNextTrack: () => skipTrack(+1),

      onSetBeatMode: async (mode) => {
        beatMode = mode || 'auto';
        try {
          await api.runtime.sendMessage({ type: 'SETBEATMODE', beatMode });
        } catch (_) {}
        if (src) analyzeCurrentTrack();
        scheduleRender();
      },
      onSetTempoScale: (s) => {
        const v = Number(s);
        tempoScale = Number.isFinite(v) ? v : 1;
        scheduleRender();
      },
    }
  );
}

async function init() {
  try {
    const res = await api.runtime.sendMessage({ type: 'GETBEATMODE' });
    if (res && typeof res.beatMode === 'string') beatMode = res.beatMode;
  } catch (_) {}

  document.addEventListener(
    'play',
    (ev) => {
      const t = ev.target;
      if (t && t.tagName === 'AUDIO') {
        activeAudio = t;
        bindAudio(activeAudio);
        currentSrc = getAudioSrc(activeAudio);
        lastAnalysis = null;
        if (currentSrc) analyzeCurrentTrack();
        scheduleRender();
      }
    },
    true
  );

  for (let i = 0; i < 80; i++) {
    const el = pickActiveAudio();
    if (el) break;
    await sleep(250);
  }

  ensureActiveAudio();
  scheduleRender();
}

init();
