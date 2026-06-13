export const GLASS_CSS = `
/* ─── Liquid-glass panel surface ─────────────────────────────────────
   The glass parameters are CSS custom properties on .bc-panel-root, set
   live by src/ui/glass/ (Alt+G tuner). The backdrop refraction itself is
   Chrome-only and applied as an inline backdrop-filter by glass-effect.ts.
──────────────────────────────────────────────────────────────────── */

/* Specular rim light: glass reads as glass through a thin, uniform edge
   light — not a top-light/bottom-dark bevel. All strengths scale with
   --glass-specular so one slider drives the whole rim. */
.bc-glass-rim {
  position: absolute;
  inset: 0;
  border-radius: 14px;
  pointer-events: none;
  z-index: 60;
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, calc(var(--glass-specular, 0.55) * 0.9)),
    inset 0 0 0 1px rgba(255, 255, 255, calc(var(--glass-specular, 0.55) * 0.45)),
    inset 0 -14px 26px -20px rgba(255, 255, 255, calc(var(--glass-specular, 0.55) * 0.7));
}

/* ─── Alt+G tuner ────────────────────────────────────────────────────── */
.bc-glass-tuner {
  display: none;
  position: fixed;
  left: 24px;
  top: 24px;
  z-index: 2147483007;
  width: 270px;
  padding: 12px 14px;
  box-sizing: border-box;
  border-radius: 10px;
  background: rgba(20, 22, 28, 0.94);
  color: #e7eaf0;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  user-select: none;
}

.bc-glass-tuner.is-open {
  display: block;
}

.bc-glass-tuner-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.bc-glass-tuner-title {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.bc-glass-tuner-reset,
.bc-glass-tuner-close {
  border: 1px solid rgba(231, 234, 240, 0.3);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  padding: 3px 8px;
  cursor: pointer;
}

.bc-glass-tuner-reset:hover,
.bc-glass-tuner-close:hover {
  background: rgba(231, 234, 240, 0.12);
}

.bc-glass-tuner-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.bc-glass-tuner-label {
  color: rgba(231, 234, 240, 0.75);
  font-size: 12px;
  letter-spacing: 0.3px;
}

.bc-glass-tuner-value {
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 600;
}

/* One large, easy-to-grab control. Custom track + thumb (not accent-color) so
   the hit target and thumb are big enough to drag comfortably. */
.bc-glass-tuner-slider {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: 100%;
  height: 30px;
  margin: 2px 0 4px;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.bc-glass-tuner-slider::-webkit-slider-runnable-track {
  height: 10px;
  border-radius: 999px;
  background: rgba(231, 234, 240, 0.18);
}
.bc-glass-tuner-slider::-moz-range-track {
  height: 10px;
  border-radius: 999px;
  background: rgba(231, 234, 240, 0.18);
}

.bc-glass-tuner-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 24px;
  height: 24px;
  margin-top: -7px; /* centre the 24px thumb on the 10px track */
  border-radius: 50%;
  background: #9aa7ff;
  border: 2px solid #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
}
.bc-glass-tuner-slider::-moz-range-thumb {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #9aa7ff;
  border: 2px solid #ffffff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
}

.bc-glass-tuner-slider:focus-visible {
  outline: none;
}
.bc-glass-tuner-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(154, 167, 255, 0.5);
}
.bc-glass-tuner-slider:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px rgba(154, 167, 255, 0.5);
}
`;
