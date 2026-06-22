/**
 * Tunable parameters for the panel liquid-glass surface. Persisted to
 * localStorage (same convention as the __BC_DEBUG__ logging flag) so a tuned
 * look survives reloads; the Appearance panel (Alt+G) edits these live.
 */
export interface GlassSettings {
  /** Peak backdrop displacement at the panel rim, in px. Chrome-only (SVG filter). */
  refraction: number;
  /** Width of the refracting edge band, in px. Chrome-only (SVG filter). */
  bezel: number;
  /** Peak displacement of the centre lens at its rim, in px. Chrome-only (SVG filter). */
  lens: number;
  /** Backdrop frost blur, in px. */
  blur: number;
  /** Panel tint alpha (0..1) over the tint colour. */
  tint: number;
  /** Specular rim-light opacity (0..1). */
  specular: number;
  /** Grey camouflage layer opacity (0..1; master amount). Fixed constant. */
  camo: number;
  /** Grey camouflage blur radius, in px (the "very blurred" softness). Fixed constant. */
  camoBlur: number;
  /** Grey camouflage brightness multiplier (light-grey <-> dark-grey shade). Fixed constant. */
  camoTone: number;
  /** Selected background style index into BACKGROUND_STYLES. The Appearance slider sets this. */
  bgStyle: number;
}

/** Selectable panel background styles. Index 0 is always "no background"; the last is a
 *  reserved placeholder for a style still to be designed (it currently shows no background). */
export const BACKGROUND_STYLES = ['None', 'Camouflage', 'Prism', 'Style 4'] as const;

/** Index in BACKGROUND_STYLES whose selection shows the grey camouflage layer. */
export const BG_STYLE_CAMOUFLAGE = 1;

/** Index in BACKGROUND_STYLES whose selection shows the prism light-beam layer. */
export const BG_STYLE_PRISM = 2;

/** Only the numeric tuning settings are min/max-clamped; bgStyle is an index clamped separately. */
type NumericGlassKey = {
  [K in keyof GlassSettings]: GlassSettings[K] extends number ? K : never;
}[keyof GlassSettings];

interface GlassSettingKey {
  key: NumericGlassKey;
  min: number;
  max: number;
}

const LIMITS: GlassSettingKey[] = [
  { key: 'refraction', min: -60, max: 60 },
  { key: 'bezel', min: 4, max: 48 },
  { key: 'lens', min: -150, max: 150 },
  { key: 'blur', min: 0, max: 10 },
  { key: 'tint', min: 0, max: 1 },
  { key: 'specular', min: 0, max: 1 }
];

/**
 * The tuned liquid-glass standard. The Appearance panel exposes a single
 * combined Tint+Blur control, so tint and blur are kept coupled on the slider
 * line (blur = tint × 10): the default sits at position 0.65. Keep the blur and
 * tint values in sync with the stylesheet fallbacks in panel-shell.ts.
 */
export const GLASS_DEFAULTS: GlassSettings = {
  refraction: 46,
  bezel: 17,
  lens: -150,
  blur: 6.5,
  tint: 0.65,
  specular: 0.85,
  camo: 1,
  camoBlur: 11,
  camoTone: 0.88,
  bgStyle: BG_STYLE_CAMOUFLAGE
};

const STORAGE_KEY = '__BC_GLASS__';

export function clampGlassSettings(raw: Partial<GlassSettings>): GlassSettings {
  const result = { ...GLASS_DEFAULTS };
  for (const { key, min, max } of LIMITS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) {
      result[key] = Math.min(max, Math.max(min, value));
    }
  }
  // camo/camoBlur/camoTone are fixed constants (kept at GLASS_DEFAULTS, not in
  // LIMITS), so stale stored values can never override the standard look; only
  // the selected style index is read back from storage.
  const rawStyle = Number((raw as { bgStyle?: unknown }).bgStyle);
  if (Number.isFinite(rawStyle)) {
    result.bgStyle = Math.min(BACKGROUND_STYLES.length - 1, Math.max(0, Math.round(rawStyle)));
  } else if (typeof (raw as { camoEnabled?: unknown }).camoEnabled === 'boolean') {
    // Migrate the old on/off camouflage switch to the new style index.
    result.bgStyle = (raw as { camoEnabled?: boolean }).camoEnabled ? BG_STYLE_CAMOUFLAGE : 0;
  }
  return result;
}

export function loadGlassSettings(): GlassSettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return { ...GLASS_DEFAULTS };
    }
    return clampGlassSettings(JSON.parse(stored) as Partial<GlassSettings>);
  } catch {
    // localStorage unavailable (private mode) or corrupt JSON: defaults.
    return { ...GLASS_DEFAULTS };
  }
}

export function saveGlassSettings(settings: GlassSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is best-effort; the live values still apply this session.
  }
}

/**
 * The Appearance panel exposes one combined Tint+Blur control. Its position is a
 * 0..1 fraction where 0 = clear glass and 1 = full frost: tint uses that
 * fraction directly (its range is already 0..1) and blur scales to the same
 * fraction of its 0..10px range. Tint therefore *is* the position, which lets
 * a returning session recover the slider position from stored settings.
 */
export function positionFromSettings(settings: GlassSettings): number {
  return Math.min(1, Math.max(0, settings.tint));
}

/**
 * Returns settings with tint and blur re-coupled to the given slider position,
 * leaving the non-exposed parameters (refraction, bezel, lens, specular)
 * untouched. clampGlassSettings keeps both inside their limits.
 */
export function withGlassPosition(settings: GlassSettings, position: number): GlassSettings {
  const pos = Math.min(1, Math.max(0, position));
  return clampGlassSettings({ ...settings, tint: pos, blur: pos * 10 });
}
