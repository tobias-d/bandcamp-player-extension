export const DEBUG_PANEL_CSS = `
.bc-debug-panel-root {
  --panel-surface-bg: rgba(247, 240, 240, 0.58);
  --panel-surface-active: var(--panel-surface-bg);
  --panel-border: rgba(88, 88, 88, 0.44);
  --panel-divider: rgba(78, 86, 97, 0.24);
  --panel-text: #1f2228;
  --panel-text-bright: #1f2228;
  --panel-text-dim: #1f2228;
  --panel-surface-sheen: 0 1px 0 rgba(255, 255, 255, 0.22) inset;
  --panel-scroll-thumb: rgba(93, 102, 114, 0.42);
  --panel-scroll-thumb-hover: rgba(93, 102, 114, 0.62);
  position: fixed;
  left: 24px;
  bottom: 24px;
  width: min(600px, calc(100vw - 24px));
  max-height: calc(100vh - 24px);
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  color: var(--panel-text);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 11px;
  background: var(--panel-surface-bg);
  border: 1px solid var(--panel-border);
  border-radius: 14px;
  box-shadow: none;
  backdrop-filter: blur(20.8px) saturate(130%);
  -webkit-backdrop-filter: blur(20.8px) saturate(130%);
  overflow: hidden;
  user-select: text;
  box-sizing: border-box;
  line-height: 1.25;
}

.bc-debug-panel-root *,
.bc-debug-panel-root *::before,
.bc-debug-panel-root *::after {
  box-sizing: border-box;
}

.bc-debug-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 8px;
  border-bottom: 1px solid var(--panel-divider);
  background: transparent;
  box-shadow: var(--panel-surface-sheen);
  cursor: move;
  touch-action: none;
  user-select: none;
}

.bc-debug-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bc-debug-drag {
  font-size: 12px;
  font-weight: 700;
  color: var(--panel-text-bright);
  white-space: nowrap;
}

.bc-debug-status {
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.06em;
  color: var(--panel-text);
  background: rgba(14, 16, 20, 0.05);
  border: 1px solid var(--panel-divider);
  border-radius: 999px;
  padding: 3px 7px;
}

.bc-debug-status-paused {
  color: var(--panel-text);
  background: color-mix(in srgb, var(--panel-surface-active) 64%, transparent);
  border-color: var(--panel-divider);
}

.bc-debug-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  cursor: default;
}

.bc-debug-btn {
  border: 1px solid var(--panel-divider);
  background: transparent;
  color: var(--panel-text);
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 10px;
  font-weight: 550;
  line-height: 1.2;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, color 0.12s;
}

.bc-debug-btn:hover {
  border-color: var(--panel-border);
  background: color-mix(in srgb, var(--panel-surface-active) 64%, transparent);
}

.bc-debug-btn-close {
  width: 26px;
  padding: 4px 0;
}

.bc-debug-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 5px;
  padding: 6px;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}

.bc-debug-status-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-surface-bg) 84%, white 16%);
}

.bc-debug-status-title {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--panel-text-dim);
  white-space: nowrap;
}

.bc-debug-status-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.bc-debug-status-box {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--panel-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--panel-text);
  padding: 3px 5px;
  line-height: 1.1;
}

.bc-debug-status-box-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9px;
  font-weight: 650;
}

.bc-debug-status-box-state {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--panel-text-dim);
}

.bc-debug-status-box-detail {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--panel-text);
}

.bc-debug-status-box-loading {
  border-color: rgba(120, 104, 62, 0.35);
  background: rgba(145, 116, 52, 0.08);
}

.bc-debug-status-box-preparing {
  border-color: rgba(88, 111, 148, 0.36);
  background: rgba(88, 111, 148, 0.08);
}

.bc-debug-status-box-limited {
  border-color: rgba(126, 106, 58, 0.38);
  background: rgba(126, 106, 58, 0.08);
}

.bc-debug-status-box-idle {
  border-color: rgba(96, 104, 118, 0.34);
  background: rgba(96, 104, 118, 0.07);
}

.bc-debug-status-box-disabled {
  border-color: rgba(88, 88, 88, 0.32);
  background: rgba(88, 88, 88, 0.06);
}

.bc-debug-status-box-warning {
  border-color: rgba(150, 112, 48, 0.42);
  background: rgba(150, 112, 48, 0.09);
}

.bc-debug-status-box-error {
  border-color: rgba(150, 62, 62, 0.42);
  background: rgba(150, 62, 62, 0.09);
}

.bc-debug-status-box-complete {
  border-color: rgba(58, 120, 84, 0.38);
  background: rgba(58, 120, 84, 0.09);
}

.bc-debug-card {
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-surface-bg) 84%, white 16%);
  overflow: hidden;
}

.bc-debug-toolbar-card {
  padding: 5px 6px;
}

.bc-debug-controls-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 5px;
}

.bc-debug-copy-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.bc-debug-copy-btn {
  max-width: 128px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bc-debug-copy-btn-anonymized {
  max-width: none;
  border-color: rgba(42, 113, 73, 0.44);
  background: rgba(42, 113, 73, 0.1);
  color: #175b38;
  font-weight: 650;
}

.bc-debug-copy-btn-anonymized:hover {
  border-color: rgba(42, 113, 73, 0.64);
  background: rgba(42, 113, 73, 0.16);
}

.bc-debug-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.bc-debug-field-label {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--panel-text-dim);
}

.bc-debug-input {
  border: 1px solid var(--panel-divider);
  border-radius: 6px;
  background: transparent;
  color: var(--panel-text);
  padding: 5px 6px;
  font-size: 11px;
  min-width: 0;
}

.bc-debug-input::placeholder {
  color: var(--panel-text-dim);
}

.bc-debug-input:focus {
  outline: none;
  border-color: var(--panel-border);
  box-shadow: 0 0 0 1px var(--panel-divider);
}

.bc-debug-area-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.bc-debug-area {
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-surface-bg) 84%, white 16%);
  overflow: hidden;
}

.bc-debug-area-summary {
  display: grid;
  grid-template-columns: minmax(124px, 0.44fr) minmax(0, 1fr);
  gap: 6px;
  align-items: center;
  padding: 5px 6px;
  cursor: pointer;
  list-style: none;
}

.bc-debug-area-summary::-webkit-details-marker {
  display: none;
}

.bc-debug-area-title-group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bc-debug-area-title {
  font-size: 11px;
  font-weight: 650;
  color: var(--panel-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bc-debug-area-meta {
  flex: 0 0 auto;
  font-size: 9px;
  color: var(--panel-text-dim);
}

.bc-debug-area-preview {
  min-width: 0;
  color: var(--panel-text-dim);
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bc-debug-area[open] .bc-debug-area-summary {
  border-bottom: 1px solid var(--panel-divider);
  background: color-mix(in srgb, var(--panel-surface-active) 64%, transparent);
}

.bc-debug-area-body {
  display: flex;
  flex-direction: column;
  max-height: 280px;
  overflow: auto;
  background: transparent;
}

.bc-debug-section-row,
.bc-debug-section-text,
.bc-debug-section-subheading {
  padding: 4px 6px;
  border-top: 1px solid var(--panel-divider);
  flex: 0 0 auto;
}

.bc-debug-section-row:first-child,
.bc-debug-section-text:first-child,
.bc-debug-section-subheading:first-child {
  border-top: 0;
}

.bc-debug-section-row {
  display: grid;
  grid-template-columns: minmax(120px, 170px) minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  min-height: 28px;
}

.bc-debug-section-row-label {
  color: var(--panel-text-dim);
  font-weight: 600;
  font-size: 10px;
  line-height: 1.35;
  min-width: 0;
}

.bc-debug-section-row-value,
.bc-debug-section-text {
  color: var(--panel-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: 'SF Mono', ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 10px;
  line-height: 1.35;
  min-width: 0;
}

.bc-debug-section-subheading {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--panel-text);
  background: color-mix(in srgb, var(--panel-surface-active) 64%, transparent);
  min-height: 24px;
  display: flex;
  align-items: center;
}

.bc-debug-empty {
  padding: 8px;
  border: 1px dashed var(--panel-divider);
  border-radius: 8px;
  color: var(--panel-text-dim);
  background: color-mix(in srgb, var(--panel-surface-bg) 84%, white 16%);
  font-size: 10px;
}

.bc-debug-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.bc-debug-stats {
  margin-right: auto;
  font-size: 10px;
  color: var(--panel-text-dim);
}

.bc-debug-copy-notice {
  position: absolute;
  right: 10px;
  bottom: 10px;
  max-width: calc(100% - 20px);
  padding: 6px 8px;
  border: 1px solid var(--panel-divider);
  border-radius: 8px;
  background: color-mix(in srgb, var(--panel-surface-bg) 88%, white 12%);
  color: var(--panel-text);
  font-size: 11px;
  font-weight: 550;
  line-height: 1.2;
  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity 160ms ease, transform 160ms ease;
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.14);
}

.bc-debug-copy-notice-visible {
  opacity: 1;
  transform: translateY(0);
}

@media (max-width: 760px) {
  .bc-debug-panel-root {
    left: 12px;
    top: 12px;
    right: 12px;
    width: auto;
    max-height: calc(100vh - 24px);
  }

  .bc-debug-top,
  .bc-debug-actions {
    flex-wrap: wrap;
  }

  .bc-debug-actions {
    justify-content: flex-end;
  }

  .bc-debug-area-summary {
    grid-template-columns: 1fr;
  }

  .bc-debug-area-preview {
    grid-column: 1 / -1;
    white-space: normal;
  }

  .bc-debug-section-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
`;
