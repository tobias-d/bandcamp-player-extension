// Clamp `value` into [min, max]. A non-finite value (NaN/Infinity) resolves to
// `min` — the safe floor used by key-confidence scoring; tempo-adjust only ever
// feeds finite values, so the guard is inert there.
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
