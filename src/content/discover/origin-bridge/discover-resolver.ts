import { getLatestObservedDiscoverPayload } from '@/content/discover/origin-bridge/state';

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function readResultList(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const maybeResults = (payload as { results?: unknown[] }).results;
  if (Array.isArray(maybeResults)) {
    return maybeResults;
  }
  const nested = (payload as { discovery?: { results?: unknown[] } }).discovery?.results;
  return Array.isArray(nested) ? nested : [];
}

export function resolveObservedDiscoverStreamUrl(titleHint = '', artistHint = ''): string {
  const payload = getLatestObservedDiscoverPayload();
  const results = readResultList(payload);

  if (!results.length) {
    return '';
  }

  const wantedTitle = normalizeText(titleHint);
  const wantedArtist = normalizeText(artistHint);

  let bestScore = -1;
  let bestUrl = '';

  results.forEach((itemUnknown) => {
    if (!itemUnknown || typeof itemUnknown !== 'object') {
      return;
    }

    const item = itemUnknown as {
      title?: string;
      artist?: string;
      featured_track?: { stream_url?: string };
    };

    const title = normalizeText(item.title);
    const artist = normalizeText(item.artist);

    let score = 0;
    if (wantedTitle && title && title.includes(wantedTitle)) {
      score += 8;
    }
    if (wantedArtist && artist && artist.includes(wantedArtist)) {
      score += 4;
    }

    if (!wantedTitle && title) {
      score += 1;
    }

    const streamUrl = String(item.featured_track?.stream_url ?? '');
    if (streamUrl && score > bestScore) {
      bestScore = score;
      bestUrl = streamUrl;
    }
  });

  if ((wantedTitle || wantedArtist) && bestScore <= 0) {
    return '';
  }

  return bestUrl;
}
