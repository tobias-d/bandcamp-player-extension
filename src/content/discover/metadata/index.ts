import { DEFAULT_TRACK_METADATA } from '@/shared/constants';
import {
  getLatestObservedDiscoverAudioState,
  getLatestObservedDiscoverPayloadTrackMatch,
  getLatestObservedDiscoverSelection,
  resolveObservedDiscoverStreamUrl
} from '@/content/discover/origin-bridge';
import { pickApiIdentity } from '@/content/discover/metadata/hints';
import {
  normalizeReleaseUrl,
  normalizeUrl,
  readTrackIdFromUrl
} from '@/content/discover/metadata/normalize';
import { readMediaSessionState, readPayloadMatches } from '@/content/discover/metadata/payload';
import { readDiscoverReleaseFromDom } from '@/content/discover/metadata/release';
import { getNowPlayingLinkedReleaseUrl } from '@/content/metadata/release';
import type { DiscoverNowPlaying } from '@/content/discover/metadata/types';

export type { DiscoverNowPlaying } from '@/content/discover/metadata/types';

function pickStrictApiPayloadCandidate(trackId: string, releaseUrl: string): {
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  releaseUrl: string;
  streamUrl: string;
  trackId: string;
  identity: DiscoverNowPlaying['identity'];
} | null {
  const wantedTrackId = String(trackId || '').trim();
  const wantedRelease = normalizeReleaseUrl(releaseUrl);
  if (!wantedTrackId) {
    return null;
  }
  const fromBridge = getLatestObservedDiscoverPayloadTrackMatch(wantedTrackId, 90_000);
  if (fromBridge) {
    if (!wantedRelease || normalizeReleaseUrl(fromBridge.releaseUrl) === wantedRelease) {
      return {
        trackTitle: String(fromBridge.trackTitle || '').trim(),
        artistName: String(fromBridge.artistName || '').trim(),
        albumTitle: String(fromBridge.albumTitle || '').trim(),
        releaseUrl: normalizeReleaseUrl(fromBridge.releaseUrl),
        streamUrl: normalizeUrl(fromBridge.streamUrl),
        trackId: wantedTrackId,
        identity: null
      };
    }
  }
  const matches = readPayloadMatches();
  if (!matches.length) {
    return null;
  }

  const byTrack = matches.filter((candidate) => String(candidate.trackId || '').trim() === wantedTrackId);
  if (!byTrack.length) {
    return null;
  }
  const byTrackAndRelease = wantedRelease
    ? byTrack.find((candidate) => normalizeReleaseUrl(candidate.releaseUrl) === wantedRelease)
    : null;
  return byTrackAndRelease || byTrack[0] || null;
}

export function getDiscoverNowPlaying(): DiscoverNowPlaying {
  const selection = getLatestObservedDiscoverSelection(60_000);
  const selectedRelease = normalizeReleaseUrl(selection?.url ?? '');
  const audioState = getLatestObservedDiscoverAudioState(30_000);
  const audioStreamUrl = normalizeUrl(audioState?.src ?? '');
  const audioTrackId = readTrackIdFromUrl(audioStreamUrl);
  const mediaSession = audioState ? readMediaSessionState() : {
    title: '',
    artist: '',
    album: '',
    isPlaying: false
  };
  const hintedIdentity = pickApiIdentity(audioTrackId, selectedRelease);
  const hintedTrackId = String(hintedIdentity?.trackId || '').trim();
  const trackId = audioTrackId || hintedTrackId;
  const linkedRelease = normalizeReleaseUrl(getNowPlayingLinkedReleaseUrl());
  const domReleaseProbe = readDiscoverReleaseFromDom(
    mediaSession.title,
    mediaSession.artist,
    trackId
  );
  const payloadCandidate = pickStrictApiPayloadCandidate(
    trackId,
    selectedRelease ||
      domReleaseProbe.url ||
      linkedRelease ||
      normalizeReleaseUrl(hintedIdentity?.url || '')
  );
  const streamUrl =
    audioStreamUrl ||
    normalizeUrl(payloadCandidate?.streamUrl || '') ||
    resolveObservedDiscoverStreamUrl(DEFAULT_TRACK_METADATA.trackTitle, DEFAULT_TRACK_METADATA.artistName) ||
    (trackId ? `https://bandcamp.com/stream_redirect?track_id=${encodeURIComponent(trackId)}` : '');
  const releaseUrl =
    selectedRelease ||
    normalizeReleaseUrl(domReleaseProbe.url || '') ||
    linkedRelease ||
    normalizeReleaseUrl(payloadCandidate?.releaseUrl || '') ||
    normalizeReleaseUrl(hintedIdentity?.url || '') ||
    '';
  const identity =
    payloadCandidate?.identity ||
    pickApiIdentity(trackId, releaseUrl);
  const isPlaying = Boolean(audioState && !audioState.paused);
  const fallbackTitle = String(mediaSession.title || '').trim();
  const fallbackArtist = String(mediaSession.artist || '').trim();
  const fallbackAlbum = String(mediaSession.album || '').trim();
  const resolvedTitle =
    String(payloadCandidate?.trackTitle || '').trim() ||
    fallbackTitle ||
    DEFAULT_TRACK_METADATA.trackTitle;
  const resolvedArtist =
    String(payloadCandidate?.artistName || '').trim() ||
    fallbackArtist ||
    DEFAULT_TRACK_METADATA.artistName;
  const resolvedAlbum =
    String(payloadCandidate?.albumTitle || '').trim() ||
    fallbackAlbum ||
    DEFAULT_TRACK_METADATA.albumTitle;

  return {
    trackTitle: resolvedTitle,
    artistName: resolvedArtist,
    albumTitle: resolvedAlbum,
    releaseUrl,
    streamUrl,
    trackId,
    currentTimeSec: audioState ? audioState.currentTimeSec : 0,
    durationSec: audioState ? audioState.durationSec : 0,
    playbackTs: audioState ? audioState.ts : 0,
    identity,
    isPlaying,
    sources: {
      title: payloadCandidate?.trackTitle ? 'discoverApiPayload' : fallbackTitle ? 'mediaSession' : 'default',
      artist: payloadCandidate?.artistName ? 'discoverApiPayload' : fallbackArtist ? 'mediaSession' : 'default',
      album: payloadCandidate?.albumTitle ? 'discoverApiPayload' : fallbackAlbum ? 'mediaSession' : 'default',
      release:
        selectedRelease ? 'discoverSelection'
          : domReleaseProbe.url ? domReleaseProbe.source
            : linkedRelease ? 'linkedRelease'
              : payloadCandidate?.releaseUrl ? 'discoverApiPayload'
                : releaseUrl ? 'apiHint'
                  : 'none',
      stream: audioStreamUrl ? 'discoverAudio' : payloadCandidate?.streamUrl ? 'discoverApiPayload' : trackId ? 'apiHint(trackId)' : 'none',
      identity:
        payloadCandidate?.identity
          ? 'discoverApiPayload'
          : hintedIdentity
            ? 'apiHint'
            : 'none'
    }
  };
}

