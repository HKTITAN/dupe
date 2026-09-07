// Colour for the terminal, from the same palette the icons use.
//
// dupe's whole point is that you tell profiles apart by colour, so a list of
// them printed in grey is throwing away the answer. Every profile line
// carries its own colour as a swatch — the dock, in text.
//
// Nothing here is required for the tool to work: pipe the output anywhere, or
// set NO_COLOR, and it degrades to plain text with the same words in it.
import { parseHex } from './image/color.js';

// https://no-color.org, plus the usual signals. A pipe gets no escapes, so
// `dupe list | grep` and `dupe status > file` stay clean.
export const enabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true') return true;
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
})();

const wrap = (open, close) => (s) => (enabled ? `[${open}m${s}[${close}m` : String(s));

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const underline = wrap(4, 24);

/** A string in an arbitrary #rrggbb, using 24-bit colour where there is any. */
export function ink(hex, s) {
  if (!enabled) return String(s);
  try {
    const [r, g, b] = parseHex(hex);
    return `[38;2;${r};${g};${b}m${s}[39m`;
  } catch {
    return String(s);
  }
}

/** The mark that stands for a profile: a filled dot in the profile's colour.
 *  Hollow when the profile is behind the app it copies, so the shape carries
 *  the state for anyone who can't see the colour. */
export function swatch(hex, { filled = true } = {}) {
  return ink(hex, filled ? '●' : '○');
}

/** Pad to a visible width, ignoring the escape sequences inside. */
export function pad(s, width) {
  const visible = String(s).replace(/\[[0-9;]*m/g, '').length;
  return String(s) + ' '.repeat(Math.max(0, width - visible));
}
