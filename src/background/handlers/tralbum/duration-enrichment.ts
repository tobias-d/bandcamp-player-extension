import { createTralbumRateLimiter } from '@/background/handlers/tralbum/rate-limiter';
import {
  getPayloadTrackQuality,
  hasTrackArrays,
  normalizePayloadData,
  readErrorFromPayload
} from '@/background/handlers/tralbum/payload';
import { fetchWithTimeout } from '@/background/handlers/tralbum/request';
import {
  asRecord,
  asTrackArray,
  extractAlbumIdentityFromPayload,
  parseIdsFromUrl
} from '@/background/handlers/tralbum/identity';

type TralbumRateLimiter = ReturnType<typeof createTralbumRateLimiter>;

function mergeTrackArrays(baseData: unknown, supplementalData: unknown): unknown {
  const baseRecord = asRecord(baseData);
  const supplementalRecord = asRecord(supplementalData);
  if (!baseRecord || !supplementalRecord) {
    return baseData;
  }

  const merged: Record<string, unknown> = { ...baseRecord };
  const baseTrackinfo = asTrackArray(baseRecord['trackinfo']);
  const baseTracks = asTrackArray(baseRecord['tracks']);
  const supplementalTrackinfo = asTrackArray(supplementalRecord['trackinfo']);
  const supplementalTracks = asTrackArray(supplementalRecord['tracks']);

  if (!baseTrackinfo.length && supplementalTrackinfo.length) {
    merged.trackinfo = supplementalTrackinfo;
  }
  if (!baseTracks.length && supplementalTracks.length) {
    merged.tracks = supplementalTracks;
  }
  if (baseTrackinfo.length && !baseTracks.length && supplementalTracks.length) {
    merged.tracks = supplementalTracks;
  }
  if (baseTracks.length && !baseTrackinfo.length && supplementalTrackinfo.length) {
    merged.trackinfo = supplementalTrackinfo;
  }

  return merged;
}

export async function maybeEnrichMissingDurations(
  data: unknown,
  releaseUrl: string,
  origin: string,
  limiter: TralbumRateLimiter,
  releaseKey = ''
): Promise<unknown> {
  const quality = getPayloadTrackQuality(data);
  if (quality.trackCount <= 1) {
    return data;
  }

  const minExpectedDurations = Math.min(quality.trackCount, Math.ceil(quality.trackCount * 0.6));
  if (quality.tracksWithDuration >= minExpectedDurations) {
    return data;
  }

  const fromPayload = extractAlbumIdentityFromPayload(data);
  const fromUrl = parseIdsFromUrl(releaseUrl);
  const bandId = fromPayload.bandId || fromUrl.bandId;
  const tralbumId = fromPayload.tralbumId || fromUrl.tralbumId;
  const tralbumType = fromPayload.tralbumType === 't' ? 't' : 'a';
  if (!bandId || !tralbumId) {
    return data;
  }

  const mobileUrl = new URL(`${origin}/api/mobile/24/tralbum_details`);
  mobileUrl.searchParams.set('band_id', bandId);
  mobileUrl.searchParams.set('tralbum_id', tralbumId);
  mobileUrl.searchParams.set('tralbum_type', tralbumType);

  try {
    limiter.noteHttpAttempt();
    const response = await fetchWithTimeout(mobileUrl.toString(), {
      method: 'GET',
      credentials: 'include'
    });
    if (!response.ok) {
      limiter.noteHttpStatus(response.status, releaseKey);
      return data;
    }

    const payload = (await response.json()) as unknown;
    if (readErrorFromPayload(payload)) {
      return data;
    }
    const supplemental = normalizePayloadData(payload);
    if (!hasTrackArrays(supplemental)) {
      return data;
    }

    const merged = mergeTrackArrays(data, supplemental);
    const mergedQuality = getPayloadTrackQuality(merged);
    const mergedRecord = asRecord(merged);
    const mergedTracks = asTrackArray(mergedRecord?.['tracks']);
    const baseRecord = asRecord(data);
    const baseTracks = asTrackArray(baseRecord?.['tracks']);
    if (!baseTracks.length && mergedTracks.length) {
      return merged;
    }
    if (mergedQuality.tracksWithDuration > quality.tracksWithDuration) {
      return merged;
    }
    return data;
  } catch {
    return data;
  }
}
