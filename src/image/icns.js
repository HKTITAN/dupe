// Apple .icns reader/writer, PNG payloads only (what electron-builder and
// iconutil produce). Older RLE types are skipped on read.
import { decodePng, encodePng, isPng } from './png.js';

const TYPES = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];

export const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

export function readIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns') throw new Error('Not an ICNS');
  const total = buf.readUInt32BE(4);
  const entries = [];
  let pos = 8;
  while (pos + 8 <= Math.min(total, buf.length)) {
    const type = buf.toString('latin1', pos, pos + 4);
    const len = buf.readUInt32BE(pos + 4);
    if (len < 8) break;
    const data = buf.subarray(pos + 8, pos + len);
    if (isPng(data)) entries.push({ type, width: data.readUInt32BE(16), height: data.readUInt32BE(20), data });
    pos += len;
  }
  return entries;
}

export function largestFromIcns(buf) {
  const entries = readIcns(buf).sort((a, b) => b.width - a.width);
  if (!entries.length) return null;
  return decodePng(entries[0].data);
}

// images: array of RGBA images at the sizes in TYPES (missing sizes skipped).
export function writeIcns(images) {
  const bySize = new Map(images.map((im) => [im.width, im]));
  const parts = [];
  for (const [type, size] of TYPES) {
    const im = bySize.get(size);
    if (!im) continue;
    const png = encodePng(im);
    const hdr = Buffer.alloc(8);
    hdr.write(type, 0, 'latin1');
    hdr.writeUInt32BE(8 + png.length, 4);
    parts.push(hdr, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}
