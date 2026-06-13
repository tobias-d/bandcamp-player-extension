import { asRecord, firstNonEmpty } from '@/content/metadata/common';

export function extractFanItemsPaging(payload: unknown): { moreAvailable: boolean; nextToken: string } {
  if (!payload || typeof payload !== 'object') {
    return { moreAvailable: false, nextToken: '' };
  }

  const readPagingFromRecord = (record: Record<string, unknown>): { hasSignal: boolean; more: boolean | null; token: string } => {
    const hasSignal = [
      'more_available',
      'moreAvailable',
      'has_more',
      'hasMore',
      'older_than_token',
      'olderThanToken',
      'next_token',
      'nextToken',
      'last_token',
      'lastToken'
    ].some((key) => key in record);

    const readBool = (key: string): boolean | null => {
      const value = record[key];
      if (typeof value === 'boolean') {
        return value;
      }
      return null;
    };

    const more =
      readBool('more_available') ??
      readBool('moreAvailable') ??
      readBool('has_more') ??
      readBool('hasMore');

    const token = firstNonEmpty(
      String(record['older_than_token'] ?? ''),
      String(record['olderThanToken'] ?? ''),
      String(record['next_token'] ?? ''),
      String(record['nextToken'] ?? ''),
      String(record['last_token'] ?? ''),
      String(record['lastToken'] ?? '')
    );

    return { hasSignal, more, token };
  };

  const rootRecord = asRecord(payload);
  if (rootRecord) {
    const rootPaging = readPagingFromRecord(rootRecord);
    if (rootPaging.hasSignal && (rootPaging.more !== null || rootPaging.token)) {
      return {
        moreAvailable: rootPaging.more === true,
        nextToken: rootPaging.token
      };
    }
  }

  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  let moreAvailable: boolean | null = null;
  let nextToken = '';
  let scanned = 0;

  while (queue.length > 0 && scanned < 8000) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }
    visited.add(node);
    scanned += 1;

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    const paging = readPagingFromRecord(record);
    if (paging.hasSignal) {
      if (moreAvailable === null && paging.more !== null) {
        moreAvailable = paging.more;
      }
      if (!nextToken && paging.token) {
        nextToken = paging.token;
      }
    }

    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push(value);
      }
    });
  }

  return { moreAvailable: moreAvailable === true, nextToken };
}
