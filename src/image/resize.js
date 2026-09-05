// Area-averaging resize on premultiplied alpha, so soft edges don't pick up
// dark fringes. Good for icon downscales; upscales use the same kernel.
export function resize(img, w, h) {
  if (w === img.width && h === img.height) return { width: w, height: h, data: new Uint8Array(img.data) };
  const src = img.data;
  const sw = img.width, sh = img.height;
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    pre[i] = src[i] * a; pre[i + 1] = src[i + 1] * a; pre[i + 2] = src[i + 2] * a; pre[i + 3] = a;
  }
  const tmp = new Float32Array(w * sh * 4);
  scaleAxis(pre, sw, sh, tmp, w, true);
  const outF = new Float32Array(w * h * 4);
  scaleAxis(tmp, w, sh, outF, h, false);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = outF[i + 3];
    if (a <= 0) continue;
    out[i] = clamp(outF[i] / a); out[i + 1] = clamp(outF[i + 1] / a); out[i + 2] = clamp(outF[i + 2] / a);
    out[i + 3] = clamp(a * 255);
  }
  return { width: w, height: h, data: out };
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

// Resample one axis with a box filter (fractional coverage at the ends).
function scaleAxis(src, sw, sh, dst, dlen, horizontal) {
  const slen = horizontal ? sw : sh;
  const other = horizontal ? sh : sw;
  const dw = horizontal ? dlen : sw;
  const scale = slen / dlen;
  for (let d = 0; d < dlen; d++) {
    const start = d * scale, end = start + scale;
    const s0 = Math.floor(start), s1 = Math.min(slen - 1, Math.ceil(end) - 1);
    for (let o = 0; o < other; o++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let s = s0; s <= s1; s++) {
        const wgt = Math.min(end, s + 1) - Math.max(start, s);
        if (wgt <= 0) continue;
        const i = horizontal ? (o * sw + s) * 4 : (s * sw + o) * 4;
        r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt; a += src[i + 3] * wgt; wsum += wgt;
      }
      const j = horizontal ? (o * dw + d) * 4 : (d * dw + o) * 4;
      dst[j] = r / wsum; dst[j + 1] = g / wsum; dst[j + 2] = b / wsum; dst[j + 3] = a / wsum;
    }
  }
}
