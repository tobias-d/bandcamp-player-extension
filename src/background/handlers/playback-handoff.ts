import type { BackgroundPush, ContentMessage } from '@/shared/types';
import type { KeyboardShortcutAction } from '@/shared/keyboard-shortcuts';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';

const logger = createLogger('MESSAGING');

interface ActivePlaybackState {
  tabId: number;
  src: string;
  context: 'player' | 'discover';
  ts: number;
}

let activePlayback: ActivePlaybackState | null = null;
let commandsRegistered = false;

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

  const previous = activePlayback;
  if (previous && previous.tabId !== nextTabId) {
    logger.info('cross-tab handoff', {
      fromTabId: previous.tabId,
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

  activePlayback = {
    tabId: nextTabId,
    src,
    context: msg.context,
    ts: Date.now()
  };

  return { ok: true };
}

function mapCommandToShortcutAction(command: string): KeyboardShortcutAction | null {
  switch (command) {
    case 'media-play-pause':
      return 'toggle-play-pause';
    case 'media-previous-track':
      return 'previous-track';
    case 'media-next-track':
      return 'next-track';
    default:
      return null;
  }
}

async function pushShortcutCommandToActiveTab(action: KeyboardShortcutAction): Promise<void> {
  const tabId = activePlayback?.tabId;
  if (!Number.isFinite(tabId)) {
    logger.info('media key ignored; no active Bandcamp playback tab');
    return;
  }

  const push: BackgroundPush = {
    type: 'PLAYBACK_SHORTCUT_COMMAND',
    action,
    source: 'media-key'
  };

  try {
    await browserApi.tabs.sendMessage(Number(tabId), push);
  } catch (error) {
    logger.warn('media key dispatch failed', error);
  }
}

export function registerPlaybackCommandHandlers(): void {
  if (commandsRegistered) {
    return;
  }
  const commands = browserApi.commands;
  if (!commands?.onCommand) {
    logger.warn('commands API unavailable; media keys not registered');
    return;
  }

  commandsRegistered = true;
  commands.onCommand.addListener((command) => {
    const action = mapCommandToShortcutAction(command);
    if (!action) {
      return;
    }
    void pushShortcutCommandToActiveTab(action);
  });
}
