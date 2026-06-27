export const TEMPO_ADJUST_CSS = `
.bc-transport-inner.bc-tempo-adjust-open {
  grid-template-rows: auto auto auto;
}

.bc-transport-inner.bc-tempo-adjust-open .bc-transport-cell-bottom,
.bc-transport-inner.bc-tap-open .bc-transport-cell-bottom {
  display: flex;
  align-items: center;
}

.bc-transport-inner.bc-tempo-adjust-open .bc-transport-bottom-content,
.bc-transport-inner.bc-tap-open .bc-transport-bottom-content {
  height: var(--transport-meta-row-height);
  min-height: var(--transport-meta-row-height);
}

.bc-transport-pill {
  grid-template-columns: max-content minmax(0, 1fr) max-content;
}

.bc-transport-cell-tempo {
  display: none;
  width: calc(100% - (var(--transport-side-inset) * 2));
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
  padding: 0;
}

.bc-transport-cell-tempo.is-open {
  display: block;
}

.bc-transport-cell-tap {
  display: none;
  width: calc(100% - (var(--transport-side-inset) * 2));
  margin-left: auto;
  margin-right: auto;
  box-sizing: border-box;
  padding: 0;
}

.bc-transport-cell-tap.is-open {
  display: block;
}

.bc-btn-symbol-tempo {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.bc-btn-tempo-adjust-active {
  background: var(--panel-surface-active);
  border-color: var(--panel-divider);
  color: var(--transport-ink);
}

.bc-tempo-adjust-row {
  display: none;
  position: relative;
  z-index: 0;
  isolation: isolate;
  border: 0;
  border-radius: var(--panel-radius-lg);
  background: rgba(14, 16, 20, 0.045);
  padding: 8px 9px 9px;
  box-sizing: border-box;
  gap: 7px;
}

.bc-tempo-adjust-row.is-open {
  display: grid;
}

.bc-tempo-adjust-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.4px;
  color: var(--panel-text-dim);
  text-transform: uppercase;
  line-height: 1;
  margin-bottom: 4px;
}

.bc-tempo-adjust-top-row {
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  margin-bottom: 4px;
  gap: 8px;
}

.bc-tempo-adjust-offset-header {
  display: flex;
  align-items: center;
  gap: 2px;
  line-height: 1;
  min-height: 22px;
  padding: 2px 6px;
  box-sizing: border-box;
}

.bc-tempo-adjust-offset-label {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--panel-text-dim);
  letter-spacing: 0.4px;
  margin-right: 2px;
}


.bc-tempo-adjust-offset-value {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--panel-text-bright);
  letter-spacing: 0.2px;
  line-height: 1;
}

.bc-tempo-adjust-slider {
  --tempo-slider-track: rgba(45, 49, 56, 0.24);
  --tempo-slider-fill: rgba(45, 49, 56, 0.8);
  --tempo-slider-thumb: #2d3138;
  position: relative;
  z-index: 1;
  width: 100%;
  height: 14px;
  -moz-appearance: none;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  margin: 0;
  cursor: pointer;
  transform: translateZ(0);
}

.bc-tempo-adjust-slider:focus {
  outline: none;
}

.bc-tempo-adjust-slider::-webkit-slider-runnable-track {
  width: 100%;
  height: 2px;
  border: 0;
  border-radius: var(--panel-radius-pill);
  background: var(--tempo-slider-track);
  box-shadow: none;
}

.bc-tempo-adjust-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border: 0;
  border-radius: 50%;
  background: var(--tempo-slider-thumb);
  margin-top: -4px;
  box-shadow: none;
}

.bc-tempo-adjust-slider::-moz-range-track {
  width: 100%;
  height: 2px;
  border: 0;
  border-radius: var(--panel-radius-pill);
  background: var(--tempo-slider-track);
  box-shadow: none;
}

.bc-tempo-adjust-slider::-moz-range-progress {
  height: 2px;
  border: 0;
  border-radius: var(--panel-radius-pill);
  background: var(--tempo-slider-track);
}

.bc-tempo-adjust-slider::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border: 0;
  border-radius: 50%;
  background: var(--tempo-slider-thumb);
  box-shadow: none;
}

.bc-tempo-adjust-slider-ticks {
  display: flex;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--panel-text-dim);
  letter-spacing: 0.2px;
  line-height: 1;
  margin-left: 5px;
  margin-right: 5px;
}

.bc-tempo-adjust-slider-markers {
  position: relative;
  height: 7px;
  margin-top: 1px;
  margin-bottom: 1px;
  margin-left: 5px;
  margin-right: 5px;
}

.bc-tempo-adjust-slider-marker {
  position: absolute;
  top: 0;
  width: 1px;
  height: 7px;
  background: rgba(45, 49, 56, 0.34);
  transform: translateX(-0.5px);
}

.bc-tempo-adjust-slider-marker.is-zero {
  width: 2px;
  height: 10px;
  top: -1px;
  background: rgba(45, 49, 56, 0.72);
  transform: translateX(-1px);
}

.bc-tempo-adjust-slider-marker.is-first {
  transform: none;
}

.bc-tempo-adjust-slider-marker.is-last {
  transform: translateX(-1px);
}



.bc-tempo-adjust-key-lock {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  min-height: 22px;
  padding: 2px 6px;
  box-sizing: border-box;
  border-radius: var(--panel-radius-sm);
  font-size: 10px;
  color: var(--panel-text);
}

.bc-tempo-adjust-key-lock .bc-settings-label {
  flex: 1 1 auto;
  color: var(--panel-text);
  font-weight: 550;
  line-height: 1.2;
}

.bc-tempo-adjust-key-lock .bc-settings-toggle-btn {
  flex: 0 0 auto;
  background: #bbb;
}

.bc-tempo-adjust-key-lock .bc-settings-toggle-btn::after {
  background: #888;
}

.bc-tempo-adjust-key-lock .bc-settings-toggle-btn.is-on {
  background: #d0efa8;
}

.bc-tempo-adjust-key-lock .bc-settings-toggle-btn.is-on::after {
  background: #83b154;
}

.bc-tempo-adjust-key-lock .bc-settings-toggle-btn:disabled {
  cursor: default;
  opacity: 0.65;
}

.bc-tempo-adjust-row.is-disabled {
  opacity: 0.72;
}
`;
