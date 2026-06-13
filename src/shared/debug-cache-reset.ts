import { sendMessage } from '@/utils/messaging';

export const DEBUG_CLEAR_CACHES_EVENT = 'bc:debug-clear-caches';

export async function dispatchDebugClearCachesRequest(): Promise<void> {
  await sendMessage<{ ok: boolean }>({ type: 'CLEAR_ANALYSIS_CACHE' });
  window.dispatchEvent(new CustomEvent(DEBUG_CLEAR_CACHES_EVENT));
}

export function subscribeDebugClearCaches(handler: () => void): () => void {
  const listener = (): void => {
    handler();
  };
  window.addEventListener(DEBUG_CLEAR_CACHES_EVENT, listener as EventListener);
  return () => {
    window.removeEventListener(DEBUG_CLEAR_CACHES_EVENT, listener as EventListener);
  };
}
