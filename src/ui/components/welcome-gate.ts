import { dom, injectStylesheet } from '@/utils/dom';

const WELCOME_STYLE_ID = 'bc-player-welcome-gate-styles';
const WELCOME_STORAGE_KEY = 'bc:welcome:last-seen-version:v2';
const WELCOME_PENDING_VERSION_KEY = 'bc:welcome:pending-version:v2';

const WELCOME_CSS = `
.bc-panel-root > :not(.bc-welcome-gate) {
  transition: filter 160ms ease;
}

.bc-panel-root.bc-panel-welcome-open > :not(.bc-welcome-gate) {
  filter: blur(4px);
}

.bc-welcome-gate {
  position: absolute;
  inset: 0;
  z-index: 25;
  display: none;
  align-items: stretch;
  justify-content: stretch;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: auto;
}

.bc-welcome-gate.is-visible {
  display: flex;
}

.bc-welcome-gate-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(247, 240, 240, 0.34);
  backdrop-filter: blur(16px) saturate(120%);
  -webkit-backdrop-filter: blur(16px) saturate(120%);
}

.bc-welcome-gate-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 16px 14px 14px;
  border-radius: inherit;
  box-shadow: var(--panel-surface-sheen, none);
  color: var(--panel-text, #1f2228);
}

.bc-welcome-gate-copy {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: -1px;
  width: 100%;
  align-items: stretch;
  text-align: left;
}

.bc-welcome-gate-section {
  width: 100%;
  box-sizing: border-box;
}

.bc-welcome-gate-section.is-header {
  text-align: center;
}

.bc-welcome-gate-section.is-hints {
  padding-top: 8px;
}

.bc-welcome-gate-title {
  font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 17px;
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: 0.1px;
}

.bc-welcome-gate-version {
  margin-top: 6px;
  font-size: 10.5px;
  line-height: 1.1;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-text {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-list {
  margin: 0;
  padding-left: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  list-style: none;
  text-align: center;
}

.bc-welcome-gate-list li {
  margin: 0;
  padding-left: 0;
}

.bc-welcome-gate-feedback {
  margin: 14px 0 0;
  text-align: center;
  color: #1d5fd1;
  font-weight: 800;
}

.bc-welcome-gate-actions {
  display: flex;
  justify-content: center;
  align-items: flex-end;
  margin-top: auto;
  padding-top: 4px;
  margin-bottom: 6px;
}

.bc-welcome-gate-button {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  min-width: 132px;
  height: 38px;
  border: none;
  border-radius: 999px;
  background: none !important;
  background-color: transparent !important;
  background-image: none !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  color: var(--panel-text-bright, #1f2228);
  font-family: var(--font-mono, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 16px;
  font-weight: 800;
  cursor: pointer;
  transition: box-shadow 160ms ease;
  box-shadow: 0 2px 8px rgba(73, 84, 104, 0.22);
}

.bc-welcome-gate-button:hover {
  box-shadow: 0 4px 14px rgba(73, 84, 104, 0.32);
}

.bc-welcome-gate-button:active {
  box-shadow: 0 3px 11px rgba(73, 84, 104, 0.26);
}

.bc-welcome-gate-button:focus {
  outline: none;
  box-shadow: 0 2px 8px rgba(73, 84, 104, 0.22);
}

.bc-welcome-gate-button:focus-visible {
  box-shadow: 0 4px 14px rgba(73, 84, 104, 0.32);
}
`;

