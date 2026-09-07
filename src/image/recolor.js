// Recolours an app icon toward a target colour so a set of icons reads as
// one family. Two treatments, chosen automatically from the icon itself:
//
//   hue   — colourful icons (Claude's orange tile). Every pixel keeps its
//           lightness and relative chroma and has its hue rotated so the
//           dominant colour lands on the target hue. Done in OKLCH, so the
//           drop shadow, texture and near-white marks survive untouched.
//   ramp  — grayscale icons (ChatGPT's knot, Grok Bot's ghost), where a hue
//           rotation is a no-op. Lightness is remapped through a ramp whose
//           stops are placed so the icon's own field lands exactly on the
//           target colour and the mark lands on white. A dark field gets a
//           third stop below it so outlines darker than the field stay
//           darker instead of collapsing into it.
//
// Ramps interpolate in OKLab so midpoints don't go muddy.
import { LIN, linearToOklab, oklabToOklch, oklchToOklab, oklchToLinearClamped, linearToSrgb, hexToOklch } from './color.js';

const OPAQUE = 128;

export function analyze(img) {
  const { data, width, height } = img;
  let n = 0, sumC = 0;
  let wx = 0, wy = 0, wSum = 0, wL = 0, wC = 0;
  const lums = [];
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < OPAQUE) continue;
    const p = i >> 2, x = p % width, y = (p / width) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const [L, a, b] = linearToOklab(LIN[data[i]], LIN[data[i + 1]], LIN[data[i + 2]]);
    const C = Math.hypot(a, b);
    n++; sumC += C; lums.push(L);
    if (C > 0.04) {
      // chroma-weighted circular mean of hue
      wx += a; wy += b; wSum += C; wL += L * C; wC += C * C;
    }
  }
  if (n === 0) throw new Error('Icon has no opaque pixels');
  const meanChroma = sumC / n;
  // The field is whatever colour the icon's outer edge mostly is: the modal
  // lightness of opaque pixels in a thin band inside the bounding box. A mean
  // or median fails when the mark is bigger than the field or touches the
  // edge (Grok Bot's ghost fills the tile and is cut off at the bottom).
  const band = Math.max(2, Math.round(0.06 * Math.min(x1 - x0 + 1, y1 - y0 + 1)));
  const BINS = 20;
  const hist = new Array(BINS).fill(0);
  const sums = new Array(BINS).fill(0);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x - x0 >= band && x1 - x >= band && y - y0 >= band && y1 - y >= band) { x = x1 - band; continue; }
      const i = (y * width + x) * 4;
      if (data[i + 3] < OPAQUE) continue;
      const L = linearToOklab(LIN[data[i]], LIN[data[i + 1]], LIN[data[i + 2]])[0];
      const b = Math.min(BINS - 1, Math.floor(L * BINS));
      hist[b]++; sums[b] += L;
    }
  }
  let mode = 0;
  for (let b = 1; b < BINS; b++) if (hist[b] > hist[mode]) mode = b;
  let cnt = 0, sum = 0;
  for (let b = Math.max(0, mode - 1); b <= Math.min(BINS - 1, mode + 1); b++) { cnt += hist[b]; sum += sums[b]; }
  const fieldL = cnt ? sum / cnt : lums.reduce((s, v) => s + v, 0) / n;
  let dominant = null;
  if (wSum > 0) {
    let h = (Math.atan2(wy, wx) * 180) / Math.PI;
    if (h < 0) h += 360;
    dominant = { h, L: wL / wSum, C: wC / wSum };
  }
  let darker = 0;
  for (const L of lums) if (L < fieldL - 0.08) darker++;
  return { meanChroma, fieldL, dominant, darkerFraction: darker / n, opaquePixels: n };
}

export function chooseTreatment(stats) {
  if (stats.meanChroma > 0.05 && stats.dominant) return 'hue';
  return stats.fieldL > 0.5 ? 'ramp-light' : 'ramp-dark';
}

function toOklab(hex) {
  const [L, C, h] = hexToOklch(hex);
  return oklchToOklab(L, C, h);
}

