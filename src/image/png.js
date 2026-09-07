// Minimal PNG codec. Decodes any non-interlaced or Adam7 PNG (bit depths
// 1-16, all five colour types, tRNS) to straight-alpha 8-bit RGBA, and
// encodes RGBA back. No dependencies beyond node:zlib.
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function isPng(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIG);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Bit depths the spec allows for each colour type. Anything else is a
// malformed file, and reading it produces nonsense rather than an error.
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

// Every number below comes out of the file being read, and this decoder is
// pointed at whatever an app's resource section, an .icns, or a user's
// --icon happens to contain. A header claiming 65535x65535 asks for 17GB
// before a single pixel has been read, and a few hundred kilobytes of IDAT
// can inflate to gigabytes, so both are bounded here rather than trusted.
// The limits are far above any icon: 8192 a side is 32x the largest .icns.
const MAX_SIDE = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;

// How many bytes a valid IDAT stream must inflate to for this geometry: one
// filter byte plus the packed scanline, per row, over one pass or Adam7's
// seven. Anything more is a lie, and inflateSync is told to stop there.
const ADAM7_X0 = [0, 4, 0, 2, 0, 1, 0], ADAM7_Y0 = [0, 0, 4, 0, 2, 0, 1];
const ADAM7_DX = [8, 8, 4, 4, 2, 2, 1], ADAM7_DY = [8, 8, 8, 4, 4, 2, 2];

function rawBytes(width, height, bitsPerPixel, interlace) {
  const pass = (w, h) => (w <= 0 || h <= 0 ? 0 : h * (1 + Math.ceil((w * bitsPerPixel) / 8)));
  if (!interlace) return pass(width, height);
  let total = 0;
  for (let p = 0; p < 7; p++) {
    total += pass(Math.ceil((width - ADAM7_X0[p]) / ADAM7_DX[p]), Math.ceil((height - ADAM7_Y0[p]) / ADAM7_DY[p]));
  }
  return total;
}

export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG');
  let pos = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('PNG header is truncated');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('PNG missing IHDR');
  const { width, height, depth, colorType, interlace } = ihdr;
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (!DEPTHS[colorType].includes(depth)) throw new Error(`PNG colour type ${colorType} can't have ${depth}-bit samples`);
  if (interlace > 1) throw new Error(`Unknown PNG interlace method ${interlace}`);
  if (colorType === 3 && !plte) throw new Error('PNG is palette-coloured but has no palette');
  if (width < 1 || height < 1) throw new Error('PNG has no pixels');
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    throw new Error(`PNG claims to be ${width}x${height}; the limit is ${MAX_SIDE} a side and ${MAX_PIXELS / 1024 / 1024}M pixels`);
  }
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = rawBytes(width, height, bitsPerPixel, interlace);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (e) {
    // ERR_BUFFER_TOO_LARGE means the stream carried more than the geometry
    // in the header could possibly account for.
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PNG image data is larger than its header allows');
    throw e;
  }
  if (raw.length < expected) throw new Error('PNG image data is shorter than its header promises');
  const out = new Uint8Array(width * height * 4);
  const maxv = (1 << depth) - 1;

  // Read pixel `sx` of an unfiltered scanline into out at (x, y).
  function sample(line, sx, x, y) {
    let r, g, b, a = 255;
    if (depth === 8) {
      const i = sx * channels;
      if (colorType === 0) { r = g = b = line[i]; if (trns && trns.length >= 2 && line[i] === trns[1]) a = 0; }
      else if (colorType === 2) { r = line[i]; g = line[i + 1]; b = line[i + 2]; if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0; }
      else if (colorType === 3) { const p = line[i] * 3; r = plte[p]; g = plte[p + 1]; b = plte[p + 2]; if (trns && line[i] < trns.length) a = trns[line[i]]; }
      else if (colorType === 4) { r = g = b = line[i]; a = line[i + 1]; }
      else { r = line[i]; g = line[i + 1]; b = line[i + 2]; a = line[i + 3]; }
    } else if (depth === 16) {
      const i = sx * channels * 2;
      if (colorType === 0) r = g = b = line[i];
      else if (colorType === 2) { r = line[i]; g = line[i + 2]; b = line[i + 4]; }
      else if (colorType === 4) { r = g = b = line[i]; a = line[i + 2]; }
      else { r = line[i]; g = line[i + 2]; b = line[i + 4]; a = line[i + 6]; }
    } else {
      const bit = sx * depth;
      const byte = line[bit >> 3];
      const shift = 8 - depth - (bit & 7);
      const v = (byte >> shift) & maxv;
      if (colorType === 3) { const p = v * 3; r = plte[p]; g = plte[p + 1]; b = plte[p + 2]; if (trns && v < trns.length) a = trns[v]; }
      else { r = g = b = Math.round((v * 255) / maxv); if (trns && trns.length >= 2 && v === trns[1]) a = 0; }
    }
    const o = (y * width + x) * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }

  // Unfilter one pass of `ph` scanlines, `pw` pixels wide, starting at raw[offset].
  function unfilterPass(offset, pw, ph, place) {
    const bytesPerLine = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(bytesPerLine);
    for (let y = 0; y < ph; y++) {
      const ft = raw[offset];
      const line = new Uint8Array(raw.subarray(offset + 1, offset + 1 + bytesPerLine));
      offset += 1 + bytesPerLine;
      for (let i = 0; i < bytesPerLine; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (ft === 1) v += a;
        else if (ft === 2) v += b;
        else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = v & 0xff;
      }
      for (let x = 0; x < pw; x++) place(line, x, y);
      prev = line;
    }
    return offset;
  }

  if (!interlace) {
    unfilterPass(0, width, height, (line, x, y) => sample(line, x, x, y));
  } else {
    let offset = 0;
    for (let p = 0; p < 7; p++) {
      const pw = Math.ceil((width - ADAM7_X0[p]) / ADAM7_DX[p]);
      const ph = Math.ceil((height - ADAM7_Y0[p]) / ADAM7_DY[p]);
      if (pw <= 0 || ph <= 0) continue;
      offset = unfilterPass(offset, pw, ph, (line, x, y) =>
        sample(line, x, ADAM7_X0[p] + x * ADAM7_DX[p], ADAM7_Y0[p] + y * ADAM7_DY[p]));
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  // Filter type 1 (Sub) compresses flat icon fields well and is cheap.
  for (let y = 0; y < height; y++) {
    const ro = y * (stride + 1);
    raw[ro] = 1;
    const so = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? data[so + i - 4] : 0;
      raw[ro + 1 + i] = (data[so + i] - left) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
