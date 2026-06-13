import type { ContentMessage } from '@/shared/types';
import { browserApi } from '@/utils/browser-api';

type OpenBackgroundTabMessage = Extract<ContentMessage, { type: 'OPEN_BACKGROUND_TAB' }>;

function normalizeHttpsReleasePageUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    if (!/\/(album|track)\//i.test(parsed.pathname)) {
      return '';
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function createBackgroundTab(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab | null> {
  if (!browserApi.tabs?.create) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      browserApi.tabs.create(createProperties, (tab) => {
        const lastError = browserApi.runtime?.lastError;
        resolve(lastError ? null : tab);
      });
    } catch {
      resolve(null);
    }
  });
}

export async function handleOpenBackgroundTab(
  message: OpenBackgroundTabMessage,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const url = normalizeHttpsReleasePageUrl(message.url);
  if (!url) {
    return { ok: false, error: 'invalid-url' };
  }

  const createProperties: chrome.tabs.CreateProperties = {
    url,
    active: false
  };
  const openerTabId = sender.tab?.id;
  if (Number.isFinite(openerTabId)) {
    createProperties.openerTabId = Number(openerTabId);
  }

  const tab = await createBackgroundTab(createProperties);
  return tab ? { ok: true, url } : { ok: false, url, error: 'tabs-create-failed' };
}