function lerpLab(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function labToBytes(lab) {
  const [Lc, C, h] = oklabToOklch(lab[0], lab[1], lab[2]);
  const rgb = oklchToLinearClamped(Lc, C, h);
  return rgb.map((v) => Math.round(linearToSrgb(v) * 255));
}

/**
 * @param {{width:number,height:number,data:Uint8Array}} img straight-alpha RGBA
 * @param {string} targetHex e.g. "#1b91e3"
 * @param {{treatment?: 'auto'|'hue'|'ramp-light'|'ramp-dark', stats?: object}} [opts]
 */
export function recolor(img, targetHex, opts = {}) {
  const stats = opts.stats || analyze(img);
  let treatment = !opts.treatment || opts.treatment === 'auto' ? chooseTreatment(stats) : opts.treatment;
  // Rotating a hue needs one to rotate. A greyscale icon — the knot, the
  // ghost, the ones the README names — has no dominant hue at all, and asking
  // for `hue` used to dereference null and produce a stack trace, or in the
  // interface nothing at all: the preview simply stopped updating. Fall back
  // to what auto would have picked; every caller reports the treatment it
  // actually got, so the answer is visible rather than silent.
  if (treatment === 'hue' && !stats.dominant) treatment = chooseTreatment(stats);
  const out = new Uint8Array(img.data.length);
  const { data } = img;
  const [tL, tC, tH] = hexToOklch(targetHex);
  const cache = new Map();

  if (treatment === 'hue') {
    const d = stats.dominant;
    const delta = tH - d.h;
    const cScale = Math.min(2, Math.max(0.5, tC / Math.max(d.C, 1e-4)));
    const lShift = tL - d.L;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      out[i + 3] = a;
      if (a === 0) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let px = cache.get(key);
      if (!px) {
        const [L, la, lb] = linearToOklab(LIN[data[i]], LIN[data[i + 1]], LIN[data[i + 2]]);
        const [, C, h] = oklabToOklch(L, la, lb);
        // Field pixels (chroma near the dominant) take the full lightness
        // shift; near-neutral marks, shadows and highlights take almost none,
        // so cream stays cream and the shadow stays a shadow.
        const w = Math.min(1, C / Math.max(d.C, 1e-4));
        const rgb = oklchToLinearClamped(L + lShift * w, C * cScale, (h + delta + 360) % 360);
        px = rgb.map((v) => Math.round(linearToSrgb(v) * 255));
        cache.set(key, px);
      }
      out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2];
    }
    return { img: { width: img.width, height: img.height, data: out }, treatment, stats };
  }

  const target = toOklab(targetHex);
  const white = [1, 0, 0];
  const field = Math.min(0.98, Math.max(0.02, stats.fieldL));
  let stops;
  if (treatment === 'ramp-light') {
    // Dark mark on a light field: black -> white, field -> target.
    stops = [[0, white], [field, target], [1, target]];
  } else {
    // Light mark on a dark field: field -> target, white -> white, and a
    // darker version of the target below the field for outlines.
    const [L, C, h] = hexToOklch(targetHex);
    const darker = oklchToOklab(Math.max(0.05, L - 0.25), C * 0.8, h);
    stops = stats.darkerFraction > 0.01 ? [[0, darker], [field, target], [1, white]] : [[0, target], [field, target], [1, white]];
  }
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i + 3] = a;
    if (a === 0) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let px = cache.get(key);
    if (!px) {
      const [L] = linearToOklab(LIN[data[i]], LIN[data[i + 1]], LIN[data[i + 2]]);
      let lab = stops[stops.length - 1][1];
      if (L <= stops[0][0]) lab = stops[0][1];
      else {
        for (let s = 0; s < stops.length - 1; s++) {
          const [l0, c0] = stops[s], [l1, c1] = stops[s + 1];
          if (L >= l0 && L <= l1) { lab = l1 === l0 ? c1 : lerpLab(c0, c1, (L - l0) / (l1 - l0)); break; }
        }
      }
      px = labToBytes(lab);
      cache.set(key, px);
    }
    out[i] = px[0]; out[i + 1] = px[1]; out[i + 2] = px[2];
  }
  return { img: { width: img.width, height: img.height, data: out }, treatment, stats };
}
