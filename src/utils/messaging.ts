import { browserApi } from '@/utils/browser-api';
import { isExtensionContextValid, markExtensionContextInvalidated } from '@/utils/extension-context';
import type { ContentMessage } from '@/shared/types';

export async function sendMessage<T>(message: ContentMessage): Promise<T> {
  const runtime = browserApi.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    throw new Error('Runtime messaging API unavailable');
  }
  // An orphaned content script (extension reloaded/updated) still has a `runtime`
  // object but no `runtime.id`; calling sendMessage would throw the opaque
  // "Extension context invalidated." Latch the state so the UI can surface it once.
  if (!isExtensionContextValid()) {
    markExtensionContextInvalidated();
    throw new Error('Extension context invalidated');
  }
  return runtime.sendMessage(message) as Promise<T>;
}
