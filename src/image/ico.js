// Windows .ico reader/writer. Reads PNG and 32/24/8/4/1-bit DIB entries,
// writes 32-bit DIBs for small sizes and PNG for the 256px entry.
import { decodePng, encodePng, isPng } from './png.js';

// Decode a DIB (BITMAPINFOHEADER + XOR + AND) as stored in an ICO or RT_ICON.
export function decodeDib(buf) {
  const hdr = buf.readUInt32LE(0);
  const width = buf.readInt32LE(4);
  const height = buf.readInt32LE(8) / 2;
  const bits = buf.readUInt16LE(14);
  const compression = buf.readUInt32LE(16);
  if (compression !== 0) throw new Error(`Unsupported DIB compression ${compression}`);
  let colours = buf.readUInt32LE(32);
  let pos = hdr;
  let palette = null;
  if (bits <= 8) {
    if (colours === 0) colours = 1 << bits;
    palette = buf.subarray(pos, pos + colours * 4);
    pos += colours * 4;
  }
  const xorStride = ((width * bits + 31) >> 5) << 2;
  const andStride = ((width + 31) >> 5) << 2;
  const xor = buf.subarray(pos, pos + xorStride * height);
  const and = buf.subarray(pos + xorStride * height, pos + xorStride * height + andStride * height);
  const hasMask = and.length >= andStride * height;
  const out = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * xorStride;
    const arow = (height - 1 - y) * andStride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (bits === 32) { const i = row + x * 4; b = xor[i]; g = xor[i + 1]; r = xor[i + 2]; a = xor[i + 3]; if (a) anyAlpha = true; }
      else if (bits === 24) { const i = row + x * 3; b = xor[i]; g = xor[i + 1]; r = xor[i + 2]; }
      else {
        const bit = x * bits;
        const byte = xor[row + (bit >> 3)];
        const idx = bits === 8 ? byte : (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
        b = palette[idx * 4]; g = palette[idx * 4 + 1]; r = palette[idx * 4 + 2];
      }
      if (hasMask && (and[arow + (x >> 3)] >> (7 - (x & 7))) & 1) a = 0;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  // A 32-bit DIB whose alpha channel is entirely zero is a legacy opaque
  // icon; its transparency lives in the AND mask alone.
  if (bits === 32 && !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const arow = (height - 1 - y) * andStride;
      for (let x = 0; x < width; x++) {
        const masked = hasMask && (and[arow + (x >> 3)] >> (7 - (x & 7))) & 1;
        out[(y * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

export function decodeIconImage(buf) {
  return isPng(buf) ? decodePng(buf) : decodeDib(buf);
}

export function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('Not an ICO');
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12);
    const data = buf.subarray(offset, offset + size);
    let width = buf[e] || 256, height = buf[e + 1] || 256;
    if (isPng(data)) { width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
    else if (data.length >= 12) { width = data.readInt32LE(4); height = data.readInt32LE(8) / 2; }
    entries.push({ width, height, bits: buf.readUInt16LE(e + 6), data });
  }
  return entries;
}

export function largestFromIco(buf) {
  const entries = readIco(buf).sort((a, b) => b.width * b.height - a.width * a.height || b.bits - a.bits);
  for (const e of entries) {
    try { return decodeIconImage(e.data); } catch { /* try the next entry */ }
  }
  throw new Error('No decodable image in ICO');
}

function encodeDib({ width, height, data }) {
  const xorStride = width * 4;
  const andStride = ((width + 31) >> 5) << 2;
  const buf = Buffer.alloc(40 + xorStride * height + andStride * height);
  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8);
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(32, 14);
  buf.writeUInt32LE(xorStride * height, 20);
  for (let y = 0; y < height; y++) {
    const row = 40 + (height - 1 - y) * xorStride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, o = row + x * 4;
      buf[o] = data[i + 2]; buf[o + 1] = data[i + 1]; buf[o + 2] = data[i]; buf[o + 3] = data[i + 3];
    }
  }
  return buf;
}

export function writeIco(images) {
  const sorted = [...images].sort((a, b) => a.width - b.width);
  // PNG payloads are only guaranteed to load at 256 px; everything smaller is
  // a plain 32-bit DIB, which every shell component since XP renders.
  const blobs = sorted.map((im) => (im.width >= 256 ? encodePng(im) : encodeDib(im)));
  const header = Buffer.alloc(6 + 16 * sorted.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sorted.length, 4);
  let offset = header.length;
  sorted.forEach((im, i) => {
    const e = 6 + i * 16;
    header[e] = im.width >= 256 ? 0 : im.width;
    header[e + 1] = im.height >= 256 ? 0 : im.height;
    header[e + 2] = 0; header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(blobs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += blobs[i].length;
  });
  return Buffer.concat([header, ...blobs]);
}
