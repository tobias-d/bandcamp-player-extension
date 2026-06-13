import {
  asRecord,
  extractArtistFromCompositeTitle,
  firstNonEmpty,
  getNestedString,
  getNestedUnknown,
  normalizeStreamMatchKey,
  readTrackCompositeTitle,
  readTrackIdFromUrl,
  toIdString
} from '@/content/metadata/common';
import {
  readCachedTrackArtist,
  sanitizeResolvedArtist,
  sanitizeTrackLevelArtist
} from '@/content/metadata/extractor/artist-helpers';
import { collectTrackArtistHintFromPayload } from '@/content/metadata/extractor/track-artist-payload';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';
import type { TralbumLike, TralbumMetadataCandidate, TralbumTrack } from '@/content/metadata/extractor/types';
import { pickReleaseDateFromTralbum } from '@/content/metadata/release/date';

export function readCandidateFromTralbum(
  tralbum: TralbumLike,
  sourcePrefix: 'TralbumData' | 'TralbumAPI',
  currentSrc: string,
  allowUnmatched: boolean
): TralbumMetadataCandidate | null {
  const trackinfoPrimary = getTrackList(tralbum);
  const secondaryTracks =
    Array.isArray(tralbum.trackinfo) && Array.isArray(tralbum.tracks) ? tralbum.tracks : [];
  const trackId = readTrackIdFromUrl(currentSrc);
  const normalizedSrc = normalizeStreamMatchKey(currentSrc);

  let selectedTrack: TralbumTrack | undefined;
  let selectedTrackSecondary: TralbumTrack | undefined;
  let selectedTrackReason: TralbumMetadataCandidate['selectedTrackReason'] = 'none';

  if (trackId) {
    selectedTrack = trackinfoPrimary.find((track) => String(track.track_id ?? '') === trackId);
    if (selectedTrack) {
      selectedTrackReason = 'trackId';
    }
  }

  if (!selectedTrack && normalizedSrc) {
    selectedTrack = trackinfoPrimary.find((track) => {
      const stream = String(track.file?.['mp3-128'] ?? '');
      return stream.length > 0 && normalizeStreamMatchKey(stream) === normalizedSrc;
    });
    if (selectedTrack) {
      selectedTrackReason = 'streamUrl';
    }
  }

  if (secondaryTracks.length > 0) {
    if (trackId) {
      selectedTrackSecondary = secondaryTracks.find((track) => String(track.track_id ?? '') === trackId);
    }
    if (!selectedTrackSecondary && normalizedSrc) {
      selectedTrackSecondary = secondaryTracks.find((track) => {
        const stream = String(track.file?.['mp3-128'] ?? '');
        return stream.length > 0 && normalizeStreamMatchKey(stream) === normalizedSrc;
      });
    }
    if (!selectedTrackSecondary && selectedTrack) {
      const primaryId = String(selectedTrack.track_id ?? '');
      if (primaryId) {
        selectedTrackSecondary = secondaryTracks.find((track) => String(track.track_id ?? '') === primaryId);
      }
    }
    if (!selectedTrackSecondary && selectedTrack) {
      const idx = trackinfoPrimary.indexOf(selectedTrack);
      if (idx >= 0 && idx < secondaryTracks.length) {
        selectedTrackSecondary = secondaryTracks[idx];
      }
    }
  }

  const selectedTrackTitle = String(selectedTrack?.title ?? selectedTrackSecondary?.title ?? '').trim();
  const selectedTrackArtistDirect = firstNonEmpty(
    String((selectedTrack as { artist?: unknown } | undefined)?.artist ?? '').trim(),
    String((selectedTrackSecondary as { artist?: unknown } | undefined)?.artist ?? '').trim(),
    getNestedString(asRecord(selectedTrack as unknown), 'artist_name'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'artist_name'),
    getNestedString(asRecord(selectedTrack as unknown), 'track_artist'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'track_artist'),
    getNestedString(asRecord(selectedTrack as unknown), 'trackArtist'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'trackArtist'),
    getNestedString(asRecord(selectedTrack as unknown), 'display_artist'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'display_artist'),
    getNestedString(asRecord(selectedTrack as unknown), 'artist', 'name'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'artist', 'name'),
    getNestedString(asRecord(selectedTrack as unknown), 'artist', 'artist_name'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'artist', 'artist_name'),
    getNestedString(asRecord(selectedTrack as unknown), 'artist', 'display_name'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'artist', 'display_name'),
    getNestedString(asRecord(selectedTrack as unknown), 'performer'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'performer'),
    getNestedString(asRecord(selectedTrack as unknown), 'creator'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'creator'),
    getNestedString(asRecord(selectedTrack as unknown), 'band_name'),
    getNestedString(asRecord(selectedTrackSecondary as unknown), 'band_name')
  );
  const selectedTrackArtistComposite = firstNonEmpty(
    extractArtistFromCompositeTitle(readTrackCompositeTitle(selectedTrack), selectedTrackTitle),
    extractArtistFromCompositeTitle(readTrackCompositeTitle(selectedTrackSecondary), selectedTrackTitle)
  );
  const selectedTrackArtistRaw = firstNonEmpty(selectedTrackArtistDirect, selectedTrackArtistComposite);
  const selectedTrackArtistSource = selectedTrackArtistDirect
    ? `${sourcePrefix}.trackinfo.artist`
    : selectedTrackArtistComposite
      ? `${sourcePrefix}.trackinfo.title_with_artist`
      : '';
  const titleValue = selectedTrackTitle;
  const selectedTrackIndex = selectedTrack ? trackinfoPrimary.indexOf(selectedTrack) : -1;

  if (!allowUnmatched && selectedTrackReason === 'none' && !titleValue) {
    return null;
  }

  let titleSource = '';
  if (selectedTrackReason === 'trackId') {
    titleSource = `${sourcePrefix}.trackinfo(trackId)`;
  } else if (selectedTrackReason === 'streamUrl') {
    titleSource = `${sourcePrefix}.trackinfo(streamUrl)`;
  }

  const tralbumRecord = asRecord(tralbum as unknown);
  const currentArtist = getNestedString(tralbumRecord, 'current', 'artist');
  const trackArtistField = firstNonEmpty(
    getNestedString(tralbumRecord, 'track_artist'),
    getNestedString(tralbumRecord, 'trackArtist')
  );
  const artistNameField = firstNonEmpty(
    getNestedString(tralbumRecord, 'artist_name'),
    getNestedString(tralbumRecord, 'artistName'),
    getNestedString(tralbumRecord, 'tralbum_artist'),
    getNestedString(tralbumRecord, 'tralbumArtist'),
    getNestedString(tralbumRecord, 'band_name'),
    getNestedString(tralbumRecord, 'bandName'),
    getNestedString(tralbumRecord, 'band', 'name')
  );
  const tralbumIdHint = firstNonEmpty(
    toIdString(getNestedUnknown(tralbumRecord, 'id')),
    toIdString(getNestedUnknown(tralbumRecord, 'tralbum_id')),
    toIdString(getNestedUnknown(tralbumRecord, 'item_id')),
    toIdString(getNestedUnknown(tralbumRecord, 'album_id'))
  );
  const selectedTrackArtist = sanitizeTrackLevelArtist(selectedTrackArtistRaw);
  const artistFromTrack = selectedTrackArtist;
  const artistFromRootRaw = String(tralbum.artist ?? '').trim();
  const artistFromRoot = sanitizeResolvedArtist(artistFromRootRaw, tralbumIdHint);
  const artistFieldCandidates: Array<{ value: string; source: string }> = [
    { value: sanitizeResolvedArtist(currentArtist, tralbumIdHint), source: `${sourcePrefix}.current.artist` },
    { value: sanitizeResolvedArtist(trackArtistField, tralbumIdHint), source: `${sourcePrefix}.track_artist` },
    { value: sanitizeResolvedArtist(artistNameField, tralbumIdHint), source: `${sourcePrefix}.artist(field)` }
  ];
  const trackArtistFromPayload = trackId
    ? collectTrackArtistHintFromPayload(tralbum as unknown, trackId, `${sourcePrefix}.trackmatch`)
    : null;
  const selectedArtistField =
    artistFieldCandidates.find(
      (candidate) => candidate.value
    ) ?? null;
  const artistFromFields = selectedArtistField?.value ?? '';
  const artistValue = firstNonEmpty(artistFromTrack, trackArtistFromPayload?.artist ?? '', artistFromRoot, artistFromFields);
  const cachedTrackArtist = trackId ? readCachedTrackArtist(trackId) : null;
  const finalArtistValue = firstNonEmpty(
    artistValue,
    cachedTrackArtist?.artist ?? ''
  );
  let artistSource = '';
  if (artistFromTrack) {
    artistSource = selectedTrackArtistSource || `${sourcePrefix}.trackinfo.artist`;
  } else if (trackArtistFromPayload?.artist) {
    artistSource = trackArtistFromPayload.source;
  } else if (artistFromRoot) {
    artistSource = `${sourcePrefix}.artist`;
  } else if (artistFromFields) {
    artistSource = selectedArtistField?.source ?? `${sourcePrefix}.artist(field)`;
  } else if (cachedTrackArtist?.artist) {
    artistSource = `TrackArtistAPI.${cachedTrackArtist.source}`;
  }

  const albumDirect = firstNonEmpty(
    String(tralbum.album_title ?? '').trim(),
    getNestedString(tralbumRecord, 'current', 'album_title'),
    getNestedString(tralbumRecord, 'release_title'),
    getNestedString(tralbumRecord, 'releaseTitle'),
    getNestedString(tralbumRecord, 'item_title'),
    getNestedString(tralbumRecord, 'itemTitle'),
    getNestedString(tralbumRecord, 'current', 'title')
  );
  let albumValue = albumDirect;
  let albumSource = albumDirect ? `${sourcePrefix}.album_title` : '';
  if (!albumValue && trackinfoPrimary.length > 1) {
    albumValue = firstNonEmpty(
      getNestedString(tralbumRecord, 'album_title'),
      getNestedString(tralbumRecord, 'albumTitle'),
      getNestedString(tralbumRecord, 'title'),
      getNestedString(tralbumRecord, 'name')
    );
    if (albumValue) {
      albumSource = `${sourcePrefix}.album_title(fallback)`;
    }
  }
  const releaseDate = pickReleaseDateFromTralbum(tralbum as unknown, sourcePrefix);

  return {
    title: {
      value: titleValue,
      source: titleSource
    },
    artist: {
      value: finalArtistValue,
      source: artistSource
    },
    album: {
      value: albumValue,
      source: albumSource
    },
    ...(releaseDate ? { releaseDate } : {}),
    matchedTrackId: selectedTrack
      ? String(selectedTrack.track_id ?? '')
      : selectedTrackSecondary
        ? String(selectedTrackSecondary.track_id ?? '')
        : trackId,
    matchedStreamUrl: firstNonEmpty(
      String(selectedTrack?.file?.['mp3-128'] ?? ''),
      String(selectedTrackSecondary?.file?.['mp3-128'] ?? '')
    ),
    selectedTrackIndex,
    selectedTrackReason
  };
}
