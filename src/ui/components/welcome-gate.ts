import { dom, injectStylesheet } from '@/utils/dom';
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  formatShortcutKey
} from '@/shared/keyboard-shortcuts';

const WELCOME_STYLE_ID = 'bc-player-welcome-gate-styles';
const WELCOME_STORAGE_KEY = 'bc:welcome:last-seen-version:v2';
const WELCOME_PENDING_VERSION_KEY = 'bc:welcome:pending-version:v2';
const FEEDBACK_FORM_URL = 'https://forms.gle/CMyrodpNPThdr5Aw8';
const KOFI_URL = 'https://ko-fi.com/lany_';

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
  padding: 0;
  border-radius: inherit;
  overflow: hidden;
  box-shadow: var(--panel-surface-sheen, none);
  color: var(--panel-text, #1f2228);
}

/* Three fixed bands: top 1/4 (welcome + version), middle 2/4 (the slides plus the
   dot indicator and arrows), bottom 1/4 (the dismiss button). Fine divider lines
   separate them and the middle band is tinted a touch darker. */
.bc-welcome-gate-top {
  flex: 0 0 25%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 8px 14px;
}

.bc-welcome-gate-mid {
  flex: 0 0 50%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
  padding: 10px 14px 8px;
}

.bc-welcome-gate-bottom {
  flex: 0 0 25%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 8px 14px;
}

/* Single background shape behind the content. The darker middle band is one filled path
   whose top edge smiles (bends up at the edges) and bottom edge frowns (bends down), and
   the divider lines are stroked from the exact same curves — so fill and line always
   coincide. preserveAspectRatio=none stretches it to the panel; non-scaling-stroke keeps
   the lines hairline-thin. z-index:-1 keeps it behind the content bands. */
.bc-welcome-gate-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
}

.bc-welcome-gate-bg-fill {
  fill: rgba(0, 0, 0, 0.06);
}

