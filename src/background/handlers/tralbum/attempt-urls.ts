import {
  MAX_ATTEMPTS_PER_REQUEST,
  MAX_TRACK_ONLY_ATTEMPTS_PER_REQUEST
} from '@/background/handlers/tralbum/constants';

function altType(value: 'a' | 't'): 'a' | 't' {
  return value === 'a' ? 't' : 'a';
}

function isBandcampOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && (parsed.hostname === 'bandcamp.com' || parsed.hostname.endsWith('.bandcamp.com'));
  } catch {
    return false;
  }
}

interface BuildAttemptUrlsParams {
  origin: string;
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't';
  trackId: string;
}

export function buildAttemptUrls(params: BuildAttemptUrlsParams): string[] {
  const { origin, bandId, tralbumId, tralbumType, trackId } = params;
  const output: string[] = [];
  const seen = new Set<string>();

  const push = (url: string): void => {
    if (!url || seen.has(url)) {
      return;
    }
    seen.add(url);
    output.push(url);
  };

  const safeOrigin = 'https://bandcamp.com';
  const releaseOrigin = isBandcampOrigin(origin) ? origin : safeOrigin;
  const originCandidates = releaseOrigin === safeOrigin ? [safeOrigin] : [releaseOrigin, safeOrigin];
  const trackOnly = !bandId && Boolean(trackId) && Boolean(tralbumId) && trackId === tralbumId;
  const includeTrackId = trackOnly;

  const addTralbumInfo = (base: string, withBand: boolean, type: 'a' | 't'): void => {
    if (!tralbumId) {
      return;
    }

    const url = new URL(`${base}/api/tralbum/2/info`);
    if (withBand && bandId) {
      url.searchParams.set('band_id', bandId);
    }
    url.searchParams.set('tralbum_id', tralbumId);
    url.searchParams.set('tralbum_type', type);
    if (includeTrackId && trackId) {
      url.searchParams.set('track_id', trackId);
    }

    push(url.toString());
  };

  const addMobile = (base: string, withBand: boolean, type: 'a' | 't'): void => {
    if (!tralbumId) {
      return;
    }

    const url = new URL(`${base}/api/mobile/24/tralbum_details`);
    if (withBand && bandId) {
      url.searchParams.set('band_id', bandId);
    }

    url.searchParams.set('tralbum_id', tralbumId);
    url.searchParams.set('tralbum_type', type);

    if (includeTrackId && trackId) {
      url.searchParams.set('track_id', trackId);
    }

    push(url.toString());
  };

  originCandidates.forEach((base) => {
    addMobile(base, true, tralbumType);
    addTralbumInfo(base, true, tralbumType);
    addMobile(base, true, altType(tralbumType));
    addTralbumInfo(base, true, altType(tralbumType));
  });

  if (!bandId) {
    originCandidates.forEach((base) => {
      addMobile(base, false, tralbumType);
      addTralbumInfo(base, false, tralbumType);
      addMobile(base, false, altType(tralbumType));
      addTralbumInfo(base, false, altType(tralbumType));
    });
  }

  return output.slice(0, trackOnly ? MAX_TRACK_ONLY_ATTEMPTS_PER_REQUEST : MAX_ATTEMPTS_PER_REQUEST);
}
