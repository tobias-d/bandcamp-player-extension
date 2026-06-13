import { FETCH_ATTEMPT_TIMEOUT_MS } from '@/background/handlers/tralbum/constants';

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_ATTEMPT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    globalThis.clearTimeout(timer);
  }
}
