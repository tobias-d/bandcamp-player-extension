export interface TralbumIds {
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't' | '';
  trackId: string;
}

export interface TralbumIdentity {
  bandId: string;
  tralbumId: string;
  tralbumType: 'a' | 't' | '';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function asTrackArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>>;
}

function toStringSafe(value: unknown): string {
  return String(value ?? '').trim();
}

export function toId(value: unknown): string {
  const raw = toStringSafe(value);
  if (!raw) {
    return '';
  }

  const match = raw.match(/\d+/);
  return match?.[0] ?? '';
}

export function toType(value: unknown): 'a' | 't' | '' {
  const raw = toStringSafe(value).toLowerCase();
  if (raw === 'a' || raw === 'album') {
    return 'a';
  }

  if (raw === 't' || raw === 'track') {
    return 't';
  }

  return '';
}

function parseTralbumTypeFromUnknown(value: unknown): 'a' | 't' | '' {
  const raw = toStringSafe(value).toLowerCase();
  if (raw === 'album' || raw === 'a') {
    return 'a';
  }
  if (raw === 'track' || raw === 't') {
    return 't';
  }
  return '';
}

export function parseIdsFromUrl(urlRaw: string): TralbumIds {
  try {
    const parsed = new URL(urlRaw);
    return {
      bandId: toId(parsed.searchParams.get('band_id')),
      tralbumId: toId(parsed.searchParams.get('tralbum_id')),
      tralbumType: toType(parsed.searchParams.get('tralbum_type')),
      trackId: toId(parsed.searchParams.get('track_id'))
    };
  } catch {
    return {
      bandId: '',
      tralbumId: '',
      tralbumType: '',
      trackId: ''
    };
  }
}

export function extractAlbumIdentityFromPayload(data: unknown): TralbumIdentity {
  const record = asRecord(data);
  if (!record) {
    return { bandId: '', tralbumId: '', tralbumType: '' };
  }

  const current = asRecord(record['current']);
  const trackinfo = asTrackArray(record['trackinfo']);
  const tracks = asTrackArray(record['tracks']);
  const primaryTracks = trackinfo.length >= tracks.length ? trackinfo : tracks;
  const firstTrack = primaryTracks[0] ?? null;

  const bandId = firstTrack
    ? toId(firstTrack['band_id'] ?? record['band_id'] ?? record['selling_band_id'] ?? current?.['band_id'])
    : toId(record['band_id'] ?? record['selling_band_id'] ?? current?.['band_id']);
  const tralbumId = firstTrack
    ? toId(firstTrack['album_id'] ?? record['id'] ?? record['album_id'] ?? record['tralbum_id'] ?? current?.['id'])
    : toId(record['id'] ?? record['album_id'] ?? record['tralbum_id'] ?? current?.['id']);
  const tralbumType =
    parseTralbumTypeFromUnknown(record['item_type']) ||
    parseTralbumTypeFromUnknown(record['type']) ||
    parseTralbumTypeFromUnknown(record['tralbum_type']) ||
    parseTralbumTypeFromUnknown(current?.['type']);

  return {
    bandId,
    tralbumId,
    tralbumType
  };
}

export function getReleaseKey(params: {
  bandId: string;
  tralbumId: string;
  trackId: string;
  tralbumType: 'a' | 't';
}): string {
  const { bandId, tralbumId, trackId, tralbumType } = params;
  return `${bandId || '-'}:${tralbumId || '-'}:${trackId || '-'}:${tralbumType || 'a'}`;
}
