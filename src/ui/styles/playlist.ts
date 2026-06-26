export const PLAYLIST_CSS = `
/* ─── Playlist ──────────────────────────────────────────────────────── */
.bc-playlist { display: flex; flex-direction: column; }
.bc-playlist {
  --pl-row-height: calc((23px * 1.15) * 1.1);
  --pl-header-height: 30px;
  --pl-select-columns: 26px 1fr 36px 36px;
  --pl-metadata-columns: 42px 38px 20px 24px;
  --pl-columns: var(--pl-select-columns) var(--pl-metadata-columns);
  --pl-columns-no-key: 26px 1fr 0px 0px var(--pl-metadata-columns);
  --pl-row-padding-x: 10px;
  --pl-scrollbar-width: 8px;
  --pl-scrollbar-gutter-width: 0px;
}

.bc-playlist.bc-key-disabled {
  --pl-select-columns: 26px 1fr 0px 0px;
  --pl-columns: var(--pl-columns-no-key);
}

/* Lite mode: collapse the BPM column (the first metadata column) and hide its cells. */
.bc-playlist.bc-bpm-disabled {
  --pl-metadata-columns: 0px 38px 20px 24px;
}

.bc-playlist.bc-bpm-disabled .bc-pl-col-bpm,
.bc-playlist.bc-bpm-disabled .bc-pl-bpm {
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.bc-pl-list {
  overflow-y: hidden;
  scrollbar-gutter: stable;
  max-height: calc(var(--pl-row-height) * 4);
  scrollbar-width: thin;
  scrollbar-color: var(--panel-scroll-thumb) transparent;
}

.bc-playlist.bc-playlist-scrollable .bc-pl-list {
  overflow-y: auto;
}

.bc-pl-list::-webkit-scrollbar {
  width: var(--pl-scrollbar-width);
}

.bc-pl-list::-webkit-scrollbar-track {
  background: transparent;
  border-radius: 999px;
}

.bc-pl-list::-webkit-scrollbar-thumb {
  background: var(--panel-scroll-thumb);
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}

.bc-pl-list::-webkit-scrollbar-corner {
  background: transparent;
}

.bc-playlist.bc-playlist-expanded .bc-pl-list {
  max-height: calc(var(--pl-row-height) * 10);
}

.bc-playlist.bc-playlist-ready-reveal .bc-pl-list {
  animation: bc-pl-ready-reveal 170ms cubic-bezier(0.2, 0.8, 0.2, 1);
  transform-origin: top center;
  will-change: clip-path, opacity, filter;
}

@keyframes bc-pl-ready-reveal {
  0% {
    opacity: 0;
    clip-path: inset(0 0 100% 0);
    filter: saturate(0.92);
  }
  100% {
    opacity: 1;
    clip-path: inset(0 0 0 0);
    filter: saturate(1);
  }
}

.bc-pl-header {
  display: grid;
  grid-template-columns: var(--pl-columns);
  height: var(--pl-header-height);
  min-height: var(--pl-header-height);
  max-height: var(--pl-header-height);
  box-sizing: border-box;
  padding: 0 calc(var(--pl-row-padding-x) + var(--pl-scrollbar-gutter-width)) 0 var(--pl-row-padding-x);
  border-top: 1px solid var(--panel-divider);
  border-bottom: 1px solid var(--panel-divider);
  align-items: center;
}

.bc-panel-root.bc-tap-open .bc-pl-header {
  border-top: 0;
}

.bc-pl-col {
  font-size: 10px; color: var(--panel-text-dim);
  text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600;
  cursor: default; display: flex; align-items: center;
}
.bc-pl-sort-col:hover {
  color: var(--panel-text-bright);
  cursor: pointer;
}
.bc-pl-sort-active {
  color: var(--panel-text-bright);
}
.bc-pl-sort-label {
  display: inline-flex;
  align-items: center;
}
.bc-pl-sort-symbol {
  margin-left: 4px;
  opacity: 0.6;
}
.bc-pl-sort-symbol-active {
  opacity: 1;
}

.bc-pl-col-idx,
.bc-pl-col-key,
.bc-pl-col-bpm,
.bc-pl-col-dur,
.bc-pl-col-open,
.bc-pl-col-prep,
.bc-pl-col-like {
  justify-content: center;
  text-align: center;
}

.bc-pl-col-title {
  justify-content: flex-start;
  text-align: left;
}

.bc-pl-col-like .bc-heart-symbol {
  opacity: 0.6;
}

.bc-pl-col-open,
.bc-pl-open {
  transform: translateX(3px);
}

.bc-pl-prep-indicator {
  display: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: #f04438;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.bc-pl-prep-indicator-visible {
  display: inline-flex;
}

.bc-pl-prep-indicator .bc-pl-bpm-loading-icon {
  width: 13px;
  height: 13px;
}

.bc-playlist.bc-key-disabled .bc-pl-col-key,
.bc-playlist.bc-key-disabled .bc-pl-key {
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.bc-pl-track {
  display: grid;
  grid-template-columns: var(--pl-columns);
  box-sizing: border-box;
  height: var(--pl-row-height);
  padding: 0 var(--pl-row-padding-x); align-items: center;
  border-bottom: 1px solid var(--panel-divider);
  transition: background 0.12s, box-shadow 0.12s; cursor: default;
}
.bc-pl-track.bc-pl-track-disabled {
  cursor: default;
  opacity: 0.45;
}
.bc-pl-track.bc-pl-track-disabled .bc-pl-title,
.bc-pl-track.bc-pl-track-disabled .bc-pl-idx,
.bc-pl-track.bc-pl-track-disabled .bc-pl-key,
.bc-pl-track.bc-pl-track-disabled .bc-pl-bpm,
.bc-pl-track.bc-pl-track-disabled .bc-pl-dur,
.bc-pl-track.bc-pl-track-disabled .bc-pl-open,
.bc-pl-track.bc-pl-track-disabled .bc-pl-like {
  color: var(--panel-text-dim);
}
.bc-pl-track.active .bc-pl-title { font-weight: 600; }

.bc-pl-select-target {
  display: grid;
  grid-template-columns: var(--pl-select-columns);
  grid-column: 1 / 5;
  align-items: center;
  height: 100%;
  min-width: 0;
  cursor: pointer;
  outline: none;
}

.bc-pl-track.bc-pl-track-disabled .bc-pl-select-target {
  cursor: default;
}

.bc-pl-select-target:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 52%, transparent);
  outline-offset: -2px;
}

.bc-pl-idx   { font-size: 11px; font-family: var(--font-mono); color: var(--panel-text-dim); text-align: center; }
.bc-pl-title { font-size: 12px; color: var(--panel-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
.bc-pl-title-runtime-pending {
  color: #868686;
}
.bc-pl-title-runtime-text {
  position: relative;
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}
.bc-pl-title-runtime-base {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bc-pl-title-runtime-highlight {
  position: absolute;
  inset: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
  color: #3c3c3c;
  clip-path: inset(0 100% 0 0);
  animation: bc-pl-title-runtime-wave 3000ms linear infinite;
  animation-delay: var(--bc-pl-title-runtime-wave-delay, 0ms);
}
.bc-pl-key   { font-size: 11px; font-family: var(--font-mono); color: var(--panel-text-dim); text-align: center; display: flex; align-items: center; justify-content: center; gap: 5px; }
.bc-pl-key .bc-bpm-confidence-dot {
  width: 6px;
  height: 6px;
}
.bc-pl-key.is-loading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bc-pl-key-text {
  line-height: 1;
}
.bc-pl-bpm   { font-size: 11px; font-family: var(--font-mono); color: var(--panel-text-dim); text-align: center; display: flex; align-items: center; justify-content: center; }
.bc-pl-bpm.is-loading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bc-pl-bpm-loading-icon {
  display: block;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid rgba(6, 6, 6, 0.14);
  border-top-color: rgba(150, 150, 150, 0.78);
  width: 13px;
  height: 13px;
  animation: bc-pl-bpm-loading-spin 1.2s linear infinite;
  transform-origin: center;
}
.bc-pl-bpm.is-failed {
  color: #f04438;
  font-weight: 700;
}
.bc-pl-dur   { font-size: 11px; font-family: var(--font-mono); color: var(--panel-icon); text-align: center; display: flex; align-items: center; justify-content: center; }
.bc-pl-open {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.bc-pl-open-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--panel-text-dim);
  text-decoration: none;
  line-height: 1;
}
.bc-pl-open-link:hover,
.bc-pl-open-link:focus-visible {
  color: var(--panel-text-bright);
  background: rgba(14, 16, 20, 0.06);
  outline: none;
}
.bc-pl-open-icon {
  width: 12px;
  height: 12px;
  display: block;
  opacity: 0.7;
  filter: var(--panel-icon-filter, none);
}
.bc-pl-open-link:hover .bc-pl-open-icon,
.bc-pl-open-link:focus-visible .bc-pl-open-icon {
  opacity: 0.95;
}
.bc-pl-like  {
  text-align: center;
  color: var(--panel-like-empty);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bc-pl-like.disabled {
  cursor: not-allowed;
}
.bc-pl-like.empty .bc-heart-symbol { opacity: 1; }

.bc-pl-empty {
  font-size: 12px; color: var(--panel-text-dim);
  height: var(--pl-row-height);
  min-height: var(--pl-row-height);
  padding: 0 var(--pl-row-padding-x);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  line-height: 1;
  box-sizing: border-box;
}

.bc-pl-empty[data-mode='expand'],
.bc-pl-empty[data-mode='collapse'] {
  font-size: 0;
}

.bc-pl-empty[data-mode='loading'] {
  color: var(--panel-text-dim);
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .bc-pl-empty[data-mode='loading'] {
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

.bc-pl-toggle-icon {
  width: 14px;
  height: 14px;
  display: block;
  opacity: 0.86;
}

@keyframes bc-pl-bpm-loading-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes bc-pl-loading-wave {
  to { background-position: -120% 0; }
}

@keyframes bc-pl-title-runtime-wave {
  0% {
    clip-path: inset(0 100% 0 0);
  }
  6% {
    clip-path: inset(0 78% 0 0);
  }
  94% {
    clip-path: inset(0 0 0 78%);
  }
  100% {
    clip-path: inset(0 0 0 100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bc-pl-empty[data-mode='loading'],
  .bc-pl-title-runtime-highlight {
    animation: none;
  }

  .bc-pl-title-runtime-highlight {
    display: none;
  }
}

@media (forced-colors: active) {
  .bc-pl-empty[data-mode='loading'],
  .bc-pl-title-runtime-pending {
    background: none;
    color: CanvasText;
  }

  .bc-pl-title-runtime-highlight {
    display: none;
  }
}

/* ─── Settings ──────────────────────────────────────────────────────── */
.bc-settings {
  display: none;
  min-width: 156px;
  padding: 6px;
}

.bc-settings-title {
  padding: 2px 6px 6px 6px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--panel-divider);
  font-size: 11px;
  font-weight: 550;
  letter-spacing: 0;
  text-transform: none;
  line-height: 1.2;
  color: var(--panel-text);
}

.bc-settings-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bc-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 24px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--panel-text);
  transition: background 0.12s ease;
}

.bc-settings-label {
  flex: 1 1 auto;
  color: var(--panel-text);
  font-weight: 550;
  line-height: 1.2;
}

.bc-settings-toggle-btn {
  width: 22px;
  height: 12px;
  padding: 1px;
  border-radius: 999px;
  border: 0;
  background: #ccc;
  flex: 0 0 auto;
  cursor: pointer;
  position: relative;
  user-select: none;
  -webkit-user-select: none;
  transition: background 0.35s ease;
}

.bc-settings-toggle-btn::before,
.bc-settings-toggle-btn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transition:
    transform 0.35s cubic-bezier(0, 0.95, 0.38, 0.98),
    background 0.15s ease;
}

.bc-settings-toggle-btn::before {
  background: rgba(128, 128, 128, 0.075);
  transform: translate3d(0, -50%, 0) scale(0);
}

.bc-settings-toggle-btn::after {
  background: grey;
  transform: translate3d(0, -50%, 0);
}

.bc-settings-toggle-btn:active::before {
  transform: translate3d(0, -50%, 0) scale(2.6);
}

.bc-settings-toggle-btn.is-on {
  background: #d0efa8;
}

.bc-settings-toggle-btn.is-on::before {
  background: rgba(131, 177, 84, 0.075);
  transform: translate3d(10px, -50%, 0) scale(1);
}

.bc-settings-toggle-btn.is-on::after {
  background: #83b154;
  transform: translate3d(10px, -50%, 0);
}

.bc-settings-toggle-btn.is-on:active::before {
  transform: translate3d(10px, -50%, 0) scale(2.6);
}

/* DJ / Lite mode selector: "DJ mode · toggle · Lite mode", centered, with the active side
   bolded. The toggle is a neutral darker grey in BOTH states — state is conveyed by the bold
   label and the thumb position, not by colour. These rules follow the base toggle block, so on
   the dual-class element they win over the default grey/green by source order. */
.bc-settings-row-djlite {
  justify-content: center;
  gap: 9px;
}

.bc-settings-mode-label {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--panel-text-dim);
  transition: color 0.12s ease, font-weight 0.12s ease;
}

.bc-settings-mode-label.is-active {
  color: var(--panel-text);
  font-weight: 700;
}

.bc-settings-toggle-djlite,
.bc-settings-toggle-djlite.is-on {
  background: #8b919b;
}

.bc-settings-toggle-djlite::before,
.bc-settings-toggle-djlite.is-on::before {
  background: rgba(255, 255, 255, 0.12);
}

.bc-settings-toggle-djlite::after,
.bc-settings-toggle-djlite.is-on::after {
  background: #ffffff;
}

.bc-settings-toggle-djlite.is-on::before {
  transform: translate3d(10px, -50%, 0) scale(1);
}

.bc-settings-toggle-djlite.is-on::after {
  transform: translate3d(10px, -50%, 0);
}

.bc-settings-toggle-djlite.is-on:active::before {
  transform: translate3d(10px, -50%, 0) scale(2.6);
}

.bc-settings-row:hover {
  background: color-mix(in srgb, var(--panel-surface-active) 52%, transparent);
}

/* Preload tracks: a stacked block (label + (i) on top, full-width Off/Normal/High segments
   below) instead of the usual label-left/control-right row, so three segments don't force the
   Settings panel wider. position:relative anchors the info popover below it. */
.bc-settings-preload {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 4px 6px 5px;
  border-radius: 6px;
  /* Match .bc-settings-row so the label inherits 11px like every other menu row. */
  font-size: 11px;
  transition: background 0.12s ease;
}

.bc-settings-preload:hover {
  background: color-mix(in srgb, var(--panel-surface-active) 52%, transparent);
}

.bc-settings-preload-head {
  display: flex;
  align-items: center;
  gap: 5px;
}

/* Round (i) affordance next to the label; opens the short level explainer popover. */
.bc-settings-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--panel-text) 40%, transparent);
  border-radius: 50%;
  background: transparent;
  color: var(--panel-text-dim);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 11px;
  font-style: italic;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.bc-settings-info:hover {
  color: var(--panel-text);
  border-color: color-mix(in srgb, var(--panel-text) 64%, transparent);
}

.bc-settings-info:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}

/* Segmented control: a dim track holding 2 (Firefox) or 3 (Chrome) equal-width buttons; the
   active segment reads as a raised "thumb" via a brighter fill and undimmed bold text. */
.bc-settings-seg {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel-surface-active) 34%, transparent);
}

.bc-settings-seg-btn {
  flex: 1 1 0;
  min-height: 18px;
  padding: 2px 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--panel-text-dim);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.bc-settings-seg-btn:hover {
  color: var(--panel-text);
}

.bc-settings-seg-btn.is-active {
  background: color-mix(in srgb, var(--panel-surface-active) 96%, white 10%);
  color: var(--panel-text);
  font-weight: 700;
}

.bc-settings-seg-btn:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}

/* Short level explainer, anchored below the block; overlays whatever sits beneath it. */
.bc-settings-info-pop {
  display: none;
  position: absolute;
  z-index: 6;
  left: 4px;
  right: 4px;
  top: calc(100% + 2px);
  padding: 8px 9px;
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  background: var(--panel-surface-bg);
  box-shadow: var(--panel-surface-sheen);
  backdrop-filter: blur(20.8px) saturate(130%);
  -webkit-backdrop-filter: blur(20.8px) saturate(130%);
  font-size: 11px;
  line-height: 1.45;
  color: var(--panel-text);
}

.bc-settings-info-pop.is-open {
  display: block;
}

.bc-settings-info-pop p {
  margin: 0 0 5px;
}

.bc-settings-info-pop p:last-child {
  margin-bottom: 0;
}

.bc-settings-info-pop strong {
  font-weight: 700;
}

/* A row whose control is deactivated by another setting (e.g. Analyze Key while
   Lite mode is on): dimmed, no hover affordance, toggle not interactive. */
.bc-settings-row-disabled {
  opacity: 0.42;
}

.bc-settings-row-disabled:hover {
  background: transparent;
}

.bc-settings-row-disabled .bc-settings-toggle-btn {
  cursor: not-allowed;
}

.bc-settings-toggle-btn:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}

.bc-settings-action-btn,
.bc-shortcuts-key-btn,
.bc-shortcuts-reset-btn {
  border: 0;
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel-surface-active) 72%, transparent);
  color: var(--panel-text);
  font: inherit;
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  cursor: pointer;
}

.bc-settings-action-btn {
  min-width: 34px;
  height: 20px;
  padding: 0 8px;
  /* Match the 11px used everywhere else in the Settings menu (the shared rule above sets 10px
     for the shortcuts-panel buttons, which are a separate surface). */
  font-size: 11px;
}

.bc-shortcuts-panel {
  display: none;
  min-width: 220px;
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  background: var(--panel-surface-bg);
  box-shadow: var(--panel-surface-sheen);
  backdrop-filter: blur(20.8px) saturate(130%);
  -webkit-backdrop-filter: blur(20.8px) saturate(130%);
  overflow: hidden;
  position: relative;
}

.bc-shortcuts-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.18),
      rgba(255, 255, 255, 0.02) 42%,
      rgba(40, 44, 52, 0.035)
    );
  pointer-events: none;
}

.bc-shortcuts-panel > * {
  position: relative;
  z-index: 1;
}

.bc-shortcuts-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--panel-divider) 72%, transparent);
  border-radius: 8px;
  background: var(--panel-glass-soft-bg);
  box-shadow: var(--panel-surface-sheen);
  backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
  -webkit-backdrop-filter: blur(var(--panel-surface-blur)) saturate(125%);
}

.bc-shortcuts-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 26px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--panel-text);
}

.bc-shortcuts-row:hover {
  background: color-mix(in srgb, var(--panel-surface-active) 52%, transparent);
}

.bc-shortcuts-key-btn {
  min-width: 72px;
  height: 22px;
  padding: 0 8px;
  text-align: center;
  white-space: nowrap;
}

.bc-shortcuts-key-btn.is-capturing {
  background: #d0efa8;
  color: rgba(30, 42, 24, 0.95);
}

.bc-shortcuts-notice {
  display: none;
  max-width: 190px;
  padding: 6px;
  font-size: 10px;
  line-height: 1.25;
  color: var(--panel-text);
}

.bc-shortcuts-notice.is-visible {
  display: block;
}

.bc-shortcuts-reset-btn {
  width: calc(100% - 12px);
  height: 22px;
  margin: 4px 6px 0;
}

.bc-settings-action-btn:focus-visible,
.bc-shortcuts-key-btn:focus-visible,
.bc-shortcuts-reset-btn:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--panel-text) 62%, transparent);
  outline-offset: 1px;
}

`;
