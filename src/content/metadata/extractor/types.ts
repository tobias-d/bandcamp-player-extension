import type { MetadataResolution } from '@/shared/types';
import type { TrackReleaseDate } from '@/shared/types';

export interface MetadataContext {
  currentSrc?: string;
  pageGlobals?: import('@/shared/types').PageGlobals | null;
  allowApiFetch?: boolean;
}

export interface FieldValue {
  value: string;
  source: string;
}

export interface TralbumTrack {
  title?: string;
  track_id?: string | number;
  file?: { 'mp3-128'?: string };
}

export interface TralbumLike {
  artist?: string;
  current?: { title?: string };
  trackinfo?: TralbumTrack[];
  tracks?: TralbumTrack[];
  album_title?: string;
  album_release_date?: string | number | null;
  release_date?: string | number | null;
  publish_date?: string | number | null;
}

export interface TralbumMetadataCandidate {
  title: FieldValue;
  artist: FieldValue;
  album: FieldValue;
  releaseDate?: TrackReleaseDate;
  matchedTrackId: string;
  matchedStreamUrl: string;
  selectedTrackIndex: number;
  selectedTrackReason: MetadataResolution['selectedTrackReason'];
}

export interface ApiCacheEntry {
  releaseKey: string;
  tralbum: TralbumLike;
  ts: number;
}

export interface FetchIdentityResult {
  tralbum: TralbumLike | null;
  retryable: boolean;
  retryAfterMs?: number;
}

export const EMPTY_FIELD: FieldValue = { value: '', source: '' };
