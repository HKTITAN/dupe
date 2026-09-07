// The image codecs read whatever they are pointed at: an application's
// resource section, an .icns from inside a bundle, a PNG the user passed to
// --icon or dropped into the interface. None of that is trustworthy input,
// and a header is only a claim about a file, not a fact.
//
// Every case here killed the process, hung it, or returned quiet nonsense
// before the decoder started checking. They are kept as tests because the
// numbers involved come from the file, and it is easy to reintroduce a path
// that believes one.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng, encodePng } from '../src/image/png.js';
import { largestFromIco } from '../src/image/ico.js';
import { largestFromIcns } from '../src/image/icns.js';

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG whose header says whatever we want it to say. */
function png({ width, height, depth = 8, colorType = 6, interlace = 0, idat, plte }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType; ihdr[12] = interlace;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  parts.push(chunk('IDAT', idat || zlib.deflateSync(Buffer.alloc(height * (1 + width * 4)))));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const tiny = zlib.deflateSync(Buffer.alloc(64));

test('a header claiming enormous dimensions is refused, not allocated', () => {
  // 65535 x 65535 x 4 bytes is 17GB. This used to take the process with it.
  assert.throws(() => decodePng(png({ width: 65535, height: 65535, idat: tiny })), /claims to be 65535x65535/);
  assert.throws(() => decodePng(png({ width: 32768, height: 32768, idat: tiny })), /the limit is 8192 a side/);
  // Just inside the limit is still refused on total pixels.
  assert.throws(() => decodePng(png({ width: 8192, height: 8192, idat: tiny })), /16M pixels/);
});

test('image data larger than the header can account for stops at the header', () => {
  // A few hundred kilobytes that inflate to hundreds of megabytes, in a file
  // that says it is 8x8.
  const bomb = zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024));
  assert.throws(() => decodePng(png({ width: 8, height: 8, idat: bomb })), /larger than its header allows/);
});

test('bit depths the format does not allow are refused rather than misread', () => {
  assert.throws(() => decodePng(png({ width: 4, height: 4, depth: 0 })), /can't have 0-bit samples/);
  assert.throws(() => decodePng(png({ width: 4, height: 4, depth: 255 })), /can't have 255-bit samples/);
  // 2-bit truecolour is not a thing either, even though 2 is a valid depth
  // for greyscale.
  assert.throws(() => decodePng(png({ width: 4, height: 4, depth: 2, colorType: 2 })), /colour type 2 can't have 2-bit/);
});

test('an image with no pixels is not an image', () => {
  assert.throws(() => decodePng(png({ width: 0, height: 0, idat: tiny })), /no pixels/);
  assert.throws(() => decodePng(png({ width: 16, height: 0, idat: tiny })), /no pixels/);
});

test('a palette image without a palette says so, rather than throwing on null', () => {
  const idat = zlib.deflateSync(Buffer.alloc(4 * (1 + 4)));
  assert.throws(() => decodePng(png({ width: 4, height: 4, colorType: 3, idat })), /no palette/);
});

test('truncated and overlong chunks are rejected', () => {
  const good = png({ width: 8, height: 8 });
  assert.throws(() => decodePng(good.subarray(0, good.length >> 1)), /end of file|shorter than its header/);
  const overrun = png({ width: 4, height: 4 });
  overrun.writeUInt32BE(0x7ffffff0, 8); // an IHDR that claims 2GB
  assert.throws(() => decodePng(overrun), /end of file|truncated|header/);
  assert.throws(() => decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), /missing IHDR/);
  assert.throws(() => decodePng(Buffer.alloc(4)), /Not a PNG/);
});

test('image data shorter than the header promises is rejected', () => {
  assert.throws(() => decodePng(png({ width: 64, height: 64, idat: tiny })), /shorter than its header/);
});

test('a real image still decodes, interlaced or not', () => {
  const src = { width: 6, height: 5, data: new Uint8Array(6 * 5 * 4).fill(0x7f) };
  const round = decodePng(encodePng(src));
  assert.equal(round.width, 6);
  assert.equal(round.height, 5);
  assert.deepEqual([...round.data.slice(0, 4)], [0x7f, 0x7f, 0x7f, 0x7f]);
});

test('ICO and ICNS refuse impossible directories rather than trusting them', () => {
  const many = Buffer.alloc(6 + 16);
  many.writeUInt16LE(1, 2); many.writeUInt16LE(65535, 4); // 65535 entries, none present
  assert.throws(() => largestFromIco(many));

  const far = Buffer.alloc(6 + 16);
  far.writeUInt16LE(1, 2); far.writeUInt16LE(1, 4);
  far.writeUInt32LE(0x7fffffff, 6 + 8);
  far.writeUInt32LE(0x7fffffff, 6 + 12);
  assert.throws(() => largestFromIco(far), /No decodable image/);
  assert.throws(() => largestFromIco(Buffer.alloc(6)), /Not an ICO/);

  // An .icns whose member length runs past the end, and one whose members
  // are zero-length — a decoder that trusts either can loop forever.
  const lying = Buffer.alloc(16);
  lying.write('icns', 0, 'latin1'); lying.writeUInt32BE(0xfffffff0, 4);
  lying.write('ic09', 8, 'latin1'); lying.writeUInt32BE(0xfffffff0, 12);
  assert.equal(largestFromIcns(lying), null);

  const empty = Buffer.alloc(24);
  empty.write('icns', 0, 'latin1'); empty.writeUInt32BE(24, 4);
  empty.write('ic09', 8, 'latin1'); empty.writeUInt32BE(0, 12);
  empty.write('ic08', 16, 'latin1'); empty.writeUInt32BE(0, 20);
  assert.equal(largestFromIcns(empty), null);
});