function getStreamPathKey(value: string): string {
  const normalized = normalizeUrl(value);
  if (!normalized) {
    return '';
  }
  const parsed = new URL(normalized);
  return `${parsed.origin}${parsed.pathname}`.toLowerCase();
}

export function getDiscoverStrictPayloadMatchDebug(input: {
  trackId?: string;
  streamUrl?: string;
  releaseUrl?: string;
}): string {
  const trackId =
    String(input.trackId || '').trim() ||
    readTrackIdFromUrl(String(input.streamUrl || '').trim());
  const streamPathKey = getStreamPathKey(String(input.streamUrl || '').trim());
  const releaseUrl = normalizeReleaseUrl(input.releaseUrl || '');
  const matches = readPayloadMatches();
  const byTrack = matches.filter((candidate) => {
    const candidateTrackId = String(candidate.trackId || '').trim() || readTrackIdFromUrl(candidate.streamUrl);
    return Boolean(trackId && candidateTrackId === trackId);
  });
  const byTrackAndRelease = releaseUrl
    ? byTrack.filter((candidate) => normalizeReleaseUrl(candidate.releaseUrl) === releaseUrl)
    : [];
  const strictMatches = byTrackAndRelease.length ? byTrackAndRelease : byTrack;
  const match = strictMatches[0] || null;
  const streamPathMatch = Boolean(match && streamPathKey && getStreamPathKey(match.streamUrl) === streamPathKey);
  const identity = match?.identity
    ? `${match.identity.bandId || '-'}:${match.identity.tralbumId || '-'}:${match.identity.tralbumType || '-'}`
    : '-';

  return [
    `matched=${strictMatches.length === 1 ? '1' : '0'}`,
    `trackId=${trackId || '-'}`,
    `payloadResults=${matches.length}`,
    `byTrack=${byTrack.length}`,
    `byRelease=${byTrackAndRelease.length}`,
    `identity=${identity}`,
    `source=${match ? (streamPathMatch ? 'featured_track.stream_url' : 'featured_track.id') : '-'}`,
    `streamPath=${streamPathMatch ? '1' : '0'}`
  ].join(' ');
}

export function watchDiscoverMetadata(callback: () => void): () => void {
  let lastKey = '';

  const emit = (): void => {
    const nowPlaying = getDiscoverNowPlaying();
    const key = [
      nowPlaying.trackId,
      nowPlaying.releaseUrl,
      nowPlaying.streamUrl,
      nowPlaying.identity?.bandId,
      nowPlaying.identity?.tralbumId,
      nowPlaying.identity?.tralbumType
    ].join('|');
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    callback();
  };

  emit();
  const intervalId = window.setInterval(emit, 1000);
  return () => window.clearInterval(intervalId);
}
