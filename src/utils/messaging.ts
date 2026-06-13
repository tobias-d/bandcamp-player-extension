import { browserApi } from '@/utils/browser-api';
import type { ContentMessage } from '@/shared/types';

export async function sendMessage<T>(message: ContentMessage): Promise<T> {
  const runtime = browserApi.runtime;
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    throw new Error('Runtime messaging API unavailable');
  }
  return runtime.sendMessage(message) as Promise<T>;
}
