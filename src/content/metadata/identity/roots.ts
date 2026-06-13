import type { PageGlobals } from '@/shared/types';
import { asRecord, collectStringByKey } from '@/content/metadata/common';

export function getGlobalRecordRoots(globals: PageGlobals | null): Record<string, unknown>[] {
  if (!globals) {
    return [];
  }

  const records = [
    asRecord(globals.page),
    asRecord(globals.band),
    asRecord(globals.tralbum),
    asRecord(globals.collection ?? null),
    asRecord(globals.wishlist ?? null),
    asRecord(globals.fan ?? null),
    asRecord(globals.bc ?? null)
  ];

  return records.filter((value): value is Record<string, unknown> => Boolean(value));
}

export function collectFromRoots(roots: Record<string, unknown>[], keyNames: string[], maxDepth = 5): string[] {
  const values: string[] = [];
  roots.forEach((root) => {
    values.push(...collectStringByKey(root, keyNames, maxDepth));
  });
  return values;
}
