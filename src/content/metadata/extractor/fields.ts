import type { TrackMetadata } from '@/shared/types';
import { normalizeKey } from '@/content/metadata/common';
import type { FieldValue } from '@/content/metadata/extractor/types';
import { EMPTY_FIELD } from '@/content/metadata/extractor/types';

export function chooseField(...candidates: FieldValue[]): FieldValue {
  return candidates.find((candidate) => candidate.value.trim().length > 0) ?? EMPTY_FIELD;
}

export function deriveConfidence(metadata: TrackMetadata): TrackMetadata['confidence'] {
  const sourceBag = [metadata.sources.title, metadata.sources.artist, metadata.sources.album];

  if (
    sourceBag.some(
      (source) =>
        source.startsWith('TralbumData') ||
        source.startsWith('TralbumAPI') ||
        source.startsWith('ApiCache')
    )
  ) {
    return 'high';
  }
  return 'low';
}

export function shouldReplaceWeakAlbumCandidate(
  albumValue: string,
  titleValue: string,
  artistValue: string,
  albumSource: string,
  isAlbumPage: boolean
): boolean {
  const normalizedAlbum = normalizeKey(albumValue);
  const normalizedTitle = normalizeKey(titleValue);
  const normalizedArtist = normalizeKey(artistValue);
  const isAuthoritativeAlbumSource =
    albumSource.startsWith('TralbumAPI') || albumSource.startsWith('TralbumData');

  if (isAuthoritativeAlbumSource || !normalizedAlbum) {
    return false;
  }

  if (!isAlbumPage && normalizedTitle && normalizedAlbum === normalizedTitle) {
    return true;
  }
  if (normalizedArtist && normalizedAlbum === normalizedArtist) {
    return true;
  }
  return false;
}

export function isDuplicateAlbumCandidate(
  candidateValue: string,
  titleValue: string,
  artistValue: string,
  isAlbumPage: boolean
): boolean {
  const value = normalizeKey(candidateValue);
  if (!value) {
    return false;
  }
  const normalizedTitle = normalizeKey(titleValue);
  const normalizedArtist = normalizeKey(artistValue);
  if (!isAlbumPage && normalizedTitle && value === normalizedTitle) {
    return true;
  }
  if (normalizedArtist && value === normalizedArtist) {
    return true;
  }
  return false;
}
