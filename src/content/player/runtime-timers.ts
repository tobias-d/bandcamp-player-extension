import type { AudioBridge } from '@/content/player/audio-bridge';
import { LIKES_DEEP_SYNC_POLL_INTERVAL_MS } from '@/shared/constants';

interface StartRuntimeTimersInput {
  getBridge(): AudioBridge | null;
  onWarmupTick(): void;
  onIntervalTick(): void;
  onLikesTick?(): void;
}

export function startRuntimeTimers(input: StartRuntimeTimersInput): () => void {
  const { getBridge, onWarmupTick, onIntervalTick, onLikesTick } = input;

  const warmupTimerId = window.setTimeout(() => {
    getBridge()?.ensureActiveAudio();
    onWarmupTick();
  }, 250);

  const delayedScanTimerId = window.setTimeout(() => {
    getBridge()?.ensureActiveAudio();
    onWarmupTick();
  }, 20_000);

  const recoveryIntervalId = window.setInterval(() => {
    getBridge()?.ensureActiveAudio();
    onIntervalTick();
  }, 1500);

  const likesRefreshIntervalId = window.setInterval(() => {
    onLikesTick?.();
  }, LIKES_DEEP_SYNC_POLL_INTERVAL_MS);

  return () => {
    window.clearTimeout(warmupTimerId);
    window.clearTimeout(delayedScanTimerId);
    window.clearInterval(recoveryIntervalId);
    window.clearInterval(likesRefreshIntervalId);
  };
}
