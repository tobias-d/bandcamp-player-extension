import type { BackgroundPush } from '@/shared/types';
import type { KeyboardShortcutAction } from '@/shared/keyboard-shortcuts';
import { sendMessage } from '@/utils/messaging';
import { browserApi } from '@/utils/browser-api';
import { createLogger } from '@/utils/debug';

const logger = createLogger('BRIDGE');
const PLAYBACK_ANNOUNCE_REFRESH_MS = 2000;

export interface PlaybackHandoff {
  reportPlaybackState(isPlaying: boolean, src: string): void;
  destroy(): void;
}

interface CreatePlaybackHandoffInput {
  context: 'player' | 'discover';
  onPauseRequested(): void;
  onShortcutCommand?(action: KeyboardShortcutAction): void;
}

export function createPlaybackHandoff(input: CreatePlaybackHandoffInput): PlaybackHandoff {
  let wasPlaying = false;
  let lastSrc = '';
  let lastReportAt = 0;

  const onMessage = (raw: unknown): void => {
    const push = raw as BackgroundPush | null;
    if (!push || typeof push !== 'object' || push.type !== 'PAUSE_LOCAL_PLAYBACK') {
      if (push?.type === 'PLAYBACK_SHORTCUT_COMMAND') {
        input.onShortcutCommand?.(push.action);
      }
      return;
    }

    wasPlaying = false;
    lastReportAt = 0;
    input.onPauseRequested();
  };

  const runtime = browserApi.runtime;
  runtime?.onMessage?.addListener(onMessage as Parameters<typeof runtime.onMessage.addListener>[0]);

  return {
    reportPlaybackState(isPlaying, src): void {
      const normalizedSrc = String(src || '').trim();
      const now = Date.now();

      if (!isPlaying || !normalizedSrc) {
        wasPlaying = false;
        return;
      }

      const shouldNotify =
        !wasPlaying ||
        normalizedSrc !== lastSrc ||
        now - lastReportAt >= PLAYBACK_ANNOUNCE_REFRESH_MS;
      if (!shouldNotify) {
        return;
      }

      wasPlaying = true;
      lastSrc = normalizedSrc;
      lastReportAt = now;

      void sendMessage<{ ok: boolean }>({
        type: 'NOTIFY_PLAYBACK_STARTED',
        src: normalizedSrc,
        context: input.context
      }).catch((error) => {
        logger.warn('playback handoff notify failed', error);
      });
    },

    destroy(): void {
      runtime?.onMessage?.removeListener(onMessage as Parameters<typeof runtime.onMessage.addListener>[0]);
    }
  };
}
