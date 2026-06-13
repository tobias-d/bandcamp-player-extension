import { CAMELOT_MAP } from '@/background/key/constants';
import type { KeyScoreResult } from '@/background/key/types';

function deleteIfPossible(value: unknown): void {
  if (value && typeof value === 'object' && typeof (value as { delete?: unknown }).delete === 'function') {
    try {
      ((value as { delete: () => void }).delete)();
    } catch (error) {
      console.warn('[KEY] vector delete failed', error);
    }
  }
}

function toFinite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKeyToken(raw: string): string {
  const cleaned = String(raw || '')
    .trim()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b');
  if (!cleaned) {
    return '';
  }
  const letter = cleaned[0]?.toUpperCase();
  const accidental = cleaned[1] === '#' || cleaned[1] === 'b' ? cleaned[1] : '';
  return `${letter}${accidental}`;
}

function normalizeScaleToken(raw: string): string {
  const cleaned = String(raw || '').trim().toLowerCase();
  if (cleaned === 'maj') {
    return 'major';
  }
  if (cleaned === 'min') {
    return 'minor';
  }
  return cleaned;
}

function resolveCamelot(key: string, scale: string): string | null {
  const direct = CAMELOT_MAP[`${key} ${scale}`];
  if (direct) {
    return direct;
  }

  // Fallback for unexpected casing from WASM bindings.
  const target = `${key} ${scale}`.toLowerCase();
  for (const [name, camelot] of Object.entries(CAMELOT_MAP)) {
    if (name.toLowerCase() === target) {
      return camelot;
    }
  }
  return null;
}

function runKey(
  vec: unknown,
  profileType: string,
  pcpSize: number,
  essentia: any
): unknown {
  return essentia.Key(
    vec,
    4,
    pcpSize,
    profileType,
    0.6,
    false,
    true,
    true
  );
}

export function scoreWindowKey(
  meanHPCP: Float32Array,
  harmonicEnergy: number,
  profileType: string,
  pcpSize: number,
  essentia: any,
  essentiaModule: any
): KeyScoreResult | null {
  const vec = essentiaModule.arrayToVector(meanHPCP);
  let result: unknown = null;

  try {
    try {
      result = runKey(vec, profileType, pcpSize, essentia);
    } catch (error) {
      if (profileType !== 'bgate') {
        console.warn('[KEY] profile failed, retrying bgate', profileType, error);
        result = runKey(vec, 'bgate', pcpSize, essentia);
      } else {
        throw error;
      }
    }
    const record = (result || {}) as Record<string, unknown>;
    const key = normalizeKeyToken(String(record.key || ''));
    const scale = normalizeScaleToken(String(record.scale || ''));
    if (!key || !scale) {
      return null;
    }

    const combined = `${key} ${scale}`;
    const camelot = resolveCamelot(key, scale);
    if (!camelot) {
      console.warn('[KEY] Camelot lookup miss for', combined);
    }

    const keyStrength = toFinite(record.strength, 0);
    const firstToSecondRelativeStrength = toFinite(record.firstToSecondRelativeStrength, 0);
    const combinedWeight = keyStrength * harmonicEnergy;

    return {
      key,
      scale,
      camelot,
      keyStrength,
      firstToSecondRelativeStrength,
      combinedWeight
    };
  } catch (error) {
    console.warn('[KEY] scoreWindowKey failed', error);
    return null;
  } finally {
    deleteIfPossible(result);
    deleteIfPossible(vec);
  }
}
