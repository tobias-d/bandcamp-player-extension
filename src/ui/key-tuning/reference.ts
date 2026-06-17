export const KEY_NAME_TO_CAMELOT = new Map<string, string>([
  ['am', '8A'], ['a min', '8A'], ['a minor', '8A'], ['cm', '5A'], ['c minor', '5A'],
  ['em', '9A'], ['e minor', '9A'], ['bm', '10A'], ['b minor', '10A'], ['f#m', '11A'],
  ['f# minor', '11A'], ['g#m', '1A'], ['g# minor', '1A'], ['bbm', '3A'], ['bb minor', '3A'],
  ['dm', '7A'], ['d minor', '7A'], ['gm', '6A'], ['g minor', '6A'], ['c#m', '12A'],
  ['c# minor', '12A'], ['fm', '4A'], ['f minor', '4A'], ['c', '8B'], ['c maj', '8B'],
  ['c major', '8B'], ['g', '9B'], ['g major', '9B'], ['d', '10B'], ['d major', '10B'],
  ['a', '11B'], ['a major', '11B'], ['e', '12B'], ['e major', '12B'], ['b', '1B'],
  ['b major', '1B'], ['f#', '2B'], ['f# major', '2B'], ['db', '3B'], ['db major', '3B'],
  ['ab', '4B'], ['ab major', '4B'], ['eb', '5B'], ['eb major', '5B'], ['bb', '6B'],
  ['bb major', '6B'], ['f', '7B'], ['f major', '7B']
]);

export function parseReferenceCamelot(raw: string): string | null {
  const cleaned = String(raw || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  const value = cleaned.toUpperCase();
  if (!value) return null;

  const exactCamelot = value.match(/^(1[0-2]|[1-9])\s*([AB])$/);
  if (exactCamelot) {
    return `${exactCamelot[1]}${exactCamelot[2]}`;
  }

  const embeddedCamelot = value.match(/(?:^|[^0-9])((?:[1-9]|1[0-2]))\s*([AB])(?:$|[^A-Z])/);
  if (embeddedCamelot) {
    return `${embeddedCamelot[1]}${embeddedCamelot[2]}`;
  }

  const normalized = cleaned.toLowerCase().replace(/\s+/g, ' ');
  return KEY_NAME_TO_CAMELOT.get(normalized) || null;
}
