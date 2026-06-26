import {
  DEFAULT_LIKE_VIEW_STATE,
  DEFAULT_PLAYLIST_STATE,
  DEFAULT_TRACK_METADATA
} from '@/shared/constants';
import type {
  AnalysisResult,
  LikeViewState,
  PanelInput,
  RuntimePlaylistPreparationUiState,
  TempoAdjustUiState
} from '@/shared/types';
import type { KeyboardShortcutMap } from '@/shared/keyboard-shortcuts';
import { getRecentApiIdentityHints } from '@/content/discover/origin-bridge';
import type { DiscoverNowPlaying } from '@/content/discover/metadata';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';

export function shouldRunDiscoverScript(): boolean {
  const host = window.location.hostname.toLowerCase();
  return (host === 'bandcamp.com' || host === 'www.bandcamp.com') && window.location.pathname.startsWith('/discover');
}

export function buildInput(
  metadata = DEFAULT_TRACK_METADATA,
  playlist = DEFAULT_PLAYLIST_STATE,
  isPlaying = false,
  analysis: AnalysisResult | null = null,
  preloadTracks = true,
  keyAnalysisEnabled = false,
  autoPlayEnabled = true,
  nowPlaying: DiscoverNowPlaying | null = null,
  likeState: LikeViewState = DEFAULT_LIKE_VIEW_STATE,
  likeNotice = '',
  tempoScale = 1,
  tempoAdjust: TempoAdjustUiState | undefined = undefined,
  waveformSeekMode: PanelInput['waveformSeekMode'] = 'commit-on-release',
  keyboardShortcuts: KeyboardShortcutMap | undefined = undefined,
  metadataLoading = false,
  uiPerformance: PanelInput['uiPerformance'] = undefined,
  runtimePlaylistPreparation: RuntimePlaylistPreparationUiState | undefined = undefined,
  runtimePlaylistSelectionPending = false,
  performanceModeEnabled = false,
  liteModeEnabled = false
): PanelInput {
  const rawCurrent = Number(nowPlaying?.currentTimeSec ?? 0);
  const rawDuration = Number(nowPlaying?.durationSec ?? 0);
  const baseCurrent = Number.isFinite(rawCurrent) ? Math.max(0, rawCurrent) : 0;
  const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const playbackTs = Number(nowPlaying?.playbackTs ?? 0);
  const elapsedSec =
    isPlaying &&
    durationSec > 0 &&
    Number.isFinite(playbackTs) &&
    playbackTs > 0
      ? Math.max(0, (Date.now() - playbackTs) / 1000)
      : 0;
  const currentTimeSec = durationSec > 0 ? Math.min(durationSec, baseCurrent + elapsedSec) : baseCurrent;
  const playheadFraction = durationSec > 0 ? Math.max(0, Math.min(1, currentTimeSec / durationSec)) : 0;

  return {
    metadata,
    metadataLoading,
    isPlaying,
    playheadFraction,
    currentTimeSec,
    durationSec,
    volume: 1,
    muted: false,
    analysis,
    playlist,
    releasePageUrl: playlist.releasePageUrl,
    likeState,
    preloadTracks,
    keyAnalysisEnabled,
    liteModeEnabled,
    autoPlayEnabled,
    performanceModeEnabled,
    tempoScale,
    tempoAdjust,
    likeNotice: String(likeNotice || '').trim(),
    waveformSeekMode,
    keyboardShortcuts,
    runtimePlaylistPreparation,
    runtimePlaylistSelectionPending,
    uiPerformance
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function isMissingMetadataValue(value: string): boolean {
  const next = normalizeText(value);
  return !next || next === DEFAULT_TRACK_METADATA.artistName;
}

export function buildHintDebug(nowPlaying: DiscoverNowPlaying): string {
  const hints = getRecentApiIdentityHints(5 * 60 * 1000);
  const trackId = readTrackIdFromUrl(nowPlaying.streamUrl);
  const byTrack = trackId ? hints.filter((hint) => String(hint.trackId || '').trim() === trackId) : [];
  const byRelease = nowPlaying.releaseUrl
    ? hints.filter((hint) => {
        try {
          return `${new URL(hint.url).origin}${new URL(hint.url).pathname}`.replace(/\/+$/, '').toLowerCase() === nowPlaying.releaseUrl;
        } catch {
          return false;
        }
      })
    : [];
  const sample = hints
    .slice(0, 4)
    .map((hint) => `${hint.bandId}:${hint.tralbumId}:${hint.tralbumType || '-'}:${String(hint.trackId || '-')}`)
    .join(', ');
  return `total=${hints.length}, byTrack=${byTrack.length}, byRelease=${byRelease.length}, sample=${sample || '-'}`;
}
