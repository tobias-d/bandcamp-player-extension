import { DEFAULT_TRACK_METADATA } from '@/shared/constants';
import type { NonReleaseResolverSnapshot, TrackMetadata } from '@/shared/types';
import { readTrackIdFromUrl } from '@/content/playlist/resolver';
import { deriveConfidence } from '@/content/metadata/extractor/fields';
import type { DiscoverNowPlaying } from '@/content/discover/metadata';

function isApiMetadataSource(source: string): boolean {
  const value = String(source || '').trim();
  return (
    value.startsWith('TralbumAPI') ||
    value.startsWith('TralbumData') ||
    value.startsWith('ApiCache')
  );
}

function isMissingMetadataValue(value: string): boolean {
  const normalized = String(value || '').trim();
  return !normalized || normalized === DEFAULT_TRACK_METADATA.trackTitle;
}

function cloneDefaultMetadata(): TrackMetadata {
  return {
    ...DEFAULT_TRACK_METADATA,
    sources: {
      ...DEFAULT_TRACK_METADATA.sources
    }
  };
}

function cloneMetadata(metadata: TrackMetadata): TrackMetadata {
  return {
    ...metadata,
    sources: {
      ...metadata.sources
    }
  };
}

function isResolverMetadataReady(snapshot: NonReleaseResolverSnapshot): boolean {
  const metadata = snapshot.metadata;
  return (
    snapshot.flags.metadataAlignedWithSource &&
    !isMissingMetadataValue(metadata.trackTitle) &&
    !isMissingMetadataValue(metadata.artistName) &&
    !isMissingMetadataValue(metadata.albumTitle) &&
    isApiMetadataSource(metadata.sources.title) &&
    isApiMetadataSource(metadata.sources.artist) &&
    isApiMetadataSource(metadata.sources.album)
  );
}

function buildPlaylistTrackMetadata(snapshot: NonReleaseResolverSnapshot): TrackMetadata | null {
  const activeTrack = snapshot.playlist.tracks[snapshot.playlist.currentIndex] || null;
  if (
    !activeTrack ||
    !snapshot.flags.metadataAlignedWithSource ||
    !snapshot.flags.strictPlaylistBinding ||
    snapshot.source.tralbumSource === 'none'
  ) {
    return null;
  }

  const trackTitle = String(activeTrack.title || '').trim();
  const artistName = String(activeTrack.artistName || '').trim();
  const albumTitle = String(activeTrack.albumTitle || '').trim();
  if (
    isMissingMetadataValue(trackTitle) ||
    isMissingMetadataValue(artistName) ||
    isMissingMetadataValue(albumTitle)
  ) {
    return null;
  }

  const source = `${snapshot.source.tralbumSource}.playlist(${snapshot.activeTrack.matchedReason || 'activeTrack'})`;
  const metadata: TrackMetadata = {
    artistName,
    trackTitle,
    albumTitle,
    combined: `${artistName} — ${trackTitle}`,
    confidence: 'low',
    sources: {
      title: source,
      artist: source,
      album: source
    }
  };
  metadata.confidence = deriveConfidence(metadata);
  return metadata;
}

export interface DiscoverMetadataPhaseInput {
  snapshot: NonReleaseResolverSnapshot;
  targetNowPlaying: DiscoverNowPlaying;
}

export interface DiscoverMetadataPhaseResult {
  metadata: TrackMetadata;
  metadataDebugLastDecision: string;
}

export function runDiscoverMetadataPhase(input: DiscoverMetadataPhaseInput): DiscoverMetadataPhaseResult {
  const { snapshot, targetNowPlaying } = input;
  const sourceTrackId =
    String(targetNowPlaying.trackId || '').trim() || readTrackIdFromUrl(String(targetNowPlaying.streamUrl || '').trim());
  const ready = isResolverMetadataReady(snapshot);
  const playlistMetadata = ready ? null : buildPlaylistTrackMetadata(snapshot);
  const resolvedMetadata = ready ? cloneMetadata(snapshot.metadata) : playlistMetadata;

  return {
    metadata: resolvedMetadata ? cloneMetadata(resolvedMetadata) : cloneDefaultMetadata(),
    metadataDebugLastDecision:
      `track=${sourceTrackId || '-'} status=${resolvedMetadata ? 'resolved' : 'loading'} snapshot=${snapshot.source.tralbumSource}/${snapshot.activeTrack.matchedReason}`
  };
}