.bc-welcome-gate-bg-line {
  fill: none;
  stroke: color-mix(in srgb, var(--panel-text, #1f2228) 16%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.bc-welcome-gate-header {
  width: 100%;
  text-align: center;
}

.bc-welcome-gate-title {
  font-family: var(--font-display, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 16.5px;
  line-height: 1.16;
  font-weight: 700;
  letter-spacing: 0.1px;
}

.bc-welcome-gate-slashes {
  color: #6b6b6b;
}

.bc-welcome-gate-version {
  margin-top: 4px;
  font-size: 10px;
  line-height: 1.1;
  color: var(--panel-text-dim, #1f2228);
}

/* Inline feature chips so named settings read as toggles/features, not just bold words. */
.bc-welcome-gate-feature {
  display: inline-block;
  align-self: center;
  padding: 0.5px 5px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, #1d5fd1 55%, transparent);
  background: color-mix(in srgb, #1d5fd1 12%, transparent);
  color: #1d5fd1;
  font-size: 10.5px;
  font-weight: 700;
  white-space: nowrap;
}

/* One page is shown at a time; the others are hidden. The active page is centered
   both vertically (between the header and the buttons) and horizontally, and the
   region scrolls if a page is taller than a small panel so navigation stays reachable. */
.bc-welcome-gate-pages {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.bc-welcome-gate-page {
  display: none;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 255px;
  box-sizing: border-box;
  text-align: center;
}

.bc-welcome-gate-page.is-active {
  display: flex;
}

.bc-welcome-gate-page.is-tight {
  gap: 2px;
}

.bc-welcome-gate-page-text {
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-page-text strong {
  font-weight: 700;
  color: var(--panel-text, #1f2228);
}

.bc-welcome-gate-list {
  margin: 2px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  list-style: none;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--panel-text-dim, #1f2228);
}

/* Keyboard shortcuts page: the real default mapping in a compact two-column grid —
   transport in the left column, playback/tempo in the right. Keys sit in neutral
   (uncoloured) boxes that hug each glyph. */
.bc-welcome-gate-keys {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(3, auto);
  grid-template-columns: auto auto;
  column-gap: 18px;
  row-gap: 0;
  justify-content: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

.bc-welcome-gate-keyrow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 9.5px;
  line-height: 1;
  color: var(--panel-text-dim, #1f2228);
}

.bc-welcome-gate-keycombo {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 3px;
}

.bc-welcome-gate-key {
  display: inline-block;
  min-width: 9px;
  padding: 0 3px;
  border: 1px solid color-mix(in srgb, var(--panel-text, #1f2228) 32%, transparent);
  border-radius: 4px;
  text-align: center;
  color: var(--panel-text, #1f2228);
  font-family: var(--font-mono, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 9px;
  font-weight: 700;
  line-height: 1.05;
  white-space: nowrap;
}

.bc-welcome-gate-list li {
  margin: 0;
  padding: 0;
}

.bc-welcome-gate-list li strong {
  font-weight: 700;
  color: var(--panel-text, #1f2228);
}

.bc-welcome-gate-feedback-link,
.bc-welcome-gate-support-link {
  font-weight: 700;
  text-decoration: none;
}

.bc-welcome-gate-feedback-link {
  color: #1d5fd1;
}

.bc-welcome-gate-support-link {
  color: #b06b00;
}

.bc-welcome-gate-feedback-link:hover,
.bc-welcome-gate-support-link:hover {
  text-decoration: underline;
}

.bc-welcome-gate-feedback-link:hover {
  text-decoration: underline;
}

.bc-welcome-gate-nav {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  width: 100%;
  padding-top: 10px;
}

.bc-welcome-gate-navbtn {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--panel-text-dim, #1f2228);
  font-family: var(--font-mono, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 23px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition: opacity 140ms ease, color 140ms ease;
}

.bc-welcome-gate-navbtn:hover {
  color: var(--panel-text, #1f2228);
}

.bc-welcome-gate-navbtn:disabled {
  opacity: 0.26;
  cursor: default;
}

.bc-welcome-gate-navbtn:focus {
  outline: none;
}

.bc-welcome-gate-navbtn:focus-visible {
  color: var(--panel-text, #1f2228);
}

.bc-welcome-gate-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 auto;
}

.bc-welcome-gate-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--panel-text-dim, #1f2228) 32%, transparent);
  transition: background 140ms ease, transform 140ms ease;
}

.bc-welcome-gate-dot.is-active {
  background: var(--panel-text, #1f2228);
  transform: scale(1.15);
}

.bc-welcome-gate-button {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  min-width: 120px;
  height: 36px;
  border: none;
  border-radius: 999px;
  background: none !important;
  background-color: transparent !important;
  background-image: none !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  color: var(--panel-text-bright, #1f2228);
  font-family: var(--font-mono, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Helvetica, Arial, sans-serif);
  font-size: 15px;
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

// Each page of the walkthrough is a titled section the user steps through. Performance and
// Key analysis carry a short explanation of what the feature actually does, since those are the
// settings most worth understanding before turning on. Performance mode is Chrome-only but we
// describe it on both browsers (clearly labelled) so Firefox users know the capability exists.
function buildWelcomePages(): HTMLElement[] {
  // Pages carry no visible heading — the items speak for themselves. The `label` is used only as
  // the section's accessible name. Performance and Key analysis explain what the feature does,
  // since those are the settings most worth understanding before turning them on. Performance mode
  // is Chrome-only but described on both browsers (clearly labelled) so Firefox users know it exists.
  const page = (label: string, ...content: HTMLElement[]): HTMLElement =>
    dom('section', { class: 'bc-welcome-gate-page', role: 'group', 'aria-label': label }, content);
  const text = (...nodes: (string | HTMLElement)[]): HTMLElement =>
    dom('p', { class: 'bc-welcome-gate-page-text' }, nodes);
  const link = (href: string, label: string, className = 'bc-welcome-gate-feedback-link'): HTMLElement =>
    dom('a', { class: className, href, target: '_blank', rel: 'noopener noreferrer' }, [label]);
  const feature = (label: string): HTMLElement =>
    dom('span', { class: 'bc-welcome-gate-feature' }, [label]);

  const appearance = page(
    'Appearance',
    dom('ul', { class: 'bc-welcome-gate-list' }, [
      dom('li', {}, [dom('strong', {}, ['Resize the panel']), ' by dragging any corner.']),
      dom('li', {}, [
        feature('Appearance'),
        ' in Settings sets the panel’s opacity and background pattern.'
      ])
    ])
  );

  const performance = page(
    'Performance',
    dom('ul', { class: 'bc-welcome-gate-list' }, [
      dom('li', {}, [
        feature('Track preloading'),
        ' readies upcoming tracks for instant playback — turn it off if your machine or connection is slow.'
      ]),
      dom('li', {}, [
        feature('Performance mode'),
        ' (Chrome) prepares even more ahead for instant skips.'
      ])
    ])
  );

  const keyAnalysis = page(
    'Key analysis',
    text(
      feature('Key analysis'),
      ' is off by default. Because key detection is never fully objective, results can differ from apps like Rekordbox or Mixed In Key. Turn it on in Settings.'
    )
  );

  // Default mapping shown as a grouped grid: transport (left column), playback/tempo (right).
  const keyGlyphs: Record<string, string> = {
    ' ': 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓'
  };
  const keyBox = (action: keyof typeof DEFAULT_KEYBOARD_SHORTCUTS): HTMLElement => {
    const raw = DEFAULT_KEYBOARD_SHORTCUTS[action];
    return dom('span', { class: 'bc-welcome-gate-key' }, [keyGlyphs[raw] ?? formatShortcutKey(raw)]);
  };
  const keyCell = (label: string, ...keys: HTMLElement[]): HTMLElement =>
    dom('li', { class: 'bc-welcome-gate-keyrow' }, [
      dom('span', {}, [label]),
      dom('span', { class: 'bc-welcome-gate-keycombo' }, keys)
    ]);
  const shortcutsGrid = dom('ul', { class: 'bc-welcome-gate-keys' }, [
    keyCell('Play / Pause', keyBox('toggle-play-pause')),
    keyCell('Prev', keyBox('previous-track')),
    keyCell('Next', keyBox('next-track')),
    keyCell('Seek', keyBox('seek-backward'), keyBox('seek-forward')),
    keyCell('Tap tempo', keyBox('tap-tempo')),
    keyCell('Tempo', keyBox('tempo-up'), keyBox('tempo-down'))
  ]);
  const shortcuts = page(
    'Keyboard shortcuts',
    feature('Keyboard shortcuts'),
    shortcutsGrid
  );
  shortcuts.classList.add('is-tight');

  const feedback = page(
    'Feedback',
    text('Spotted a bug or have a wish? ', link(FEEDBACK_FORM_URL, 'Send feedback')),
    text('No ads, no accounts, no catch — if Bandcamp Deck earns a place in your workflow, a small tip is hugely appreciated. ', link(KOFI_URL, 'Leave a tip', 'bc-welcome-gate-support-link'))
  );
  feedback.classList.add('is-tight');

  return [appearance, performance, keyAnalysis, shortcuts, feedback];
}

// Background shape: the darker middle band plus its two curved divider lines, all from the
// same curves. Top edge smiles (edges bend up), bottom edge frowns (edges bend down). The
// viewBox is 0..100 in both axes and stretched with preserveAspectRatio=none.
function createWelcomeBackground(): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const topEdge = 'M0,24 Q50,28 100,24';
  const bottomEdge = 'M0,76 Q50,72 100,76';
  const makePath = (className: string, d: string): SVGPathElement => {
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('class', className);
    path.setAttribute('d', d);
    return path;
  };
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('class', 'bc-welcome-gate-bg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  // Fill: along the top smile, down the right edge, back along the bottom frown, close up the left.
  svg.appendChild(makePath('bc-welcome-gate-bg-fill', 'M0,24 Q50,28 100,24 L100,76 Q50,72 0,76 Z'));
  svg.appendChild(makePath('bc-welcome-gate-bg-line', topEdge));
  svg.appendChild(makePath('bc-welcome-gate-bg-line', bottomEdge));
  return svg;
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

  const title = dom('div', { class: 'bc-welcome-gate-title' }, [
    'Thanks for downloading',
    dom('br'),
    'BANDCAMP ',
    dom('span', { class: 'bc-welcome-gate-slashes' }, ['//']),
    ' DECK'
  ]);
  const versionLabel = currentVersion ? `v.${currentVersion}` : '';
  const version = dom('div', { class: 'bc-welcome-gate-version' }, [versionLabel]);
  const header = dom('div', { class: 'bc-welcome-gate-header' }, [title, version]);
  const topArea = dom('div', { class: 'bc-welcome-gate-top' }, [header]);

  const pages = buildWelcomePages();
  const pagesWrap = dom('div', { class: 'bc-welcome-gate-pages' }, pages);

  const dots = pages.map(() => dom('span', { class: 'bc-welcome-gate-dot', 'aria-hidden': 'true' }));
  const dotsRow = dom('div', { class: 'bc-welcome-gate-dots' }, dots);
  const backButton = dom('button', {
    class: 'bc-welcome-gate-navbtn',
    type: 'button',
    'aria-label': 'Previous tip'
  }, ['‹']) as HTMLButtonElement;
  const nextButton = dom('button', {
    class: 'bc-welcome-gate-navbtn',
    type: 'button',
    'aria-label': 'Next tip'
  }, ['›']) as HTMLButtonElement;
  const nav = dom('div', { class: 'bc-welcome-gate-nav' }, [backButton, dotsRow, nextButton]);
  const midArea = dom('div', { class: 'bc-welcome-gate-mid' }, [pagesWrap, nav]);

  const skipButton = dom('button', { class: 'bc-welcome-gate-button', type: 'button' }, ['SKIP']) as HTMLButtonElement;
  const bottomArea = dom('div', { class: 'bc-welcome-gate-bottom' }, [skipButton]);

  card.append(createWelcomeBackground(), topArea, midArea, bottomArea);
  overlay.appendChild(backdrop);
  overlay.appendChild(card);

  let mountedRoot: HTMLElement | null = null;
  let visible = false;
  let pageIndex = 0;
  const lastIndex = pages.length - 1;

  const renderPage = (): void => {
    pages.forEach((pageEl, i) => pageEl.classList.toggle('is-active', i === pageIndex));
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === pageIndex));
    backButton.disabled = pageIndex === 0;
    nextButton.disabled = pageIndex === lastIndex;
    // On the final page there is nothing left to skip, so the dismiss button reads "LET'S GO".
    skipButton.textContent = pageIndex === lastIndex ? "LET'S GO" : 'SKIP';
    pagesWrap.scrollTop = 0;
  };

  const goTo = (index: number): void => {
    pageIndex = Math.max(0, Math.min(lastIndex, index));
    renderPage();
  };

  const hide = (): void => {
    visible = false;
    overlay.classList.remove('is-visible');
    mountedRoot?.classList.remove('bc-panel-welcome-open');
  };

  const show = (): void => {
    visible = true;
    goTo(0);
    overlay.classList.add('is-visible');
    mountedRoot?.classList.add('bc-panel-welcome-open');
    skipButton.focus();
  };

  const finish = (): void => {
    void (async () => {
      if (currentVersion) {
        await writeLastSeenVersion(currentVersion);
      }
      await clearPendingWelcomeVersion();
      hide();
    })();
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

  backButton.addEventListener('click', () => goTo(pageIndex - 1));
  nextButton.addEventListener('click', () => goTo(pageIndex + 1));
  skipButton.addEventListener('click', finish);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' && pageIndex < lastIndex) {
      goTo(pageIndex + 1);
    } else if (event.key === 'ArrowLeft' && pageIndex > 0) {
      goTo(pageIndex - 1);
    }
  });

  // Trackpad horizontal swipe → page navigation. After a swipe fires we disarm, and only
  // re-arm once the wheel deltas decay back below a small floor — i.e. when the flick's
  // momentum has died out (which happens on its own, so the cursor never has to move) or when
  // events stop entirely (trailing idle timer). This is what makes one physical swipe move
  // exactly one page. Vertical intent is left alone so the pages region can still scroll.
  const SWIPE_TRIGGER = 40;
  const SWIPE_REARM_FLOOR = 4;
  let swipeAccum = 0;
  let swipeArmed = true;
  let swipeIdleTimer = 0;
  const rearmSwipe = (): void => {
    swipeArmed = true;
    swipeAccum = 0;
  };
  card.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) {
      return;
    }
    event.preventDefault();
    window.clearTimeout(swipeIdleTimer);
    swipeIdleTimer = window.setTimeout(rearmSwipe, 150);
    if (!swipeArmed) {
      if (Math.abs(event.deltaX) < SWIPE_REARM_FLOOR) {
        rearmSwipe();
      }
      return;
    }
    swipeAccum += event.deltaX;
    if (Math.abs(swipeAccum) > SWIPE_TRIGGER) {
      goTo(pageIndex + (swipeAccum > 0 ? 1 : -1));
      swipeArmed = false;
      swipeAccum = 0;
    }
  }, { passive: false });

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
