import type { PageGlobals } from '@/shared/types';
import { asRecord, firstNonEmpty, toIdString } from '@/content/metadata/common';
import { collectFromRoots, getGlobalRecordRoots } from '@/content/metadata/identity/roots';

export function getFanIdFromGlobals(globals: PageGlobals | null): string {
  const fanRecord = asRecord(globals?.fan ?? null);
  if (fanRecord) {
    const directFanId = firstNonEmpty(
      toIdString(fanRecord['fan_id']),
      toIdString(fanRecord['fanId']),
      toIdString(fanRecord['fanid']),
      toIdString(fanRecord['id']),
      toIdString(fanRecord['user_id']),
      toIdString(fanRecord['userId'])
    );
    if (directFanId) {
      return directFanId;
    }
  }

  const pageRecord = asRecord(globals?.page ?? null);
  if (pageRecord) {
    const pageFanId = firstNonEmpty(
      toIdString(pageRecord['fan_id']),
      toIdString(pageRecord['fanId']),
      toIdString(pageRecord['fanid']),
      toIdString(pageRecord['fan_id_num']),
      toIdString(pageRecord['viewer_fan_id'])
    );
    if (pageFanId) {
      return pageFanId;
    }
  }

  const roots = getGlobalRecordRoots(globals);
  if (!roots.length) {
    return '';
  }
  return firstNonEmpty(...collectFromRoots(roots, ['fan_id', 'fanId', 'fanid']).map(toIdString));
}

export function collectIdLikeHints(globals: PageGlobals | null): {
  keyHints: string[];
  bandHints: string[];
  itemHints: string[];
  typeHints: string[];
} {
  const roots = getGlobalRecordRoots(globals);
  if (!roots.length) {
    return { keyHints: [], bandHints: [], itemHints: [], typeHints: [] };
  }

  const keyHints = new Set<string>();
  const bandHints = new Set<string>();
  const itemHints = new Set<string>();
  const typeHints = new Set<string>();
  const queue: Array<{ node: unknown; depth: number }> = roots.map((node) => ({ node, depth: 0 }));
  const visited = new Set<unknown>();
  const maxDepth = 7;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }
    const { node, depth } = next;
    if (!node || typeof node !== 'object' || visited.has(node)) {
      continue;
    }
    visited.add(node);

    const record = asRecord(node);
    if (!record) {
      continue;
    }

    for (const [key, value] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (lower.includes('id') || lower.includes('type')) {
        keyHints.add(key);
      }
      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (!text) {
          continue;
        }
        if (lower.includes('band') && lower.includes('id')) {
          const id = toIdString(text);
          bandHints.add(`${key}:${id || text}`);
        }
        if (
          lower.includes('id') &&
          (lower.includes('item') || lower.includes('tralbum') || lower.includes('album') || lower.includes('release'))
        ) {
          const id = toIdString(text);
          itemHints.add(`${key}:${id || text}`);
        }
        if (lower.includes('type') && (lower.includes('item') || lower.includes('tralbum'))) {
          typeHints.add(`${key}:${text}`);
        }
      }
    }

    if (depth >= maxDepth) {
      continue;
    }
    Object.values(record).forEach((value) => {
      if (value && typeof value === 'object') {
        queue.push({ node: value, depth: depth + 1 });
      }
    });
  }

  return {
    keyHints: Array.from(keyHints).slice(0, 10),
    bandHints: Array.from(bandHints).slice(0, 6),
    itemHints: Array.from(itemHints).slice(0, 6),
    typeHints: Array.from(typeHints).slice(0, 6)
  };
}
