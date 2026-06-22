import { dom, injectStylesheet } from '@/utils/dom';
import { copyThemeVars } from '@/utils/theme';

const WHY_TWO_KEYS_STYLE_ID = 'bc-player-why-two-keys-styles';
const SIDE_GAP_PX = 8;
const PANEL_THEME_VARS = [
  '--panel-border',
  '--panel-text',
  '--panel-text-dim',
  '--panel-surface-blur',
  '--panel-surface-sheen',
  '--panel-surface-bg',
  '--panel-header-bg',
  '--panel-body-bg',
] as const;

const WHY_TWO_KEYS_CSS = `
.bc-why-two-keys {
  position: fixed;
  z-index: 2147483010;
  display: none;
  box-sizing: border-box;
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  overflow: hidden;
  pointer-events: auto;
  user-select: none;
  color: var(--panel-text);
  background: transparent;
  backdrop-filter: blur(20.8px) saturate(130%);
  -webkit-backdrop-filter: blur(20.8px) saturate(130%);
  box-shadow: none;
}

.bc-why-two-keys.is-visible {
  display: flex;
}

.bc-why-two-keys-card {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 0;
  border-radius: inherit;
  box-shadow: none;
  color: var(--panel-text, #1f2228);
}

.bc-why-two-keys-header {
  position: relative;
  z-index: 9;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 16px 12px 18px;
  background: var(--panel-header-bg);
  box-shadow: var(--panel-surface-sheen);
  backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
  -webkit-backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
}

.bc-why-two-keys-title {
  font-size: 18px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: 0.1px;
}

.bc-why-two-keys-body {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  margin-top: 0;
  padding: 14px 16px 16px 18px;
  background: var(--panel-body-bg);
  backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
  -webkit-backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
  font-size: 14px;
  line-height: 1.6;
  color: var(--panel-text-dim, #1f2228);
  overflow: auto;
  box-sizing: border-box;
}

.bc-why-two-keys-body p {
  margin: 0 0 10px;
}

.bc-why-two-keys-body p:last-child {
  margin-bottom: 0;
}

.bc-why-two-keys-body h3 {
  margin: 12px 0 6px;
  font-size: 13px;
  line-height: 1.25;
  font-weight: 700;
  letter-spacing: 0.08px;
  color: var(--panel-text, #1f2228);
}

.bc-why-two-keys-body strong {
  font-weight: 700;
  color: var(--panel-text, #1f2228);
}

.bc-why-two-keys-close {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  border-radius: 7px;
  min-width: 14px;
}

.bc-why-two-keys-close .bc-header-icon-glyph-close {
  font-size: 8px;
  font-weight: 650;
  transform: translateY(-0.4px);
}
`;

export interface WhyTwoKeysPanelController {
  toggle(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createWhyTwoKeysPanel(anchorRoot: HTMLElement): WhyTwoKeysPanelController {
  injectStylesheet(WHY_TWO_KEYS_STYLE_ID, WHY_TWO_KEYS_CSS);

  const panel = dom('section', { class: 'bc-why-two-keys', role: 'dialog', 'aria-label': 'About' });
  const card = dom('div', { class: 'bc-why-two-keys-card' });
  const header = dom('div', { class: 'bc-why-two-keys-header' });
  const title = dom('div', { class: 'bc-why-two-keys-title' }, ['About Bandcamp Deck']);
  const closeButton = dom(
    'span',
    {
      class: 'bc-header-icon bc-header-icon-close bc-why-two-keys-close',
      title: 'Close',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Close About panel'
    },
    [dom('span', { class: 'bc-header-icon-glyph bc-header-icon-glyph-close', 'aria-hidden': 'true' }, ['✕'])]
  );
  const body = dom('div', { class: 'bc-why-two-keys-body' }, [
    dom('p', {}, [
      'Bandcamp Deck runs its ',
      dom('strong', {}, ['own audio engine']),
      ': once a stream starts, the extension takes playback over from Bandcamp’s player so it can ',
      'change tempo, seek precisely, render an accurate waveform, and preload upcoming tracks.'
    ]),
    dom('p', {}, [
      'Two open-source projects make these core features possible. ',
      dom('strong', {}, ['Signalsmith Stretch']),
      ' powers Tempo Adjust, speeding a track to a target BPM without changing its pitch. ',
      dom('strong', {}, ['Essentia']),
      ' powers the BPM, key, and waveform analysis, working on the decoded audio itself.'
    ]),
    dom('p', {}, [
      'Running real audio analysis in the browser makes Bandcamp Deck fairly resource intensive, ',
      'so a fast CPU helps and your machine may get warm. Bandcamp can also slow down under heavy ',
      'traffic, so avoid skipping between tracks too quickly.'
    ]),
    dom('p', {}, [
      'Preloading upcoming tracks also uses a fair amount of ',
      dom('strong', {}, ['memory']),
      ', kept within a budget and released when no longer needed. On Chrome, an optional ',
      dom('strong', {}, ['Performance mode']),
      ' prepares more tracks ahead for faster navigation, at the cost of more memory — off by ',
      'default, for machines with plenty of RAM (around ',
      dom('strong', {}, ['16 GB or more']),
      ').'
    ]),
    dom('h3', {}, ['About Key Analysis']),
    dom('p', {}, [
      dom('strong', {}, ['Key detection is not fully objective']),
      ': tools like Rekordbox and Mixed In Key analyze music differently and can disagree on the ',
      'same track without either being wrong. Bandcamp Deck may therefore show ',
      dom('strong', {}, ['two keys']),
      ' — the first is the ',
      dom('strong', {}, ['main harmonic center']),
      ', the second a secondary one. If they are close, the track moves between two tonal centers; ',
      'if the first is clearly stronger, treat it as the main key.'
    ]),
  ]);

  header.appendChild(title);
  header.appendChild(closeButton);
  card.appendChild(header);
  card.appendChild(body);
  panel.appendChild(card);
  document.body.appendChild(panel);

  let open = false;

  const syncThemeTokens = (): void => copyThemeVars(anchorRoot, panel, PANEL_THEME_VARS);

  const syncGeometry = (): void => {
    const rect = anchorRoot.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const left = Math.max(8, Math.round(rect.left - width - SIDE_GAP_PX));
    const top = Math.max(8, Math.round(rect.top));
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const setOpen = (nextOpen: boolean): void => {
    open = nextOpen;
    panel.classList.toggle('is-visible', open);
    if (open) {
      syncThemeTokens();
      syncGeometry();
    }
  };

  const onClose = (): void => setOpen(false);
  closeButton.addEventListener('click', onClose);
  closeButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    onClose();
  });

  const syncOpenPanel = (): void => {
    if (open) {
      syncThemeTokens();
      syncGeometry();
    }
  };

  const resizeObserver = new ResizeObserver(() => {
    syncOpenPanel();
  });
  resizeObserver.observe(anchorRoot);
  const panelMain = anchorRoot.querySelector('.bc-panel-main');
  if (panelMain instanceof HTMLElement) {
    resizeObserver.observe(panelMain);
  }

  const mutationObserver = new MutationObserver(() => {
    syncOpenPanel();
  });
  mutationObserver.observe(anchorRoot, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['style', 'class']
  });

  const onWindowResize = (): void => {
    if (open) {
      syncThemeTokens();
      syncGeometry();
    }
  };
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('scroll', onWindowResize, true);

  return {
    toggle(): void {
      setOpen(!open);
    },
    close(): void {
      setOpen(false);
    },
    isOpen(): boolean {
      return open;
    },
    destroy(): void {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onWindowResize, true);
      panel.remove();
      open = false;
    },
  };
}
