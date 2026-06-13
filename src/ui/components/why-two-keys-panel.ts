import { dom, injectStylesheet } from '@/utils/dom';

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
      'Bandcamp Deck adds BPM analysis, key analysis, waveform detail, Tempo Adjust, and Wishlist interaction.'
    ]),
    dom('p', {}, [
      'Some of these features may look simple on the surface, but there is a lot happening underneath. ',
      'The extension builds on two sophisticated audio projects: ',
      dom('strong', {}, ['Essentia']),
      ' powers the BPM and key analysis, while ',
      dom('strong', {}, ['SignalSmith']),
      ' powers the high-quality time-stretching used for Tempo Adjust.'
    ]),
    dom('p', {}, [
      'Because these features rely on multiple audio calculations, Bandcamp Deck can be fairly resource intensive. ',
      'For the smoothest experience, a fast CPU is recommended. ',
      'You also should not be surprised if your machine gets warm and the fans start running while the extension is working. ',
      'That is expected.'
    ]),
    dom('p', {}, [
      'Bandcamp itself is not always at its fastest when site traffic is high. ',
      'Since Bandcamp Deck also makes many requests for analysis and metadata, browsing can feel a bit slower during those moments. ',
      'When that happens, it is also not recommended to switch between tracks excessively fast.'
    ]),
    dom('p', {}, [
      'BPM analysis can also be less reliable on very fast tracks, especially once the tempo goes above ',
      dom('strong', {}, ['150 BPM']),
      '.'
    ]),
    dom('h3', {}, ['On Key Analysis']),
    dom('p', {}, [
      'Apps like Rekordbox, Mixed In Key, and similar tools can return different key results for the same track, and that does not automatically mean one result is wrong. ',
      dom('strong', {}, ['Key detection is not a fully objective measurement']),
      ': different tools analyze music in different ways, focus on different parts of a track, and apply different decision rules. ',
      'For that reason, Bandcamp Deck can show ',
      dom('strong', {}, ['two keys']),
      ' instead of forcing everything into a single answer. ',
      'Electronic tracks can have more than one strong tonal center, so the analysis looks across multiple sections of the track, reduces the influence of weak or ambiguous moments, and highlights the strongest key candidates. ',
      'The first key should be understood as the ',
      dom('strong', {}, ['main harmonic center']),
      ', while the second represents an important secondary one. If both are close, the track is likely moving between ',
      dom('strong', {}, ['two tonal centers']),
      '. If the first is clearly stronger, it should be treated as the main key.'
    ]),
  ]);

  header.appendChild(title);
  header.appendChild(closeButton);
  card.appendChild(header);
  card.appendChild(body);
  panel.appendChild(card);
  document.body.appendChild(panel);

  let open = false;

  const syncThemeTokens = (): void => {
    const styles = window.getComputedStyle(anchorRoot);
    for (const variable of PANEL_THEME_VARS) {
      const value = styles.getPropertyValue(variable).trim();
      if (value) {
        panel.style.setProperty(variable, value);
      }
    }
  };

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
