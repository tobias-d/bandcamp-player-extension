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
import {
  asRecord,
  collectStringByKey,
  extractArtistFromCompositeTitle,
  firstNonEmpty,
  normalizeArtist,
  normalizeArtistKey,
  readTrackCompositeTitle,
  selectAlbumCandidate
} from '@/content/metadata/common';
import type { DiscoverNowPlaying } from '@/content/discover/metadata';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';

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
  performanceModeEnabled = false
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

function toTitleCaseFromSlug(value: string): string {
  return value
    .split(/[\s_-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (!part) {
        return '';
      }
      if (/^\d+$/.test(part)) {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .trim();
}

function readAlbumTitleFromUrlCandidate(urlRaw: string): string {
  const raw = String(urlRaw || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw, window.location.href);
    const match = parsed.pathname.match(/\/album\/([^/?#]+)/i);
    if (!match?.[1]) {
      return '';
    }
    return toTitleCaseFromSlug(decodeURIComponent(match[1]));
  } catch {
    return '';
  }
}

export function inferDiscoverAlbumTitleFromReleaseUrl(releaseUrl: string): string {
  return readAlbumTitleFromUrlCandidate(releaseUrl);
}

export function isMissingMetadataValue(value: string): boolean {
  const next = normalizeText(value);
  return !next || next === DEFAULT_TRACK_METADATA.artistName;
}

export function pickDiscoverAlbumTitleFromTralbum(
  tralbum: unknown,
  trackCount: number,
  _releaseUrl: string,
  currentTrackTitle: string
): string {
  const record = asRecord(tralbum);
  if (!record) {
    return '';
  }
  const currentRecord = asRecord(record['current']);
  const trackAlbumCandidates = getTrackList(tralbum as never)
    .map((track) => {
      const trackRecord = asRecord(track);
      if (!trackRecord) {
        return '';
      }
      return firstNonEmpty(
        String(trackRecord['album_title'] ?? '').trim(),
        String(trackRecord['albumTitle'] ?? '').trim(),
        String(trackRecord['release_title'] ?? '').trim(),
        String(trackRecord['releaseTitle'] ?? '').trim(),
        String(trackRecord['tralbum_title'] ?? '').trim(),
        String(trackRecord['tralbumTitle'] ?? '').trim()
      );
    })
    .map((value) => normalizeText(value))
    .filter(Boolean);
  const explicitFieldCandidates: string[] = [
    record['album_title'],
    record['albumTitle'],
    record['tralbum_title'],
    record['tralbumTitle'],
    record['release_title'],
    record['releaseTitle'],
    currentRecord?.['album_title'],
    currentRecord?.['albumTitle'],
    currentRecord?.['release_title'],
    currentRecord?.['releaseTitle']
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const scannedExplicitCandidates = collectStringByKey(
    record,
    [
      'album_title',
      'albumTitle',
      'tralbum_title',
      'tralbumTitle',
      'release_title',
      'releaseTitle',
      'album_name',
      'albumName',
      'item_title',
      'itemTitle'
    ],
    6
  )
    .map((value) => normalizeText(value))
    .filter(Boolean);

  const mergedExplicitCandidates = [...explicitFieldCandidates, ...trackAlbumCandidates, ...scannedExplicitCandidates];
  const pickedExplicit = selectAlbumCandidate(mergedExplicitCandidates, currentTrackTitle, '', true);
  if (pickedExplicit) {
    return pickedExplicit;
  }

  const weakCandidates: string[] = [
    normalizeText(String(record['item_title'] ?? '')),
    normalizeText(String(record['itemTitle'] ?? '')),
    normalizeText(String(record['name'] ?? ''))
  ].filter(Boolean);
  if (trackCount > 1) {
    const rootTitle = normalizeText(String(record['title'] ?? ''));
    if (rootTitle) {
      weakCandidates.push(rootTitle);
    }
  }
  const pickedWeak = selectAlbumCandidate(weakCandidates, currentTrackTitle, '', trackCount <= 1);
  if (pickedWeak) {
    return pickedWeak;
  }

  const urlCandidates = [
    ...collectStringByKey(
      record,
      ['tralbum_url', 'tralbumUrl', 'album_url', 'albumUrl', 'item_url', 'itemUrl', 'url', 'title_link', 'titleLink', 'link'],
      6
    ),
    ...getTrackList(tralbum as never).flatMap((track) => {
      const trackRecord = asRecord(track);
      if (!trackRecord) {
        return [];
      }
      return [
        String(trackRecord['tralbum_url'] ?? '').trim(),
        String(trackRecord['album_url'] ?? '').trim(),
        String(trackRecord['item_url'] ?? '').trim(),
        String(trackRecord['title_link'] ?? '').trim(),
        String(trackRecord['url'] ?? '').trim()
      ].filter(Boolean);
    })
  ];
  for (const candidate of urlCandidates) {
    const albumFromUrl = readAlbumTitleFromUrlCandidate(candidate);
    if (albumFromUrl) {
      return albumFromUrl;
    }
  }
  return '';
}

export function pickDiscoverArtistFromTralbum(tralbum: unknown): string {
  if (!tralbum || typeof tralbum !== 'object') {
    return '';
  }
  const sanitize = (value: unknown): string => {
    const artist = normalizeArtist(String(value ?? '').trim());
    const key = normalizeArtistKey(artist);
    if (!artist || key === 'various artists' || key === 'va') {
      return '';
    }
    return artist;
  };
  const record = tralbum as Record<string, unknown>;
  const candidates: unknown[] = [
    record['artist'],
    record['artist_name'],
    record['artistName'],
    (record['current'] && typeof record['current'] === 'object')
      ? (record['current'] as Record<string, unknown>)['artist']
      : ''
  ];
  for (const candidate of candidates) {
    const value = sanitize(candidate);
    if (value) {
      return value;
    }
  }
  return '';
}

export function pickDiscoverArtistFromTrack(tralbum: unknown, trackId: string): string {
  const id = String(trackId || '').trim();
  if (!tralbum || !id) {
    return '';
  }
  const sanitize = (value: string): string => {
    const artist = normalizeArtist(String(value || '').trim());
    const key = normalizeArtistKey(artist);
    if (!artist || key === 'various artists' || key === 'va') {
      return '';
    }
    return artist;
  };

  const readArtistFromTrackRecord = (raw: unknown): string => {
    const record = asRecord(raw);
    if (!record) {
      return '';
    }
    const direct = sanitize(
      firstNonEmpty(
        String(record['artist'] ?? '').trim(),
        String(record['artist_name'] ?? '').trim(),
        String(record['track_artist'] ?? '').trim(),
        String(record['trackArtist'] ?? '').trim(),
        String(record['display_artist'] ?? '').trim(),
        String(record['performer'] ?? '').trim(),
        String(record['creator'] ?? '').trim(),
        asRecord(record['artist']) ? String((asRecord(record['artist']) || {})['name'] ?? '').trim() : '',
        asRecord(record['artist']) ? String((asRecord(record['artist']) || {})['artist_name'] ?? '').trim() : '',
        asRecord(record['artist']) ? String((asRecord(record['artist']) || {})['display_name'] ?? '').trim() : ''
      )
    );
    if (direct) {
      return direct;
    }
    const title = String(record['title'] ?? '').trim();
    const composite = readTrackCompositeTitle(record);
    return sanitize(extractArtistFromCompositeTitle(composite, title));
  };

  const tracks = getTrackList(tralbum as never);
  const selected = tracks.find((track) => String(track.track_id ?? '').trim() === id);
  if (!selected) {
    return '';
  }
  return readArtistFromTrackRecord(selected);
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
