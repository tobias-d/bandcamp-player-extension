/* ─── Design tokens ──────────────────────────────────────────────────
   Single source of truth for the injected panel's custom properties.
   Light-mode defaults live on the panel roots; dark-mode overrides set
   theme-specific values on .bc-theme-dark. Non-theme tokens (radii,
   motion, blur recipe) are declared once in the light block and inherit
   into dark, since they do not change between themes.

   This block was previously inlined at the top of panel-shell.ts; it is
   split out so the vocabulary is discoverable in one place. The debug
   panel keeps its own token subset (see debug-panel.ts) because it mounts
   on a separate root governed by rules/debugger-rules.md.
──────────────────────────────────────────────────────────────────── */
export const TOKENS_CSS = `
.bc-panel-root,
.bc-shortcuts-host,
.bc-appearance-panel {
  --panel-scale:      1.15;
  --panel-header-height: 88px;
  --panel-content-inset: 10px;
  --header-album-action-glyph-size: calc(var(--heart-symbol-size) * 1.55);
  --header-album-action-size: calc(var(--header-album-action-glyph-size) + 4px);
  --header-album-actions-width: calc((var(--header-album-action-size) * 2) + 4px);
  --header-metadata-side-width: 19ch;
  --header-release-date-reserved-width: 104px;
  --panel-surface-bg:  rgba(247, 240, 240, 0.58);
  --panel-glass-soft-bg: rgba(184, 173, 173, 0.025);
  --panel-surface-hover: var(--panel-surface-bg);
  --panel-surface-active: var(--panel-surface-bg);
  --panel-border:      rgba(88, 88, 88, 0.44);
  --panel-header-bg:   var(--panel-surface-bg);
  --panel-body-bg:     var(--panel-surface-bg);
  --panel-divider:     rgba(78, 86, 97, 0.24);
  --panel-text:        #1f2228;
  --panel-text-bright: #1f2228;
  --panel-text-dim:    #1f2228;
  --panel-icon:        #1f2228;
  --panel-waveform-bg: #4a4747;
  --panel-wf-bg:       var(--panel-surface-bg);
  --panel-track-bg:    var(--panel-surface-bg);
  --panel-track-hover: var(--panel-surface-bg);
  --panel-active-bg:   var(--panel-surface-bg);
  --panel-like:        #363636;
  --panel-like-empty:  #363636;
  --panel-like-wishlist: #F5BC38;
  --panel-like-collection: #D6110B;
  --panel-accent:      #1f2228;
  --panel-accent-soft: var(--panel-surface-active);
  --panel-surface-bg-strong: var(--panel-surface-bg);
  --panel-surface-blur: 10.4px;
  --panel-surface-sheen: 0 1px 0 rgba(255, 255, 255, 0.22) inset;
  --panel-scroll-thumb: rgba(93, 102, 114, 0.42);
  --panel-scroll-thumb-hover: rgba(93, 102, 114, 0.62);
  --panel-waveform-grad-top: rgba(156, 143, 134, 0.035);
  --panel-waveform-grad-bottom: rgba(184, 173, 173, 0.015);
  --wave-baseline:     rgba(0, 0, 0, 0.10);
  --wave-future-low:   #59486f;
  --wave-future-mid:   #716aa9;
  --wave-future-high:  #af9bd3;
  --wave-past-low:     rgba(80, 80, 80, 0.55);
  --wave-past-mid:     rgba(110, 110, 110, 0.50);
  --wave-past-high:    rgba(140, 140, 140, 0.45);
  --wave-played-overlay: rgba(200, 200, 205, 0.12);
  --wave-playhead:     rgba(30, 33, 40, 0.95);
  --wave-outline:      rgba(0, 0, 0, 0.22);
  --bpm-dot:           #1f2228;
  --key-dot:           #1f2228;
  --heart-symbol-size: 13px;
  --font-display:      'Bandcamp Deck Lexend', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-mono:         -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-playtime:     'Bandcamp Deck Roboto Mono', ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;
  /* Corner radii — see frequency clusters across the style modules */
  --panel-radius-pill: 999px;
  --panel-radius-card: 14px;
  --panel-radius-lg:   10px;
  --panel-radius-md:   8px;
  --panel-radius-sm:   6px;
  /* Motion */
  --panel-duration-fast: 0.12s;
  /* Surface blur recipe (paired with -webkit- prefix at call sites) */
  --panel-blur-surface: blur(var(--panel-surface-blur)) saturate(125%);
}

.bc-panel-root.bc-theme-dark,
.bc-shortcuts-host.bc-theme-dark {
  --panel-scale:      1.15;
  --panel-header-height: 88px;
  --panel-content-inset: 10px;
  --header-album-action-glyph-size: calc(var(--heart-symbol-size) * 1.55);
  --header-album-action-size: calc(var(--header-album-action-glyph-size) + 4px);
  --header-album-actions-width: calc((var(--header-album-action-size) * 2) + 4px);
  --header-metadata-side-width: 19ch;
  --header-release-date-reserved-width: 104px;
  --panel-surface-bg:  rgba(247, 240, 240, 0.58);
  --panel-glass-soft-bg: rgba(184, 173, 173, 0.025);
  --panel-surface-hover: var(--panel-surface-bg);
  --panel-surface-active: var(--panel-surface-bg);
  --panel-border:      rgba(88, 88, 88, 0.44);
  --panel-header-bg:   var(--panel-surface-bg);
  --panel-body-bg:     var(--panel-surface-bg);
  --panel-divider:     rgba(180, 191, 211, 0.2);
  --panel-text:        #1f2228;
  --panel-text-bright: #1f2228;
  --panel-text-dim:    #1f2228;
  --panel-icon:        #1f2228;
  --panel-waveform-bg: #4a4747;
  --panel-wf-bg:       var(--panel-surface-bg);
  --panel-track-bg:    var(--panel-surface-bg);
  --panel-track-hover: var(--panel-surface-bg);
  --panel-active-bg:   var(--panel-surface-bg);
  --panel-like:        #363636;
  --panel-like-empty:  #363636;
  --panel-like-wishlist: #F5BC38;
  --panel-like-collection: #D6110B;
  --panel-accent:      #1f2228;
  --panel-accent-soft: var(--panel-surface-active);
  --panel-surface-bg-strong: var(--panel-surface-bg);
  --panel-surface-blur: 10.4px;
  --panel-surface-sheen: 0 1px 0 rgba(255, 255, 255, 0.16) inset;
  --panel-scroll-thumb: rgba(169, 180, 197, 0.42);
  --panel-scroll-thumb-hover: rgba(189, 199, 216, 0.62);
  --panel-waveform-grad-top: rgba(156, 143, 134, 0.035);
  --panel-waveform-grad-bottom: rgba(184, 173, 173, 0.015);
  --bpm-dot:           #1f2228;
  --key-dot:           #1f2228;
}
`;
