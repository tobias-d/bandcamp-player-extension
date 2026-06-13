function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function fractionFromPointer(clientX: number, element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) {
    return 0;
  }

  const normalized = (clientX - rect.left) / rect.width;
  return clamp01(normalized);
}
