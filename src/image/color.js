// sRGB <-> linear <-> OKLab/OKLCH, plus gamut clamping. All values 0..1.
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(v) {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Lookup table: 8-bit sRGB -> linear.
export const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255);

export function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToOklch(L, a, b) {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, h];
}
export function oklchToOklab(L, C, h) {
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

function inGamut(rgb) {
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

// Reduce chroma until the colour fits sRGB; L and h are preserved.
export function oklchToLinearClamped(L, C, h) {
  if (L <= 0) return [0, 0, 0];
  if (L >= 1) return [1, 1, 1];
  let rgb = oklabToLinear(...oklchToOklab(L, C, h));
  if (inGamut(rgb)) return rgb;
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    rgb = oklabToLinear(...oklchToOklab(L, mid, h));
    if (inGamut(rgb)) lo = mid; else hi = mid;
  }
  return oklabToLinear(...oklchToOklab(L, lo, h));
}

export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Expected a 6-digit hex colour, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToOklch(hex) {
  const [r, g, b] = parseHex(hex);
  return oklabToOklch(...linearToOklab(LIN[r], LIN[g], LIN[b]));
}

export function oklchToHex(L, C, h) {
  const rgb = oklchToLinearClamped(L, C, h);
  return '#' + rgb.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('');
}
