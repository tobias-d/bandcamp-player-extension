import { asRecord } from '@/content/metadata/common';
import type { TralbumLike } from '@/content/metadata/extractor/types';

export function normalizeApiPayload(payload: unknown): TralbumLike | null {
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) {
      continue;
    }
    seen.add(node);

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    if (Array.isArray(record['trackinfo']) || Array.isArray(record['tracks'])) {
      return record as TralbumLike;
    }

    const tralbum = asRecord(record['tralbum']);
    if (tralbum) {
      queue.push(tralbum);
    }

    const nestedData = asRecord(record['data']);
    if (nestedData) {
      queue.push(nestedData);
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return null;
}
