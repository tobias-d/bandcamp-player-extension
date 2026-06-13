/**
 * Tunable parameters for the panel liquid-glass surface. Persisted to
 * localStorage (same convention as the __BC_DEBUG__ logging flag) so a tuned
 * look survives reloads; the Alt+G tuner panel edits these live.
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
}

interface GlassSettingKey {
  key: keyof GlassSettings;
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
 * The tuned liquid-glass standard. The Alt+G panel now exposes a single
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
  specular: 0.85
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
 * The Alt+G panel exposes one combined Tint+Blur control. Its position is a
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
