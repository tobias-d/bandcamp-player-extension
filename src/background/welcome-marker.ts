const WELCOME_PENDING_VERSION_KEY = 'bc:welcome:pending-version:v2';

function setPendingWelcomeVersion(version: string): void {
  if (!version) {
    return;
  }
  try {
    chrome.storage?.local?.set({ [WELCOME_PENDING_VERSION_KEY]: version });
  } catch {
    // Ignore storage failures; welcome fallback logic can still run.
  }
}

export function registerWelcomeMarker(): void {
  try {
    chrome.runtime.onInstalled.addListener(() => {
      const version = String(chrome.runtime.getManifest?.().version || '').trim();
      setPendingWelcomeVersion(version);
    });
  } catch {
    // Ignore runtime hook failures.
  }
}
