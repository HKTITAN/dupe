// Named profile colours. All sit at the same OKLCH lightness and chroma as
// the original work blue (#1b91e3 ≈ L 0.63, C 0.16, h 245), so a Dock or
// taskbar full of dupes reads as one family and differs only by hue.
import { oklchToHex, hexToOklch } from './image/color.js';

const L = 0.63, C = 0.16;

export const NAMED = {
  blue: oklchToHex(L, C, 245),
  teal: oklchToHex(L, C, 195),
  green: oklchToHex(L, C, 150),
  amber: oklchToHex(L, C, 75),
  red: oklchToHex(L, C, 25),
  pink: oklchToHex(L, C, 345),
  purple: oklchToHex(L, C, 300),
  gray: oklchToHex(L, 0.02, 245),
};

// Stephen Wu's original work blue, kept exact rather than regenerated.
NAMED.blue = '#1b91e3';

export const ORDER = ['blue', 'green', 'purple', 'amber', 'red', 'teal', 'pink', 'gray'];

/** Accepts "#1b91e3", "1b91e3" or a palette name. */
export function resolveColor(input) {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  if (NAMED[key]) return NAMED[key];
  hexToOklch(key); // throws on bad input
  return key.startsWith('#') ? key : `#${key}`;
}

/** Next unused palette colour for an app that already has `used` colours. */
export function nextColor(used) {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  for (const name of ORDER) if (!taken.has(NAMED[name])) return NAMED[name];
  return NAMED.blue;
}
