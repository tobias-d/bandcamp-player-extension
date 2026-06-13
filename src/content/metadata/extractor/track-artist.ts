import {
  asRecord,
  extractArtistFromCompositeTitle,
  firstNonEmpty,
  getNestedString,
  readTrackCompositeTitle
} from '@/content/metadata/common';
import {
  sanitizeResolvedArtist,
  sanitizeTrackLevelArtist
} from '@/content/metadata/extractor/artist-helpers';
import { collectTrackArtistHintFromPayload } from '@/content/metadata/extractor/track-artist-payload';
import { getTrackList } from '@/content/metadata/extractor/tralbum-utils';
import type { TralbumLike } from '@/content/metadata/extractor/types';

export function pickTrackArtistFromTralbum(
  tralbum: TralbumLike,
  trackId: string,
  tralbumIdHint = '',
  trustTrackContextRootArtist = false
): { artist: string; source: string } | null {
  const tracks = getTrackList(tralbum);
  const selected =
    (trackId ? tracks.find((track) => String(track.track_id ?? '') === trackId) : undefined) ??
    (tracks.length === 1 ? tracks[0] : undefined);

  const selectedRecord = asRecord(selected as unknown);
  const selectedTitle = String(selected?.title ?? '').trim();
  const direct = sanitizeTrackLevelArtist(
    firstNonEmpty(
      String((selected as { artist?: unknown } | undefined)?.artist ?? '').trim(),
      getNestedString(selectedRecord, 'artist_name'),
      getNestedString(selectedRecord, 'track_artist'),
      getNestedString(selectedRecord, 'trackArtist'),
      getNestedString(selectedRecord, 'display_artist'),
      getNestedString(selectedRecord, 'artist', 'name'),
      getNestedString(selectedRecord, 'artist', 'artist_name'),
      getNestedString(selectedRecord, 'artist', 'display_name'),
      getNestedString(selectedRecord, 'performer'),
      getNestedString(selectedRecord, 'creator'),
      getNestedString(selectedRecord, 'band_name')
    )
  );
  if (direct) {
    return {
      artist: direct,
      source: 'trackinfo.artist'
    };
  }

  const fromComposite = sanitizeTrackLevelArtist(
    extractArtistFromCompositeTitle(readTrackCompositeTitle(selected), selectedTitle)
  );
  if (fromComposite) {
    return {
      artist: fromComposite,
      source: 'trackinfo.title_with_artist'
    };
  }

  const deepTrackMatch = collectTrackArtistHintFromPayload(tralbum as unknown, trackId, 'trackmatch');
  if (deepTrackMatch?.artist) {
    return {
      artist: deepTrackMatch.artist,
      source: deepTrackMatch.source
    };
  }

  const tralbumRecord = asRecord(tralbum as unknown);
  const fromRoot = trustTrackContextRootArtist
    ? sanitizeTrackLevelArtist(String(tralbum.artist ?? '').trim())
    : sanitizeResolvedArtist(String(tralbum.artist ?? '').trim(), tralbumIdHint);
  if (fromRoot) {
    return {
      artist: fromRoot,
      source: 'tralbum.artist'
    };
  }

  const fromFieldsRaw = firstNonEmpty(
    getNestedString(tralbumRecord, 'current', 'artist'),
    getNestedString(tralbumRecord, 'track_artist'),
    getNestedString(tralbumRecord, 'trackArtist'),
    getNestedString(tralbumRecord, 'artist_name'),
    getNestedString(tralbumRecord, 'artistName')
  );
  const fromFields = trustTrackContextRootArtist
    ? sanitizeTrackLevelArtist(fromFieldsRaw)
    : sanitizeResolvedArtist(fromFieldsRaw, tralbumIdHint);
  if (fromFields) {
    return {
      artist: fromFields,
      source: 'tralbum.artist(field)'
    };
  }

  return null;
}
