import { decodeHtmlEntities } from '@/utils/html-parser';

export function extractTralbumFromHtml(html: string): unknown | null {
  const source = String(html || '');
  if (!source) {
    return null;
  }

  const scriptMatch = source.match(/<script[^>]*\bdata-tralbum=(["'])([\s\S]*?)\1[^>]*>/i);
  if (!scriptMatch?.[2]) {
    return null;
  }

  const raw = decodeHtmlEntities(scriptMatch[2]).trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
