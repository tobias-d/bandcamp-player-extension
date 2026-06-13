import { sendMessage } from '@/utils/messaging';
import { normalizeLikeId } from '@/content/likes/state';

const VIEWER_FAN_ID_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3_500;

let viewerFanIdCache: { fanId: string; expiresAt: number } = { fanId: '', expiresAt: 0 };
let viewerFanIdInFlight: Promise<{ fanId: string; source: string }> | null = null;

function readViewerFanIdFromWindowContextStrict(): string {
  const g = window as unknown as Record<string, unknown>;
  const identities = g['Identities'] as Record<string, unknown> | undefined;
  const fromIdentities = normalizeLikeId(identities?.['current_fan_id'] ?? identities?.['currentFanId']);
  if (fromIdentities) {
    return fromIdentities;
  }

  const pageData = g['PageData'] as Record<string, unknown> | undefined;
  const fromPage = normalizeLikeId(pageData?.['viewer_fan_id'] ?? pageData?.['viewerFanId']);
  if (fromPage) {
    return fromPage;
  }

  return '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('viewer-fan-id-timeout'));
      }
    }, Math.max(1, timeoutMs));

    promise
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

export function clearViewerFanIdCache(): void {
  viewerFanIdCache = { fanId: '', expiresAt: 0 };
  viewerFanIdInFlight = null;
}

export async function resolveViewerFanId(options?: {
  force?: boolean;
  timeoutMs?: number;
  fanSlugHint?: string;
}): Promise<{ fanId: string; source: string }> {
  const force = Boolean(options?.force);
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options?.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const fanSlugHint = String(options?.fanSlugHint || '').trim().toLowerCase();
  const now = Date.now();
  if (!force && viewerFanIdCache.fanId && viewerFanIdCache.expiresAt > now) {
    return { fanId: viewerFanIdCache.fanId, source: 'viewer-cache' };
  }

  if (viewerFanIdInFlight) {
    return viewerFanIdInFlight;
  }

  viewerFanIdInFlight = (async () => {
    const inPageFanId = readViewerFanIdFromWindowContextStrict();
    if (inPageFanId) {
      viewerFanIdCache = {
        fanId: inPageFanId,
        expiresAt: Date.now() + VIEWER_FAN_ID_TTL_MS
      };
      return { fanId: inPageFanId, source: 'window-viewer-hint' };
    }

    try {
      const response = await withTimeout(
        sendMessage<{ ok?: boolean; fanId?: string; source?: string }>({
          type: 'RESOLVE_FAN_ID',
          fanSlug: fanSlugHint || undefined
        }),
        timeoutMs
      );
      const fanId = normalizeLikeId(response?.fanId || '');
      if (response?.ok && fanId) {
        viewerFanIdCache = {
          fanId,
          expiresAt: Date.now() + VIEWER_FAN_ID_TTL_MS
        };
        return {
          fanId,
          source: String(response?.source || 'background-fan-id')
        };
      }
    } catch {
      // Fall through to unavailable result.
    }

    return { fanId: '', source: 'unavailable' };
  })();

  try {
    return await viewerFanIdInFlight;
  } finally {
    viewerFanIdInFlight = null;
  }
}
