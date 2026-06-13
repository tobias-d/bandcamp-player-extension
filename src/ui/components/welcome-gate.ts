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
  max-width: 320px;
  margin-left: auto;
  margin-right: auto;
  align-items: center;
  text-align: center;
}

.bc-welcome-gate-section {
  width: 100%;
  box-sizing: border-box;
}

.bc-welcome-gate-section.is-hints {
  padding-top: 2px;
}

/* Slide 1 has fewer/shorter lines, so nudge its tips down for better vertical balance. */
.bc-welcome-gate-copy.is-slide-1 .bc-welcome-gate-section.is-hints {
  padding-top: 16px;
}

.bc-welcome-gate-title {
  font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 19px;
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: 0.1px;
}

.bc-welcome-gate-version {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.1;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-text {
  font-size: 11px;
  line-height: 1.42;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-bullets {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* Slide 1 has fewer bullets, so give them more breathing room between lines. */
.bc-welcome-gate-copy.is-slide-1 .bc-welcome-gate-bullets {
  gap: 10px;
}

/* Slide 2 ("What's new") shows version badges per section, so the header's own
   version number is redundant there. */
.bc-welcome-gate-copy:not(.is-slide-1) .bc-welcome-gate-version {
  display: none;
}

.bc-welcome-gate-bullet {
  margin: 0;
}

.bc-welcome-gate-bullet.is-separated {
  margin-top: 2px;
}

.bc-welcome-gate-bullet.is-feedback {
  margin-top: 14px;
  color: #1d5fd1;
  font-weight: 800;
}

/* Small colored badge per version section (shrinks to content, centered). */
.bc-welcome-gate-ver-label {
  align-self: center;
  margin: 0;
  padding: 2px 9px;
  border-radius: 6px;
  background: rgba(29, 95, 209, 0.13);
  color: #1d5fd1;
  font-weight: 800;
  font-size: 11px;
  letter-spacing: 0.4px;
}

.bc-welcome-gate-ver-label.is-section-gap {
  margin-top: 6px;
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

  // Slide 1: returning tips that have always lived on the gate.
  const slide1Bullets: HTMLElement[] = [
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      'You can use ',
      dom('strong', {}, ['keyboard shortcuts']),
      ' for faster navigation (see settings).'
    ]),
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      dom('strong', {}, ['Resize the panel']),
      ' by dragging any corner.'
    ]),
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      'If your connection is slow, turn off ',
      dom('strong', {}, ['track preloading']),
      '.'
    ]),
    dom('p', { class: 'bc-welcome-gate-bullet is-separated' }, [
      'You can activate ',
      dom('strong', {}, ['key analysis']),
      ' in the settings.'
    ])
  ];

  // Slide 2: what's new, grouped by version. The feedback note closes the slide.
  const slide2Content: HTMLElement[] = [
    dom('p', { class: 'bc-welcome-gate-ver-label' }, ['3.6.1']),
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      dom('strong', {}, ['Liquid-glass look']),
      ' (Chrome only) — the panel is now real frosted glass. Fine-tune it under ',
      dom('strong', {}, ['Settings → Glass effect']),
      '.'
    ]),
    dom('p', { class: 'bc-welcome-gate-ver-label is-section-gap' }, ['3.6.0']),
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      dom('strong', {}, ['More accurate BPM']),
      ' — analysis is more thorough now, so it takes a little longer.'
    ]),
    dom('p', { class: 'bc-welcome-gate-bullet' }, [
      dom('strong', {}, ['Reworked waveform']),
      ' — now much closer to Rekordbox.'
    ])
  ];

  // Performance mode only exists on Chrome, but we announce it on both browsers
  // (clearly labelled) so Firefox users know the capability exists on Chrome.
  slide2Content.push(dom('p', { class: 'bc-welcome-gate-bullet' }, [
    dom('strong', {}, ['Performance mode']),
    ' (Chrome only) — preloads further ahead for instant skips. Activate it under ',
    dom('strong', {}, ['Settings']),
    '.'
  ]));

  // The feedback note closes slide 2 on both browsers.
  slide2Content.push(dom('p', { class: 'bc-welcome-gate-bullet is-separated is-feedback' }, [
    'Please report bugs and feature wishes via the feedback form'
  ]));

  const bulletsContainer = dom('div', { class: 'bc-welcome-gate-bullets' });
  const hints = dom('div', { class: 'bc-welcome-gate-section is-hints bc-welcome-gate-text' }, [
    bulletsContainer
  ]);

  const actions = dom('div', { class: 'bc-welcome-gate-actions' });
  const confirmButton = dom('button', { class: 'bc-welcome-gate-button', type: 'button' }, ['NEXT']) as HTMLButtonElement;
  actions.appendChild(confirmButton);

  // The gate is a two-slide flow: slide 1 is the returning tips, slide 2 announces what's new.
  // NEXT advances slide 1 -> 2; on slide 2 the button confirms and closes the gate.
  let currentSlide: 1 | 2 = 1;
  const setSlide = (slide: 1 | 2): void => {
    currentSlide = slide;
    copy.classList.toggle('is-slide-1', slide === 1);
    if (slide === 2) {
      title.replaceChildren("What's new");
      bulletsContainer.replaceChildren(...slide2Content);
      confirmButton.textContent = "LET'S GO";
      return;
    }
    title.replaceChildren('Thanks for downloading', dom('br'), 'Bandcamp Deck');
    bulletsContainer.replaceChildren(...slide1Bullets);
    confirmButton.textContent = 'NEXT';
  };

  copy.append(header, hints);
  setSlide(1);

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
    setSlide(1);
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
    if (currentSlide === 1) {
      setSlide(2);
      confirmButton.focus();
      return;
    }
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
