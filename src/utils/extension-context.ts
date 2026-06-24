import { browserApi } from '@/utils/browser-api';

/**
 * Tracks whether this content script can still reach its extension background.
 *
 * When the extension is reloaded, updated, or disabled (a dev rebuild, or Chrome
 * silently auto-updating the extension on a long-open tab), the already-injected
 * content script is **orphaned**: it keeps running, but every `runtime.sendMessage`
 * throws `Extension context invalidated.` and the background is unreachable forever.
 * Bandcamp's own `<audio>` still plays, so the player looks alive while BPM, waveform,
 * and metadata silently stop loading. The only recovery is a page reload, so this is a
 * one-way latch: once gone, it never comes back for this content script.
 */

type Listener = () => void;

let invalidated = false;
const listeners = new Set<Listener>();

/** True while this content script can still reach its extension background. */
export function isExtensionContextValid(): boolean {
  return Boolean(browserApi.runtime?.id);
}

/**
 * Record that the extension context is gone. Idempotent; notifies every subscriber
 * exactly once, then the latch stays set for the life of this orphaned script.
 */
export function markExtensionContextInvalidated(): void {
  if (invalidated) {
    return;
  }
  invalidated = true;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Subscribe to the one-shot context-invalidated event. If the context is already
 * known to be gone, the listener runs immediately. Returns an unsubscribe function.
 */
export function onExtensionContextInvalidated(listener: Listener): () => void {
  if (invalidated) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
