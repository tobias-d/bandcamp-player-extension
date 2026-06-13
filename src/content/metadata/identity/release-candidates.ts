import type { PageGlobals } from '@/shared/types';
import {
  asRecord,
  firstNonEmpty,
  getNestedUnknown,
  isReleaseContext,
  toIdString,
  toTralbumType
} from '@/content/metadata/common';
import type { ReleaseIdentity } from '@/content/metadata/release';
import { collectFromRoots, getGlobalRecordRoots } from '@/content/metadata/identity/roots';

export function toReleaseIdentity(globals: PageGlobals | null): ReleaseIdentity | null {
  if (!globals) {
    return null;
  }

  const roots = getGlobalRecordRoots(globals);
  if (!roots.length) {
    return null;
  }

  const page = asRecord(globals.page);
  const band = asRecord(globals.band);
  const tralbum = asRecord(globals.tralbum);

  const bandId = firstNonEmpty(
    toIdString(getNestedUnknown(page, 'band_id')),
    toIdString(getNestedUnknown(page, 'bandId')),
    toIdString(getNestedUnknown(band, 'id')),
    toIdString(getNestedUnknown(band, 'band_id')),
    toIdString(getNestedUnknown(tralbum, 'band_id')),
    ...collectFromRoots(roots, ['band_id', 'bandId', 'bandid', 'selling_band_id', 'sellingBandId']).map(toIdString)
  );

  const tralbumId = firstNonEmpty(
    toIdString(getNestedUnknown(page, 'tralbum_id')),
    toIdString(getNestedUnknown(page, 'item_id')),
    toIdString(getNestedUnknown(page, 'itemId')),
    toIdString(getNestedUnknown(tralbum, 'id')),
    toIdString(getNestedUnknown(tralbum, 'tralbum_id')),
    toIdString(getNestedUnknown(tralbum, 'item_id')),
    ...collectFromRoots(
      roots,
      ['tralbum_id', 'tralbumId', 'item_id', 'itemId', 'album_id', 'albumId', 'release_id', 'releaseId', 'tralbumid']
    ).map(toIdString)
  );

  const fromPageType = firstNonEmpty(
    String(getNestedUnknown(page, 'tralbum_type') ?? ''),
    String(getNestedUnknown(page, 'item_type') ?? ''),
    String(getNestedUnknown(tralbum, 'tralbum_type') ?? ''),
    ...collectFromRoots(roots, ['tralbum_type', 'tralbumType', 'item_type', 'itemType'])
  );
  const pathType = window.location.pathname.includes('/track/') ? 't' : 'a';
  const tralbumType = toTralbumType(fromPageType) || pathType;

  if (!bandId || !tralbumId) {
    return null;
  }

  return { bandId, tralbumId, tralbumType };
}

export function releaseKey(identity: ReleaseIdentity): string {
  return `${identity.bandId}:${identity.tralbumId}:${identity.tralbumType}`;
}

export function collectReleaseIdentityCandidates(globals: PageGlobals | null): ReleaseIdentity[] {
  if (!globals) {
    return [];
  }

  const roots = getGlobalRecordRoots(globals);
  if (!roots.length) {
    return [];
  }

  const page = asRecord(globals.page);
  const band = asRecord(globals.band);
  const tralbum = asRecord(globals.tralbum);
  const pathType: 'a' | 't' = window.location.pathname.includes('/track/') ? 't' : 'a';

  const fallbackBandId = firstNonEmpty(
    toIdString(getNestedUnknown(page, 'band_id')),
    toIdString(getNestedUnknown(page, 'bandId')),
    toIdString(getNestedUnknown(band, 'id')),
    toIdString(getNestedUnknown(band, 'band_id')),
    toIdString(getNestedUnknown(tralbum, 'band_id')),
    ...collectFromRoots(roots, ['band_id', 'bandId', 'selling_band_id', 'sellingBandId']).map(toIdString)
  );

  const seen = new Set<string>();
  const output: ReleaseIdentity[] = [];
  const isRootLikeContext = !isReleaseContext();
  const add = (bandIdRaw: string, tralbumIdRaw: string, typeRaw: 'a' | 't' | ''): void => {
    const bandId = toIdString(bandIdRaw);
    const tralbumId = toIdString(tralbumIdRaw);
    if (!bandId || !tralbumId) {
      return;
    }

    const typeCandidates: Array<'a' | 't'> =
      typeRaw ? [typeRaw] : isRootLikeContext ? ['a', 't'] : [pathType];

    typeCandidates.forEach((tralbumType) => {
      const identity: ReleaseIdentity = { bandId, tralbumId, tralbumType };
      const key = releaseKey(identity);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      output.push(identity);
    });
  };

  const primary = toReleaseIdentity(globals);
  if (primary) {
    add(primary.bandId, primary.tralbumId, primary.tralbumType);
  }

  const queue: unknown[] = [...roots];
  const visited = new Set<unknown>();

  while (queue.length > 0 && output.length < 20) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }
    visited.add(node);

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    const localBandId = firstNonEmpty(
      toIdString(record['band_id']),
      toIdString(record['bandId']),
      toIdString(record['selling_band_id']),
      toIdString(record['sellingBandId']),
      fallbackBandId
    );

    const localItemId = firstNonEmpty(
      toIdString(record['tralbum_id']),
      toIdString(record['tralbumId']),
      toIdString(record['item_id']),
      toIdString(record['itemId']),
      toIdString(record['album_id']),
      toIdString(record['albumId']),
      toIdString(record['release_id']),
      toIdString(record['releaseId'])
    );

    const localType = toTralbumType(
      firstNonEmpty(
        String(record['tralbum_type'] ?? ''),
        String(record['tralbumType'] ?? ''),
        String(record['item_type'] ?? ''),
        String(record['itemType'] ?? '')
      )
    );

    add(localBandId, localItemId, localType);

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  if (fallbackBandId && output.length < 20) {
    const ids = collectFromRoots(
      roots,
      ['tralbum_id', 'tralbumId', 'item_id', 'itemId', 'album_id', 'albumId', 'release_id', 'releaseId']
    );
    ids.forEach((id) => {
      add(fallbackBandId, id, pathType);
    });
  }

  return output;
}
