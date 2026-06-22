export const GLASS_CSS = `
/* ─── Liquid-glass panel surface ─────────────────────────────────────
   The glass parameters are CSS custom properties on .bc-panel-root, set
   live by src/ui/glass/ (the Appearance panel, Alt+G). The backdrop refraction itself is
   Chrome-only and applied as an inline backdrop-filter by glass-effect.ts.
──────────────────────────────────────────────────────────────────── */

/* Grey camouflage dapple — a soft, very-blurred grey mottle that blends into
   the glass surface. Each blob is a fixed-pixel grey circle tiled on its own
   fixed-pixel grid (background-size + repeat). The blob radii and grid periods
   are absolute px, NOT percentages, so the pattern keeps its exact form when the
   panel grows (playlist expand, tap/tempo pull-out) — a taller/wider panel just
   reveals more of the same field instead of stretching it. The eight grids use
   deliberately mismatched (near-coprime) periods and offsets so their overlap
   reads as an irregular camo, not a regular dot grid, and never visibly repeats
   across the panel. Each blob fades to fully transparent before its tile edge,
   so blobs stay separate patches. The Appearance panel (Alt+G) drives these live variables:

     --glass-camo       layer opacity  (master amount; 0 = off / pure glass)
     --glass-camo-blur  blur radius px (the "very blurred" softness)
     --glass-camo-tone  brightness ×   (light-grey <-> dark-grey shade)

   The layer is oversized (inset is negative, beyond the max blur) and clipped by
   the panel's overflow:hidden, so the blur never leaves a faded transparent ring
   at the panel border. It sits below the content (z-index 0) and is engine-
   agnostic — identical on Firefox and Chrome. */
.bc-glass-camo {
  position: absolute;
  inset: -64px;
  pointer-events: none;
  z-index: 0;
  opacity: var(--glass-camo, 0.6);
  filter: blur(var(--glass-camo-blur, 22px)) brightness(var(--glass-camo-tone, 1));
  background-image:
    radial-gradient(circle 38px at 50% 50%, rgba(70, 70, 74, 0.30) 0%, rgba(70, 70, 74, 0) 100%),
    radial-gradient(circle 30px at 50% 50%, rgba(150, 150, 152, 0.26) 0%, rgba(150, 150, 152, 0) 100%),
    radial-gradient(circle 44px at 50% 50%, rgba(50, 50, 54, 0.30) 0%, rgba(50, 50, 54, 0) 100%),
    radial-gradient(circle 34px at 50% 50%, rgba(120, 120, 124, 0.24) 0%, rgba(120, 120, 124, 0) 100%),
    radial-gradient(circle 40px at 50% 50%, rgba(90, 90, 94, 0.28) 0%, rgba(90, 90, 94, 0) 100%),
    radial-gradient(circle 26px at 50% 50%, rgba(70, 70, 74, 0.26) 0%, rgba(70, 70, 74, 0) 100%),
    radial-gradient(circle 32px at 50% 50%, rgba(150, 150, 152, 0.24) 0%, rgba(150, 150, 152, 0) 100%),
    radial-gradient(circle 46px at 50% 50%, rgba(50, 50, 54, 0.28) 0%, rgba(50, 50, 54, 0) 100%);
  background-size:
    137px 163px,
    191px 167px,
    223px 211px,
    151px 197px,
    251px 233px,
    113px 139px,
    207px 241px,
    277px 199px;
  background-position:
    0 0,
    53px 91px,
    119px 37px,
    17px 143px,
    181px 67px,
    41px 109px,
    97px 173px,
    149px 23px;
  background-repeat: repeat;
}

/* Prism light-beams — a few long, thin, defined diagonal streaks in a purple/yellow
   palette "shining through" the glass. Each beam is its own non-repeating
   linear-gradient with px stops (a narrow core + short falloff), placed at an
   irregular offset and slightly different angle so the set reads as scattered light
   rather than a regular, symmetrical pattern. Beams are anchored in px (not
   percentages), so they keep their width as the panel grows. A light blur softens the
   edges without smearing them; the whole layer is oversized (negative inset, beyond
   the blur) and clipped by the panel's overflow:hidden so the blur leaves no faded
   ring at the border. Sits below the content (z-index 0), engine-agnostic, and is
   gated entirely by --glass-prism (0 = off / pure glass). */
.bc-glass-prism {
  position: absolute;
  inset: -64px;
  pointer-events: none;
  z-index: 0;
  opacity: var(--glass-prism, 0);
  filter: blur(12px) saturate(1.25);
  background-image:
    linear-gradient(116deg, transparent 70px, rgba(170, 120, 255, 0.28) 77px, rgba(170, 120, 255, 0.28) 82px, transparent 90px),
    linear-gradient(120deg, transparent 182px, rgba(255, 214, 120, 0.25) 189px, rgba(255, 214, 120, 0.25) 193px, transparent 201px),
    linear-gradient(113deg, transparent 312px, rgba(150, 110, 245, 0.22) 319px, rgba(150, 110, 245, 0.22) 324px, transparent 332px);
  background-repeat: no-repeat;
}

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

/* ─── Appearance panel (Alt+G) ───────────────────────────────────────────
   Styled to match the main UI panel: same light-glass surface, border, corner
   radius, text colour and live 1.15 scale. appearance-panel.ts sets top, left
   and --appearance-scale every frame while open (anchoring by the panel's own
   scaled width) so the panel's right edge stays flush against the main panel's
   left edge, growing downward from transform-origin: top left. The edge that
   meets the main panel is squared and has no border so the two panels read as
   one attached surface. Lives on document.body, so the values the main panel
   reads from its scoped CSS vars are spelled out literally here (kept in sync
   with panel-shell.ts). */
.bc-appearance-panel {
  display: none;
  position: fixed;
  z-index: 2147483007;
  width: 270px;
  padding: 14px 16px;
  box-sizing: border-box;
  border: 1px solid rgba(88, 88, 88, 0.44);
  border-right: 0;
  border-radius: 14px 0 0 14px;
  background: rgba(247, 240, 240, 0.72);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  box-shadow: -10px 10px 30px rgba(0, 0, 0, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.45);
  color: #1f2228;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 12px;
  user-select: none;
  transform: scale(var(--appearance-scale, 1.15));
  transform-origin: top left;
}

.bc-appearance-panel.is-open {
  display: block;
}

.bc-appearance-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.bc-appearance-panel-title {
  flex: 1;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.1px;
  color: #1f2228;
}

.bc-appearance-panel-reset,
.bc-appearance-panel-close {
  border: 1px solid rgba(78, 86, 97, 0.28);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  padding: 3px 8px;
  cursor: pointer;
}

.bc-appearance-panel-reset:hover,
.bc-appearance-panel-close:hover {
  background: rgba(14, 16, 20, 0.08);
}

.bc-appearance-panel-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

/* The slider row keeps label, slider and value on one line: the label and value
   stay their natural width, the slider takes the space between them. */
.bc-appearance-panel-slider-row {
  align-items: center;
  gap: 10px;
}

/* Switch rows host a .bc-settings-toggle-btn (no text baseline), so centre it. */
.bc-appearance-panel-switch-row {
  align-items: center;
  margin-top: 4px;
}

.bc-appearance-panel-label {
  flex: 0 0 auto;
  color: rgba(31, 34, 40, 0.72);
  font-size: 12px;
  letter-spacing: 0.2px;
}

.bc-appearance-panel-value {
  flex: 0 0 auto;
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  font-weight: 600;
  color: #1f2228;
}

/* The background-style value is a name, not a number: let it size to the text and
   sit a touch smaller so it shares the row with the stepper arrows. */
.bc-appearance-panel-bg-value {
  min-width: 0;
  font-size: 12px;
}

/* Background row: label on the left, the name + ‹ › arrows grouped on the right. */
.bc-appearance-panel-bg-row {
  align-items: center;
}

.bc-appearance-panel-stepper {
  display: flex;
  align-items: center;
  gap: 6px;
}

.bc-appearance-panel-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid rgba(78, 86, 97, 0.28);
  border-radius: 6px;
  background: transparent;
  color: #1f2228;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.bc-appearance-panel-arrow:hover {
  background: rgba(14, 16, 20, 0.08);
}

.bc-appearance-panel-arrow:disabled {
  opacity: 0.3;
  cursor: default;
}

/* Compact inline control: takes the space between the label and value on the
   slider row. Custom track + thumb (not accent-color) so the thumb stays
   grabbable at this smaller size. */
.bc-appearance-panel-slider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1 1 auto;
  min-width: 0;
  height: 16px;
  margin: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.bc-appearance-panel-slider::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(31, 34, 40, 0.16);
}
.bc-appearance-panel-slider::-moz-range-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(31, 34, 40, 0.16);
}

.bc-appearance-panel-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -4px; /* centre the 14px thumb on the 6px track */
  border-radius: 50%;
  background: #2c2f36;
  border: 2px solid #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.bc-appearance-panel-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #2c2f36;
  border: 2px solid #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.bc-appearance-panel-slider:focus-visible {
  outline: none;
}
.bc-appearance-panel-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 3px rgba(31, 34, 40, 0.35);
}
.bc-appearance-panel-slider:focus-visible::-moz-range-thumb {
  box-shadow: 0 0 0 3px rgba(31, 34, 40, 0.35);
}

/* Camouflage switch — re-skinned to share the slider's monochrome palette
   (instead of the green settings-menu toggle), so the two controls read as one
   set: the same light-grey track and the same #2c2f36 graphite handle as the
   slider thumb. Geometry/transitions are inherited from .bc-settings-toggle-btn. */
.bc-appearance-panel-switch {
  background: rgba(31, 34, 40, 0.16);
}
.bc-appearance-panel-switch::after {
  background: #2c2f36;
}
.bc-appearance-panel-switch::before,
.bc-appearance-panel-switch.is-on::before {
  background: rgba(31, 34, 40, 0.12);
}
.bc-appearance-panel-switch.is-on {
  background: #2c2f36;
}
.bc-appearance-panel-switch.is-on::after {
  background: #ffffff;
}
`;
