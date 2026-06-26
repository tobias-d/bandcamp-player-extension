export const TRANSPORT_CSS = `
/* ─── Stacked analysis and transport area ───────────────────────────── */
.bc-controls-row {
  display: grid;
  grid-template-columns: 1fr;
  min-width: 0;
  margin-bottom: var(--panel-stack-gap);
  border-top: 0;
  border-bottom: 0;
}

.bc-transport-inner {
  --transport-meta-row-height: 26px;
  --transport-controls-row-height: 34px;
  display: grid;
  grid-template-rows: var(--transport-meta-row-height) var(--transport-controls-row-height);
  row-gap: var(--panel-stack-gap);
  min-height: calc(var(--transport-meta-row-height) + var(--panel-stack-gap) + var(--transport-controls-row-height));
  min-width: 0;
  padding: 0;
  border-right: 0;
}

.bc-transport-inner.bc-tap-open {
  grid-template-rows: auto auto auto;
}

.bc-transport-inner.bc-tempo-adjust-open.bc-tap-open {
  grid-template-rows: auto auto auto auto;
}

.bc-transport-cell {
  min-height: 0;
  min-width: 0;
}

.bc-transport-cell-top {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--transport-controls-row-height);
}

.bc-transport-cell-bottom {
  display: flex;
  align-items: center;
  border-top: 0;
}

.bc-transport-bottom-content {
  height: var(--transport-meta-row-height);
  width: calc(100% - (var(--transport-side-inset) * 2));
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
}

.bc-transport-meta-grid {
  display: grid;
  grid-template-columns: max-content max-content max-content;
  justify-content: center;
  column-gap: 24px;
  width: 100%;
  height: 100%;
  align-items: center;
  box-sizing: border-box;
  padding-left: 18px;
  padding-right: 18px;
}

.bc-transport-meta-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  line-height: 1;
  height: 100%;
}

.bc-transport-time-item {
  justify-content: flex-start;
  gap: 0;
}

.bc-transport-meta-item > * {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
}

.bc-transport-meta-item:first-child {
  border-right: 0;
}

.bc-transport-meta-label {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.45px;
  color: var(--panel-text-dim);
  line-height: 1;
}

.bc-bpm-label-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 14px;
  line-height: 1;
}

.bc-bpm-confidence-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #98a2b3;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.10) inset;
}

.bc-bpm-confidence-dot.level-low {
  background: #f04438;
}

.bc-bpm-confidence-dot.level-medium {
  background: #f79009;
}

.bc-bpm-confidence-dot.level-high {
  background: #12b76a;
}

.bc-bpm-confidence-dot.level-unknown {
  background: #98a2b3;
}

.bc-transport-meta-value {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 400;
  color: var(--panel-text-bright);
  line-height: 1;
  min-height: 14px;
}

.bc-key-main-value {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.bc-key-main-entry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 14px;
  width: auto;
  justify-content: flex-start;
}

.bc-key-main-entry.is-empty .bc-key-main-value-text {
  opacity: 0.7;
}

.bc-transport-meta-item.bc-key-disabled .bc-transport-meta-label,
.bc-transport-meta-item.bc-key-disabled .bc-transport-meta-value,
.bc-transport-meta-item.bc-key-disabled .bc-key-main-value-text {
  color: var(--panel-text-dim);
  opacity: 0.5;
}

.bc-transport-meta-item.bc-key-disabled .bc-bpm-confidence-dot {
  opacity: 0.35;
}

.bc-key-main-value-text {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-playtime);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  width: 3ch;
  justify-content: center;
}

.bc-bpm-main-value-text {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-playtime);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  width: 3ch;
  justify-content: center;
}

.bc-bpm-value-slot,
.bc-key-value-slot {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 3ch;
  min-width: 3ch;
  line-height: 1;
}

.bc-transport-meta-value.is-loading {
  display: inline-flex;
  align-items: center;
}

.bc-bpm-main-loading-icon {
  display: block;
  position: absolute;
  left: calc(50% - 5px);
  top: calc(50% - 5px);
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid rgba(6, 6, 6, 0.14);
  border-top-color: rgba(150, 150, 150, 0.78);
  width: 12px;
  height: 12px;
  animation: bc-bpm-loading-spin 1.2s linear infinite;
  transform-origin: center;
}

@keyframes bc-bpm-loading-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.bc-transport-pill {
  --transport-ink: #2d3138;
  --transport-ink-soft: rgba(45, 49, 56, 0.82);
  --transport-ink-faint: rgba(45, 49, 56, 0.24);
  --transport-volume-control-width: 134px;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: stretch;
  padding: 0;
  width: calc(100% - (var(--transport-side-inset) * 2));
  min-width: 0;
  height: 34px;
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
  border: 0;
  border-radius: 12px;
  background: rgba(14, 16, 20, 0.05);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
  overflow: hidden;
}

.bc-transport-pill > * {
  min-width: 0;
  box-sizing: border-box;
}

.bc-transport-time-value {
  min-width: 0;
  width: 15ch;
  height: 100%;
  padding: 0;
  display: grid;
  grid-template-columns: 6ch 1ch 6ch;
  column-gap: 2px;
  align-items: center;
  justify-content: start;
  text-align: left;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
  border-radius: 0 !important;
  font-family: var(--font-playtime);
  font-variant-numeric: tabular-nums;
}

.bc-transport-time-part {
  display: inline-flex;
  width: 6ch;
  justify-content: flex-end;
}

.bc-transport-total-time {
  justify-content: flex-start;
}

.bc-transport-time-separator {
  display: inline-flex;
  width: 1ch;
  justify-content: center;
}

.bc-btn {
  background: var(--panel-surface-bg);
  border: 1px solid var(--panel-divider);
  color: var(--transport-ink);
  border-radius: 999px;
  font-size: 15px; cursor: pointer; padding: 4px; line-height: 1;
  min-width: 26px;
  transition: color 0.12s, background 0.12s, border-color 0.12s; display: flex; align-items: center;
  justify-content: center;
}
.bc-btn:hover {
  background: var(--panel-surface-hover);
  border-color: var(--panel-divider);
}
.bc-btn:focus {
  outline: none;
}
.bc-btn:focus-visible {
  outline: 1px solid var(--panel-divider);
  outline-offset: -2px;
}

.bc-transport-pill .bc-btn {
  width: 34px;
  height: 100%;
  padding: 2px;
  border: 0;
  border-radius: 10px !important;
  background: transparent;
  background-clip: content-box;
  box-sizing: border-box;
}

.bc-transport-pill .bc-btn-play {
  width: 36px;
}

.bc-transport-left-controls,
.bc-volume-control,
.bc-transport-right-controls {
  display: grid;
  align-items: stretch;
  height: 100%;
  min-width: 0;
  box-sizing: border-box;
}

.bc-transport-left-controls {
  grid-template-columns: 34px 36px 34px;
  justify-self: start;
}

.bc-volume-control {
  grid-template-columns: 34px minmax(0, 1fr);
  width: min(var(--transport-volume-control-width), 100%);
  justify-self: center;
}

.bc-transport-right-controls {
  grid-template-columns: 34px 34px;
  justify-self: end;
}

.bc-btn-symbol {
  line-height: 1;
  display: block;
  pointer-events: none;
  color: currentColor;
}

.bc-btn-symbol-svg {
  display: block;
  width: 20px;
  height: 20px;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.bc-btn-symbol-svg-turntable {
  width: 20px;
  height: 20px;
}

.bc-btn-symbol-svg-tap {
  width: 20px;
  height: 20px;
}

.bc-btn-symbol-volume {
  width: 17px;
  height: 17px;
}

.bc-btn-symbol-nav,
.bc-btn-symbol-play {
  font-size: 14px;
}

.bc-icon {
  position: relative;
  display: block;
  width: 14px;
  height: 14px;
}

.bc-icon::before,
.bc-icon::after {
  content: "";
  position: absolute;
  display: block;
  box-sizing: border-box;
}

.bc-icon-play {
  width: 13px;
  height: 13px;
  margin-left: 1px;
}

.bc-icon-play::before {
  inset: 0;
  background: currentColor;
  clip-path: polygon(18% 10%, 86% 50%, 18% 90%);
}

.bc-icon-play.is-paused {
  width: 14px;
  height: 14px;
  margin-left: 0;
}

.bc-icon-play.is-paused::before,
.bc-icon-play.is-paused::after {
  inset: auto;
  top: 2px;
  width: 3px;
  height: 10px;
  border-radius: 999px;
  background: currentColor;
  clip-path: none;
}

.bc-icon-play.is-paused::before {
  left: 3px;
  box-shadow: 5px 0 0 currentColor;
}

.bc-icon-play.is-paused::after {
  display: none;
}

.bc-icon-nav {
  width: 14px;
  height: 14px;
}

.bc-icon-nav::before {
  top: 12%;
  width: 2px;
  height: 76%;
  border-radius: 999px;
  background: currentColor;
}

.bc-icon-nav::after {
  top: 7%;
  width: 9px;
  height: 86%;
  background: currentColor;
  clip-path: polygon(10% 8%, 94% 50%, 10% 92%);
}

.bc-icon-next::before {
  right: 1px;
}

.bc-icon-next::after {
  left: 1px;
}

.bc-icon-prev::before {
  left: 1px;
}

.bc-icon-prev::after {
  right: 1px;
  transform: scaleX(-1);
  transform-origin: center;
}

.bc-icon-volume {
  width: 17px;
  height: 17px;
  transform: translateX(-1px);
}

.bc-icon-volume-speaker,
.bc-icon-volume-wave,
.bc-icon-volume-slash {
  position: absolute;
  display: block;
  box-sizing: border-box;
}

.bc-icon-volume-speaker {
  left: 0;
  top: 50%;
  width: 9px;
  height: 15px;
  background: currentColor;
  clip-path: polygon(0 35%, 28% 35%, 68% 4%, 68% 96%, 28% 65%, 0 65%);
  transform: translateY(-50%);
}

.bc-icon-volume-wave {
  top: 50%;
  border-right: 2px solid currentColor;
  border-top: 2px solid transparent;
  border-bottom: 2px solid transparent;
  border-radius: 0 999px 999px 0;
  opacity: 0;
  transform: translateY(-50%);
}

.bc-icon-volume-wave-1 {
  left: 8px;
  width: 5px;
  height: 8px;
}

.bc-icon-volume-wave-2 {
  left: 10px;
  width: 6px;
  height: 12px;
}

.bc-icon-volume-slash {
  left: 8px;
  top: 50%;
  width: 2px;
  height: 15px;
  background: currentColor;
  border-radius: 999px;
  opacity: 0;
  transform: translateY(-50%) rotate(38deg);
}

.bc-vol-btn.is-muted .bc-icon-volume-speaker {
  opacity: 0.72;
}

.bc-vol-btn.is-muted .bc-icon-volume-wave {
  opacity: 0;
}

.bc-vol-btn.is-muted .bc-icon-volume-slash {
  opacity: 0.95;
}

.bc-vol-btn.is-mid .bc-icon-volume-wave-1 {
  opacity: 0.92;
}

.bc-vol-btn.is-full .bc-icon-volume-wave-1,
.bc-vol-btn.is-full .bc-icon-volume-wave-2 {
  opacity: 0.95;
}

.bc-btn-symbol-tap {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.bc-transport-pill .bc-btn:hover {
  background: rgba(14, 16, 20, 0.08);
  color: inherit;
}

.bc-transport-pill .bc-btn-play:hover {
  background: rgba(14, 16, 20, 0.08);
  color: var(--panel-text-bright);
}

.bc-btn-play {
  background: var(--panel-surface-bg);
  color: var(--transport-ink);
  font-size: 12px;
  justify-content: center;
  border-color: var(--panel-divider);
}
.bc-btn-play:hover, .bc-btn-play-active {
  background: var(--panel-surface-active);
  border-color: var(--panel-divider);
  color: var(--transport-ink);
}

.bc-transport-current-time.bc-transport-current-time-paused-progress {
  animation: bc-paused-progress-pulse 1.8s ease-in-out infinite;
}

@keyframes bc-paused-progress-pulse {
  0%, 100% {
    color: var(--transport-ink);
  }
  50% {
    color: rgba(45, 49, 56, 0.62);
  }
}

@media (prefers-reduced-motion: reduce) {
  .bc-transport-current-time.bc-transport-current-time-paused-progress {
    animation: none;
    color: rgba(45, 49, 56, 0.66);
  }
}

.bc-btn-tap {
  font-size: 12px;
}

.bc-btn-album-like {
  color: var(--transport-ink);
  font: inherit;
}

.bc-btn-album-like .bc-heart-symbol {
  font-family: inherit;
  font-size: calc(var(--heart-symbol-size) * 1.5);
  font-weight: 400;
  line-height: 1;
  opacity: 1;
}

.bc-btn-album-like-active {
  background: var(--panel-surface-active);
  border-color: var(--panel-divider);
  color: var(--transport-ink);
}

.bc-btn-album-like-active .bc-heart-symbol {
  opacity: 1;
}

.bc-btn-album-like-disabled {
  cursor: not-allowed;
}

.bc-btn-tap-active {
  background: var(--panel-surface-active);
  border-color: var(--panel-divider);
  color: var(--transport-ink);
}

.bc-vol-btn {
  font-size: 12px;
  font-weight: 700;
}

.bc-vol-mini-slider-wrap {
  --vol-level: 100%;
  --vol-thumb-left: 100%;
  --vol-track-left: 4px;
  --vol-track-right: 12px;
  --vol-track-height: 2px;
  --vol-thumb-size: 9px;
  width: 100%;
  height: 100%;
  position: relative;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  padding: 0 var(--vol-track-right) 0 var(--vol-track-left);
}

.bc-vol-mini-slider-wrap::before,
.bc-vol-mini-slider-wrap::after {
  content: "";
  position: absolute;
  pointer-events: none;
}

.bc-vol-mini-slider-wrap::before {
  left: var(--vol-track-left);
  right: var(--vol-track-right);
  top: calc(50% - (var(--vol-track-height) / 2));
  height: var(--vol-track-height);
  border-radius: 999px;
  background:
    linear-gradient(
      to right,
      var(--transport-ink-soft) 0,
      var(--transport-ink-soft) var(--vol-level),
      var(--transport-ink-faint) var(--vol-level),
      var(--transport-ink-faint) 100%
    );
}

.bc-vol-mini-slider-wrap::after {
  left: clamp(var(--vol-track-left), var(--vol-thumb-left), calc(100% - var(--vol-track-right)));
  top: 50%;
  width: var(--vol-thumb-size);
  height: var(--vol-thumb-size);
  transform: translate(-50%, -50%);
  border-radius: 999px;
  background: var(--transport-ink);
}

.bc-vol-mini-slider {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  -webkit-appearance: none;
  appearance: none;
  opacity: 0;
  background: transparent;
  outline: none;
  cursor: pointer;
  z-index: 1;
}

/* All labels + values + indicators: same monospace size */
.bc-bpm-label {
  font-family: var(--font-mono);
  font-size: 11px; color: var(--panel-text-dim);
  flex-shrink: 0; width: 28px;
  letter-spacing: 0.45px;
}

.bc-bpm-val {
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 650; color: var(--panel-text-bright);
  flex-shrink: 0;
}

/* ─── Tapper row ────────────────────────────────────────────────────── */
.bc-tap-stub {
  display: none;
  grid-template-columns: 1fr 1px 1fr;
  align-items: stretch;
  border-radius: 10px;
  background: rgba(14, 16, 20, 0.045);
  padding: 8px 9px 9px;
  box-sizing: border-box;
  color: var(--panel-text);
}
.bc-tap-stub.visible {
  display: grid;
  min-height: 114px;
}

.bc-tap-column {
  height: 100%;
  align-self: stretch;
}

.bc-tap-column-left {
  display: flex;
  align-items: center;
  justify-content: center;
}

.bc-tap-left-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  margin-left: 8px;
  letter-spacing: 0;
}

.bc-tap-left-placeholder .bc-bpm-label {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--panel-text-dim);
  flex-shrink: 0;
  width: 31px;
  letter-spacing: 0.45px;
  line-height: 1;
}

.bc-tap-left-placeholder .bc-bpm-val {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 650;
  color: var(--panel-text-bright);
  flex-shrink: 0;
  line-height: 1;
}

.bc-tap-column-right {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  padding: 0;
}

.bc-tap-target {
  width: 100%;
  height: 100%;
  border: 0;
  margin: 0;
  padding: 0 10px;
  background: transparent;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  isolation: isolate;
}

.bc-tap-target:focus {
  outline: none;
}

.bc-tap-target:focus-visible {
  outline: 1px solid var(--panel-divider);
  outline-offset: -1px;
}

.bc-tap-ripple {
  position: absolute;
  left: 0;
  top: 0;
  width: 34px;
  height: 34px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 0;
  will-change: transform, opacity;
  border-radius: 999px;
  opacity: 0.84;
  contain: paint;
  backface-visibility: hidden;
  animation: bc-tap-ripple-smooth 1680ms linear forwards;
}

.bc-tap-ripple::before,
.bc-tap-ripple::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

.bc-tap-ripple::before {
  background:
    radial-gradient(
      circle,
      transparent 0 39%,
      rgba(45, 49, 56, 0.3) 49%,
      rgba(45, 49, 56, 0.22) 54%,
      transparent 64%
    ),
    radial-gradient(
      circle,
      rgba(45, 49, 56, 0.07) 0 18%,
      transparent 38%
    );
  opacity: 0.92;
  animation: bc-tap-ripple-dark 1680ms linear forwards;
}

.bc-tap-ripple::after {
  background:
    radial-gradient(
      circle,
      transparent 0 40%,
      rgba(109, 115, 125, 0.18) 50%,
      rgba(109, 115, 125, 0.12) 55%,
      transparent 66%
    ),
    radial-gradient(
      circle,
      rgba(109, 115, 125, 0.03) 0 18%,
      transparent 38%
    );
  opacity: 0;
  animation: bc-tap-ripple-light 1680ms linear forwards;
}

.bc-tap-hint {
  position: relative;
  z-index: 1;
  display: block;
  margin: 0;
  max-width: 170px;
  text-align: center;
  line-height: 1.35;
  font-size: 11px;
  color: var(--panel-text-dim) !important;
  opacity: 1;
  visibility: visible;
}

.bc-tap-hint-line {
  display: block;
  color: var(--panel-text-dim) !important;
  letter-spacing: 0.04em;
}

@keyframes bc-tap-ripple-smooth {
  0% {
    transform: translate3d(-50%, -50%, 0) scale(0.22);
    opacity: 0.84;
  }
  62% {
    transform: translate3d(-50%, -50%, 0) scale(3.18);
    opacity: 0.68;
  }
  100% {
    transform: translate3d(-50%, -50%, 0) scale(5.1);
    opacity: 0;
  }
}

@keyframes bc-tap-ripple-dark {
  0% {
    opacity: 0.96;
  }
  68% {
    opacity: 0.5;
  }
  100% {
    opacity: 0;
  }
}

@keyframes bc-tap-ripple-light {
  0% {
    opacity: 0;
  }
  46% {
    opacity: 0.12;
  }
  82% {
    opacity: 0.46;
  }
  100% {
    opacity: 0;
  }
}

.bc-tap-separator {
  position: relative;
  width: 1px;
  height: 100%;
  align-self: stretch;
}

.bc-tap-separator::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 1px;
  height: 60%;
  transform: translateY(-50%);
  background: var(--panel-divider);
  pointer-events: none;
}

/* ─── Lite mode ────────────────────────────────────────────────────
   DJ-oriented transport features are hidden: BPM/Key readouts drop out (only the
   centered playtime remains), the Tempo Adjust + Tap buttons disappear, and the
   volume control moves to the far right of the controls row. */
.bc-lite-mode .bc-transport-meta-item:not(.bc-transport-time-item) {
  display: none;
}

.bc-lite-mode .bc-transport-meta-grid {
  grid-template-columns: max-content;
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.bc-lite-mode .bc-transport-right-controls {
  display: none;
}

/* Right controls are gone, so the volume control becomes the rightmost element;
   pin it to the right edge of the pill (prev/play/next stay grouped at the left). */
.bc-lite-mode .bc-volume-control {
  justify-self: end;
}

/* Guard against a DJ sub-panel that was open when lite mode was switched on. */
.bc-lite-mode .bc-transport-cell-tempo,
.bc-lite-mode .bc-transport-cell-tap {
  display: none;
}

`;
