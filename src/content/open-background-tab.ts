import { sendMessage } from '@/utils/messaging';

export async function openBackgroundTab(url: string): Promise<boolean> {
  const targetUrl = String(url || '').trim();
  if (!targetUrl) {
    return false;
  }
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({
      type: 'OPEN_BACKGROUND_TAB',
      url: targetUrl
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}
