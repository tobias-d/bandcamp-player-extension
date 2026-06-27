export const PANEL_SHELL_CSS = `
/* Design tokens (custom properties) live in src/ui/styles/tokens.ts and are
   injected first; the rules below consume them. */

/* ─── Root panel shell ─────────────────────────────────────────────── */
.bc-panel-root {
  position: fixed;
  right: 24px;
  top: 24px;
  width: 360px;
  max-width: calc((100vw - 32px) / var(--panel-scale));
  z-index: 2147483000;
  font-family: var(--font-mono);
  border: 1px solid var(--panel-border);
  border-radius: var(--panel-radius-card);
  box-shadow: none;
  overflow: hidden;
  user-select: none;
  color: var(--panel-text);
  /* Glass surface: tint/blur are tunable via Alt+G (src/ui/glass/). Fallback
     values mirror GLASS_DEFAULTS in glass-settings.ts. On Chrome,
     glass-effect.ts overrides this backdrop-filter inline with the SVG
     refraction chain; this rule is the Firefox path and the pre-init state.
     The grey camouflage dapple is a separate .bc-glass-camo layer (glass.ts /
     glass-effect.ts), not part of this tint. */
  background: rgba(247, 240, 240, var(--glass-tint, 0.65));
  backdrop-filter: blur(var(--glass-blur, 6.5px));
  -webkit-backdrop-filter: blur(var(--glass-blur, 6.5px));
  /* --panel-drag-x/y carry the live drag offset as a compositor-only translate
     (set per frame by makeDraggable in panel.ts); 0px at rest. translate3d
     keeps the layer promotion translateZ(0) used to provide. */
  transform: translate3d(var(--panel-drag-x, 0px), var(--panel-drag-y, 0px), 0) scale(var(--panel-scale));
  transform-origin: top right;
}

.bc-panel-root.bc-panel-info-open {
  z-index: 2147483006;
}

.bc-panel-root,
.bc-panel-root * {
  text-decoration: none !important;
}

.bc-shortcuts-host {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2147483005;
  font-family: var(--font-mono);
  color: var(--panel-text);
  user-select: none;
  pointer-events: none;
  --shortcuts-host-scale: var(--panel-scale);
}

.bc-shortcuts-host,
.bc-shortcuts-host * {
  text-decoration: none !important;
}

.bc-shortcuts-host .bc-shortcuts-panel {
  pointer-events: auto;
  transform: scale(var(--shortcuts-host-scale));
  transform-origin: top left;
}

.bc-resize-handle {
  position: absolute;
  width: 10px;
  height: 10px;
  z-index: 4;
  pointer-events: auto;
}

.bc-resize-handle-top-left {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}

.bc-resize-handle-top-right {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}

.bc-resize-handle-bottom-left {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}

.bc-resize-handle-bottom-right {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}

/* ─── Container A: 2x2 header ─────────────────────────────────────── */
.bc-panel-header {
  position: relative;
  z-index: 9;
  display: block;
  min-height: var(--panel-header-height);
  background: transparent;
  border-bottom: 0;
  cursor: grab;
  box-shadow: var(--panel-surface-sheen);
}
.bc-panel-header:active { cursor: grabbing; }

.bc-header-meta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--header-metadata-side-width);
  grid-template-areas:
    "artist artist"
    "album like"
    "track date";
  column-gap: 10px;
  row-gap: 6px;
  align-items: center;
  align-content: start;
  padding: 15px var(--panel-content-inset) 11px 14px;
  min-height: var(--panel-header-height);
  box-sizing: border-box;
  min-width: 0;
  overflow: hidden;
}

.bc-header-icons {
  position: absolute;
  top: 9px;
  right: var(--panel-content-inset);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  align-items: stretch;
  width: 55.65px;
  height: 16.8px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: rgba(14, 16, 20, 0.05);
  overflow: hidden;
  cursor: default;
}

.bc-header-album-like,
.bc-header-album-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 var(--header-album-action-size);
  width: var(--header-album-action-size);
  min-width: var(--header-album-action-size);
  max-width: var(--header-album-action-size);
  height: var(--header-album-action-size);
  min-height: var(--header-album-action-size);
  max-height: var(--header-album-action-size);
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  color: var(--panel-text-bright);
  line-height: 1;
  vertical-align: middle;
}

.bc-header-album-like {
  border-radius: 999px !important;
}

.bc-header-album-like:hover,
.bc-header-album-open:hover,
.bc-header-album-open:focus-visible {
  transform: none;
  background: transparent !important;
  box-shadow: none !important;
  outline: none;
}

.bc-header-album-like.bc-btn-album-like-idle {
  visibility: hidden;
  pointer-events: none;
}

.bc-header-album-like .bc-heart-symbol {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--header-album-action-glyph-size);
  height: var(--header-album-action-glyph-size);
  font-size: var(--header-album-action-glyph-size);
  line-height: 1;
}

.bc-metadata-artist {
  grid-area: artist;
  letter-spacing: 0.14px;
  color: var(--panel-text-bright);
  white-space: nowrap;
  overflow: hidden;
}

.bc-metadata-album {
  grid-area: album;
  grid-column: 1 / -1;
  letter-spacing: 0.14px;
  color: var(--panel-text-bright);
  min-width: 0;
}

.bc-metadata-artist {
  font-size: 16.8px;
  font-weight: 700;
  width: calc(100% - 74px);
  max-width: calc(100% - 74px);
  box-sizing: border-box;
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .bc-metadata-artist.bc-metadata-loading .bc-metadata-marquee-text {
    background-image: linear-gradient(
      90deg,
      transparent 0%,
      transparent 26%,
      var(--panel-text-dim) 40%,
      var(--panel-text-dim) 60%,
      transparent 74%,
      transparent 100%
    );
    background-size: 220% 100%;
    background-position: 120% 0;
    background-repeat: no-repeat;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    color: transparent;
    animation: bc-pl-loading-wave 2.8s linear infinite;
  }
}

.bc-metadata-album {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: calc(var(--header-album-actions-width) + 6px);
  box-sizing: border-box;
  font-size: 14px;
  font-weight: 400;
}

.bc-metadata-album-leading {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 14px;
  margin-left: -2px;
}

.bc-metadata-album-trailing {
  grid-area: like;
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  width: var(--header-album-actions-width);
  min-height: calc((var(--heart-symbol-size) * 1.55) + 4px);
  line-height: 1;
  justify-self: end;
  align-self: center;
}

.bc-header-album-open {
  text-decoration: none;
}

.bc-header-album-open-disabled {
  visibility: hidden;
  pointer-events: none;
}

.bc-header-album-open-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 calc(var(--header-album-action-glyph-size) * 0.85);
  width: calc(var(--header-album-action-glyph-size) * 0.85);
  height: calc(var(--header-album-action-glyph-size) * 0.85);
  line-height: 1;
  opacity: 0.78;
  pointer-events: none;
}

.bc-header-album-open-icon {
  display: block;
  width: 100%;
  height: 100%;
}

.bc-header-album-open:hover .bc-header-album-open-glyph,
.bc-header-album-open:focus-visible .bc-header-album-open-glyph {
  opacity: 0.52;
}

.bc-metadata-album-text {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 0;
  flex: 1 1 auto;
}

.bc-metadata-album-title {
  min-width: 0;
  white-space: nowrap;
  flex: 1 1 auto;
}

.bc-metadata-track {
  grid-area: track;
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  align-self: end;
  padding-right: calc(var(--header-release-date-reserved-width) + 8px);
  box-sizing: border-box;
  font-size: 14px;
  font-weight: 650;
  line-height: 1.15;
  min-width: 0;
}

.bc-metadata-track-title {
  min-width: 0;
  flex: 1 1 auto;
  white-space: nowrap;
}

.bc-metadata-marquee {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent 100%);
}

.bc-metadata-marquee-text {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.bc-metadata-marquee-overflowing .bc-metadata-marquee-text {
  max-width: none;
  overflow: visible;
  text-overflow: clip;
  animation: bcMetadataMarquee var(--bc-metadata-marquee-duration, 9s) ease-in-out infinite alternate;
}

@keyframes bcMetadataMarquee {
  0%, 18% {
    transform: translateX(0);
  }
  82%, 100% {
    transform: translateX(calc(-1 * var(--bc-metadata-marquee-distance, 0px)));
  }
}

.bc-metadata-release-date {
  grid-area: date;
  box-sizing: border-box;
  display: block;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  overflow: visible;
  text-overflow: clip;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 400;
  font-style: italic;
  line-height: 1.15;
  color: var(--panel-text-dim);
  justify-self: end;
  align-self: end;
  text-align: right;
}

.bc-metadata-release-date-empty {
  visibility: hidden;
}

.bc-metadata-artist.bc-metadata-idle {
  visibility: hidden;
}

.bc-metadata-album.bc-metadata-idle {
  justify-content: center;
  padding-right: 0;
  font-family: var(--font-display);
  font-size: 25px;
  font-weight: 700;
  font-style: normal;
  line-height: 1.05;
  letter-spacing: 0;
  color: var(--panel-text-bright);
  text-align: center;
  /* Slightly see-through so the glass surface reads behind the idle text. */
  opacity: 0.78;
}

/* Tint the "//" separator a dark grey so it reads as a divider, not a letter. */
.bc-metadata-album.bc-metadata-idle .bc-deck-sep {
  color: #6b6b6b;
  -webkit-text-fill-color: currentColor;
}

.bc-metadata-album.bc-metadata-idle .bc-metadata-album-text {
  flex: 0 1 auto;
  justify-content: center;
}

.bc-metadata-album.bc-metadata-idle .bc-metadata-marquee {
  overflow: visible;
  -webkit-mask-image: none;
  mask-image: none;
}

.bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text {
  position: relative;
  max-width: none;
  overflow: visible;
  text-overflow: clip;
  color: #2b2b2b;
  -webkit-text-fill-color: currentColor;
  /* Letterpress / printing-press effect: the dark wordmark reads as pressed into
     the light glass. A light highlight on the bottom edge is the lit lower lip of
     the impression; a faint dark cast on top gives it depth. Inherits onto the
     "//" separator too. (text-shadow is auto-dropped in forced-colors mode.) */
  text-shadow:
    0 1px 0 rgba(255, 255, 255, 0.65),
    0 -1px 1px rgba(0, 0, 0, 0.12);
}

.bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text::after {
  content: 'BANDCAMP // DECK';
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* The shine overlay sits exactly over the base text; keep the letterpress
     shadow on the base glyphs only so the sweep stays a clean highlight. */
  text-shadow: none;
  background-image: linear-gradient(
    100deg,
    transparent 0%,
    transparent 40%,
    rgba(190, 190, 190, 0.12) 46%,
    rgba(238, 238, 238, 0.82) 50%,
    rgba(190, 190, 190, 0.12) 54%,
    transparent 60%,
    transparent 100%
  );
  background-size: 280% 100%;
  background-position: 150% 0;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  animation: bcDeckTextShine 5s ease-in-out infinite;
}

@keyframes bcDeckTextShine {
  0%,
  8% {
    background-position: 150% 0;
  }
  92%,
  100% {
    background-position: -150% 0;
  }
}

.bc-metadata-track.bc-metadata-idle {
  font-style: italic;
  font-weight: 500;
  color: var(--panel-text-dim);
}

.bc-panel-root.bc-panel-idle .bc-transport-pill,
.bc-panel-root.bc-panel-idle .bc-pl-header {
  filter: grayscale(1);
  opacity: 0.46;
}

.bc-panel-root.bc-panel-idle .bc-transport-pill {
  background: rgba(14, 16, 20, 0.035);
}

@media (prefers-reduced-motion: reduce) {
  .bc-metadata-artist.bc-metadata-loading .bc-metadata-marquee-text {
    animation: none;
    color: var(--panel-text-dim);
    -webkit-text-fill-color: currentColor;
  }

  .bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text {
    color: #2b2b2b;
    -webkit-text-fill-color: currentColor;
  }

  .bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text::after {
    content: none;
  }
}

@media (forced-colors: active) {
  .bc-metadata-artist.bc-metadata-loading .bc-metadata-marquee-text {
    background: none;
    color: var(--panel-text-dim);
    -webkit-text-fill-color: currentColor;
  }

  .bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text {
    color: CanvasText;
    -webkit-text-fill-color: currentColor;
  }

  .bc-metadata-album.bc-metadata-idle .bc-metadata-marquee-text::after {
    content: none;
  }
}

.bc-header-icon {
  width: 100%;
  height: 100%;
  font-size: 9.45px; color: var(--panel-icon);
  cursor: pointer; line-height: 1; transition: color var(--panel-duration-fast);
  border-radius: 0;
  background: transparent;
  border: 0;
  padding: 0;
  box-sizing: border-box;
  background-clip: content-box;
  display: flex; align-items: center; justify-content: center;
  transition: color var(--panel-duration-fast), background var(--panel-duration-fast), border-color var(--panel-duration-fast);
  position: relative;
}

.bc-header-icon-info {
  padding: 0;
}

.bc-header-icon-glyph {
  width: 9.45px;
  height: 9.45px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  pointer-events: none;
}

.bc-header-icon-glyph-info {
  font-size: 11.55px;
  font-weight: 700;
  transform: translateY(-0.5px);
}

.bc-header-icon-glyph-close {
  font-size: 9.45px;
  font-weight: 650;
}

.bc-context-popover {
  min-width: 142px;
  padding: 4px;
  border: 1px solid var(--panel-divider);
  border-radius: var(--panel-radius-md);
  background: color-mix(in srgb, var(--panel-surface-bg) 84%, white 16%);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(30px) saturate(150%);
  -webkit-backdrop-filter: blur(30px) saturate(150%);
}

.bc-info-panel {
  position: absolute;
  top: 27px;
  right: 12px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-1px);
  transition: opacity 140ms ease, transform 140ms ease, visibility 0s linear 140ms;
  z-index: 12;
}

.bc-info-panel-open {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: translateY(0);
  transition: opacity 140ms ease, transform 140ms ease, visibility 0s linear 0s;
}

.bc-info-byline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 6px 5px 6px;
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0;
  line-height: 1.2;
  color: var(--panel-text);
  border-bottom: 1px solid var(--panel-divider);
  opacity: 1;
}

.bc-info-byline-author {
  min-width: 0;
}

.bc-info-byline-version {
  flex: 0 0 auto;
  text-align: right;
  opacity: 0.78;
}

.bc-info-link {
  display: block;
  padding: 5px 6px;
  border-radius: var(--panel-radius-sm);
  font-size: 11px;
  font-weight: 550;
  line-height: 1.2;
  color: var(--panel-text);
  text-decoration: none;
}

.bc-info-link-why-two-keys {
  color: #2f6df6;
}

.bc-info-link:hover {
  background: color-mix(in srgb, var(--panel-surface-active) 64%, transparent);
  text-decoration: none;
}

.bc-header-icon-svg {
  width: 10.5px;
  height: 10.5px;
  display: block;
  margin: 0 auto;
  object-fit: contain;
  object-position: center;
  pointer-events: none;
}

.bc-header-icon + .bc-header-icon::before {
  content: '';
  position: absolute;
  left: 0;
  top: 15%;
  width: 1px;
  height: 70%;
  background: var(--panel-divider);
  pointer-events: none;
}

@keyframes bcInfoEdgeSpin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.bc-header-icon-info::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 999px 0 0 999px;
  padding: 1px;
  background: conic-gradient(
    from 0deg,
    rgba(203, 112, 255, 0.96) 0deg,
    rgba(242, 96, 194, 0.96) 120deg,
    rgba(203, 112, 255, 0.96) 240deg,
    rgba(242, 96, 194, 0.96) 360deg
  );
  opacity: 0;
  transition: opacity 160ms ease;
  pointer-events: none;
  z-index: 0;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
}

.bc-header-icon:hover {
  color: inherit;
  background: rgba(14, 16, 20, 0.08);
}
.bc-header-icon-info:hover {
  background: rgba(255, 255, 255, 0.30);
  color: rgba(64, 18, 86, 0.96);
}
.bc-header-icon-info:hover::after,
.bc-header-icon-info.bc-header-icon-active::after {
  opacity: 1;
  animation: bcInfoEdgeSpin 1.2s linear infinite;
}
.bc-header-icon.bc-header-icon-active {
  background: rgba(14, 16, 20, 0.14);
}
.bc-header-icon-info.bc-header-icon-active {
  background: rgba(255, 255, 255, 0.30);
  color: rgba(64, 18, 86, 0.96);
}
.bc-header-icon-close:hover { color: var(--panel-text-bright); }

.bc-settings-slot {
  position: absolute;
  top: 27px;
  right: var(--panel-content-inset);
  z-index: 12;
}

.bc-heart-symbol {
  font-size: var(--heart-symbol-size);
  line-height: 1;
  display: block;
  pointer-events: none;
}

/* ─── Frosted glass body ────────────────────────────────────────────── */
.bc-panel-main {
  position: relative;
  z-index: 1;
  --panel-stack-gap: 12px;
  --transport-side-inset: var(--panel-content-inset);
  background: transparent;
  border-top: 0;
  padding-top: 8px;
  box-shadow: none;
}

/* Inner containers stay transparent so the panel surface remains visible */
.bc-waveform-stub,
.bc-controls-row,
.bc-transport-inner,
.bc-tap-stub,
.bc-pl-header,
.bc-pl-track {
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
}

`;