function readLastSeenVersionFromPageStorage(): string {
  try {
    return String(window.localStorage.getItem(WELCOME_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeLastSeenVersionToPageStorage(version: string): void {
  try {
    window.localStorage.setItem(WELCOME_STORAGE_KEY, version);
  } catch {
    // Ignore storage failures and keep panel behavior intact.
  }
}

async function readLastSeenVersion(): Promise<string> {
  try {
    const storage = chrome?.storage?.local;
    if (storage) {
      const value = await new Promise<unknown>((resolve) => {
        storage.get([WELCOME_STORAGE_KEY], (items) => {
          resolve(items?.[WELCOME_STORAGE_KEY]);
        });
      });
      const version = String(value || '').trim();
      if (version) {
        return version;
      }
    }
  } catch {
    // Fall back to page storage below.
  }
  return readLastSeenVersionFromPageStorage();
}

async function writeLastSeenVersion(version: string): Promise<void> {
  try {
    const storage = chrome?.storage?.local;
    if (storage) {
      await new Promise<void>((resolve) => {
        storage.set({ [WELCOME_STORAGE_KEY]: version }, () => resolve());
      });
    }
  } catch {
    // Fall back to page storage below.
  }
  writeLastSeenVersionToPageStorage(version);
}

async function readPendingWelcomeVersion(): Promise<string> {
  try {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return '';
    }
    const value = await new Promise<unknown>((resolve) => {
      storage.get([WELCOME_PENDING_VERSION_KEY], (items) => {
        const item = items?.[WELCOME_PENDING_VERSION_KEY];
        resolve(item);
      });
    });
    return String(value || '').trim();
  } catch {
    return '';
  }
}

async function clearPendingWelcomeVersion(): Promise<void> {
  try {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    await new Promise<void>((resolve) => {
      storage.remove([WELCOME_PENDING_VERSION_KEY], () => resolve());
    });
  } catch {
    // Ignore storage failures.
  }
}

function getExtensionVersion(): string {
  try {
    const version = chrome?.runtime?.getManifest?.().version;
    return String(version || '').trim();
  } catch {
    return '';
  }
}

async function shouldShowWelcome(version: string): Promise<boolean> {
  if (!version) {
    return false;
  }
  return (await readLastSeenVersion()) !== version;
}

export interface WelcomeGateController {
  mount(root: HTMLElement): void;
  isVisible(): boolean;
  destroy(): void;
}

export function createWelcomeGate(): WelcomeGateController {
  injectStylesheet(WELCOME_STYLE_ID, WELCOME_CSS);
  const currentVersion = getExtensionVersion();
  const overlay = dom('div', { class: 'bc-welcome-gate', role: 'dialog', 'aria-label': 'Welcome' });
  const backdrop = dom('div', { class: 'bc-welcome-gate-backdrop', 'aria-hidden': 'true' });
  const card = dom('div', { class: 'bc-welcome-gate-card' });
  const copy = dom('div', { class: 'bc-welcome-gate-copy' });
  const title = dom('div', { class: 'bc-welcome-gate-title' }, [
    'Thanks for downloading',
    dom('br'),
    'Bandcamp Deck'
  ]);
  const versionLabel = currentVersion ? `v.${currentVersion}` : '';
  const version = dom('div', { class: 'bc-welcome-gate-version' }, [versionLabel]);
  const header = dom('div', { class: 'bc-welcome-gate-section is-header' }, [
    title,
    version
  ]);

  // A single list of getting-started tips. Performance mode only exists on
  // Chrome, but we announce it on both browsers (clearly labelled) so Firefox users
  // know the capability exists on Chrome.
  const tips: HTMLElement[] = [
    dom('li', {}, [
      dom('strong', {}, ['Resize the panel']),
      ' by dragging any corner.'
    ]),
    dom('li', {}, [
      'Tune the ',
      dom('strong', {}, ['appearance']),
      ' of the UI under Settings → Appearance.'
    ]),
    dom('li', {}, [
      'If your connection is slow, turn off ',
      dom('strong', {}, ['track preloading']),
      '.'
    ]),
    dom('li', {}, [
      'Activate ',
      dom('strong', {}, ['key analysis']),
      ' in Settings.'
    ]),
    dom('li', {}, [
      dom('strong', {}, ['Performance mode']),
      ' (Chrome only) — activate it in Settings for instant skips.'
    ]),
    dom('li', {}, [
      'Use ',
      dom('strong', {}, ['keyboard shortcuts']),
      ' for faster navigation (see Settings).'
    ])
  ];

  const list = dom('ul', { class: 'bc-welcome-gate-list' }, tips);
  const feedback = dom('p', { class: 'bc-welcome-gate-feedback' }, [
    'Please report bugs and feature wishes via the feedback form'
  ]);
  const hints = dom('div', { class: 'bc-welcome-gate-section is-hints bc-welcome-gate-text' }, [
    list,
    feedback
  ]);

  const actions = dom('div', { class: 'bc-welcome-gate-actions' });
  const confirmButton = dom('button', { class: 'bc-welcome-gate-button', type: 'button' }, ["LET'S GO"]) as HTMLButtonElement;
  actions.appendChild(confirmButton);

  copy.append(header, hints);

  card.appendChild(copy);
  card.appendChild(actions);
  overlay.appendChild(backdrop);
  overlay.appendChild(card);

  let mountedRoot: HTMLElement | null = null;
  let visible = false;

  const hide = (): void => {
    visible = false;
    overlay.classList.remove('is-visible');
    mountedRoot?.classList.remove('bc-panel-welcome-open');
  };

  const show = (): void => {
    visible = true;
    overlay.classList.add('is-visible');
    mountedRoot?.classList.add('bc-panel-welcome-open');
    confirmButton.focus();
  };

  const syncVisibility = async (): Promise<void> => {
    const pendingVersion = await readPendingWelcomeVersion();
    if (pendingVersion === currentVersion) {
      show();
      return;
    }
    const lastSeenVersion = await readLastSeenVersion();
    const hasSeenCurrentVersion = Boolean(currentVersion) && lastSeenVersion === currentVersion;
    const shouldShow = !hasSeenCurrentVersion && (await shouldShowWelcome(currentVersion));
    if (shouldShow) {
      show();
      return;
    }
    hide();
  };

  confirmButton.addEventListener('click', () => {
    void (async () => {
      if (currentVersion) {
        await writeLastSeenVersion(currentVersion);
      }
      await clearPendingWelcomeVersion();
      hide();
    })();
  });

  return {
    mount(root) {
      if (mountedRoot) {
        return;
      }
      mountedRoot = root;
      root.appendChild(overlay);
      void syncVisibility();
    },
    isVisible() {
      return visible;
    },
    destroy() {
      mountedRoot?.classList.remove('bc-panel-welcome-open');
      overlay.remove();
      mountedRoot = null;
      visible = false;
    }
  };
}
