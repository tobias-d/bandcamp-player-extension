import type { BackgroundPush, ContentMessage } from '@/shared/types';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';

const logger = createLogger('MESSAGING');

let lastPlaybackTabId: number | null = null;

async function pushPauseToTab(targetTabId: number, fromTabId: number, src: string): Promise<void> {
  const push: BackgroundPush = {
    type: 'PAUSE_LOCAL_PLAYBACK',
    reason: 'other-tab-started',
    fromTabId,
    src
  };

  try {
    await browserApi.tabs.sendMessage(targetTabId, push);
  } catch {
    // Tab likely closed or no content script attached; safe to ignore.
  }
}

async function pauseAllOtherBandcampTabs(nextTabId: number, src: string): Promise<number> {
  const urlFilters = ['*://*.bandcamp.com/*', '*://bandcamp.com/*'];
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await browserApi.tabs.query({ url: urlFilters });
  } catch {
    return 0;
  }

  const targets = new Set<number>();
  tabs.forEach((tab) => {
    const tabId = tab?.id;
    if (!Number.isFinite(tabId) || Number(tabId) === nextTabId) {
      return;
    }
    targets.add(Number(tabId));
  });

  await Promise.all(Array.from(targets).map((targetTabId) => pushPauseToTab(targetTabId, nextTabId, src)));
  return targets.size;
}

export async function handleNotifyPlaybackStarted(
  msg: Extract<ContentMessage, { type: 'NOTIFY_PLAYBACK_STARTED' }>,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: boolean }> {
  const tabId = sender.tab?.id;
  if (!Number.isFinite(tabId)) {
    return { ok: false };
  }

  const nextTabId = Number(tabId);
  const src = String(msg.src || '').trim();
  if (!src) {
    return { ok: false };
  }

  const previousTabId = lastPlaybackTabId;
  if (previousTabId !== null && previousTabId !== nextTabId) {
    logger.info('cross-tab handoff', {
      fromTabId: previousTabId,
      toTabId: nextTabId,
      context: msg.context
    });
  }
  const pausedTabs = await pauseAllOtherBandcampTabs(nextTabId, src);
  if (pausedTabs > 0) {
    logger.info('cross-tab pause broadcast', {
      toTabId: nextTabId,
      pausedTabs,
      context: msg.context
    });
  }

  lastPlaybackTabId = nextTabId;

  return { ok: true };
}
