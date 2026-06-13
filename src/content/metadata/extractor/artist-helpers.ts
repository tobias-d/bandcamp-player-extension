import {
  extractArtistFromCompositeTitle,
  looksLikeHumanArtistValue,
  normalizeArtist,
  normalizeArtistKey
} from '@/content/metadata/common';
import { looksLikeLabelAliasFromHost } from '@/content/metadata/release';
import {
  TRACK_ARTIST_CACHE_TTL_MS,
  cachedTrackArtistByTrackId
} from '@/content/metadata/extractor/state';

export function readCachedTrackArtist(trackId: string): { artist: string; source: string } | null {
  if (!trackId) {
    return null;
  }
  const cached = cachedTrackArtistByTrackId.get(trackId);
  if (!cached) {
    return null;
  }
  if (Date.now() - cached.ts > TRACK_ARTIST_CACHE_TTL_MS) {
    cachedTrackArtistByTrackId.delete(trackId);
    return null;
  }
  return {
    artist: cached.artist,
    source: cached.source
  };
}

export function sanitizeResolvedArtist(value: string, tralbumIdHint = ''): string {
  const artist = normalizeArtist(value);
  if (!artist || !looksLikeHumanArtistValue(artist)) {
    return '';
  }
  const key = normalizeArtistKey(artist);
  if (key === 'various artists' || key === 'va') {
    return '';
  }
  if (looksLikeLabelAliasFromHost(artist, tralbumIdHint)) {
    return '';
  }
  return artist;
}

export function sanitizeTrackLevelArtist(value: string): string {
  const artist = normalizeArtist(value);
  if (!artist || !looksLikeHumanArtistValue(artist)) {
    return '';
  }
  const key = normalizeArtistKey(artist);
  if (key === 'various artists' || key === 'va') {
    return '';
  }
  return artist;
}

export function parseArtistPrefix(value: string, titleHint = ''): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }
  const title = String(titleHint ?? '').trim();
  if (title) {
    const fromComposite = extractArtistFromCompositeTitle(raw, title);
    if (fromComposite) {
      return fromComposite;
    }
  }
  const split = raw.match(/^(.+?)\s[-–—:]\s.+$/);
  if (!split?.[1]) {
    return '';
  }
  const candidate = normalizeArtist(split[1]);
  const key = normalizeArtistKey(candidate);
  if (!candidate || key === 'various artists' || key === 'va') {
    return '';
  }
  return candidate;
}

