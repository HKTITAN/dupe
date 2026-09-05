import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng } from '../src/image/png.js';
import { readIco, writeIco, largestFromIco } from '../src/image/ico.js';
import { readIcns, writeIcns, largestFromIcns } from '../src/image/icns.js';
import { resize } from '../src/image/resize.js';
import { analyze, chooseTreatment, recolor } from '../src/image/recolor.js';
import { hexToOklch, oklchToHex, parseHex } from '../src/image/color.js';
import { NAMED, resolveColor, nextColor } from '../src/palette.js';

// A rounded tile of `field` colour with a centred disc of `mark` colour.
function tile(size, field, mark, { radius = 0.2, disc = 0.3 } = {}) {
  const data = new Uint8Array(size * size * 4);
  const r = size * radius, c = size / 2, d = size * disc;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4;
    const cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    if (Math.hypot(x - cx, y - cy) > r) continue; // outside the rounded corner
    const px = Math.hypot(x - c, y - c) < d ? mark : field;
    data[o] = px[0]; data[o + 1] = px[1]; data[o + 2] = px[2]; data[o + 3] = 255;
  }
  return { width: size, height: size, data };
}

test('png round-trips RGBA exactly', () => {
  const img = tile(64, [217, 119, 87], [250, 240, 230]);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 64);
  assert.deepEqual(Array.from(back.data), Array.from(img.data));
});

test('ico writes PNG for large and DIB for small sizes and reads both back', () => {
  const big = tile(256, [30, 30, 30], [240, 240, 240]);
  const small = resize(big, 32, 32);
  const buf = writeIco([big, small]);
  const entries = readIco(buf);
  assert.deepEqual(entries.map((e) => e.width), [32, 256]);
  const largest = largestFromIco(buf);
  assert.equal(largest.width, 256);
  assert.deepEqual(Array.from(largest.data.subarray(0, 8)), Array.from(big.data.subarray(0, 8)));
  const smallBack = readIco(buf)[0];
  const dib = largestFromIco(writeIco([small]));
  assert.equal(dib.width, 32);
  assert.deepEqual(Array.from(dib.data), Array.from(small.data));
  assert.equal(smallBack.bits, 32);
});

test('icns round-trips PNG payloads', () => {
  const img = tile(128, [20, 120, 200], [255, 255, 255]);
  const buf = writeIcns([img, resize(img, 32, 32)]);
  assert.deepEqual(readIcns(buf).map((e) => e.type).sort(), ['ic07', 'ic11', 'icp5'].sort());
  assert.equal(largestFromIcns(buf).width, 128);
});

test('resize averages area and keeps alpha edges clean', () => {
  const img = tile(128, [255, 0, 0], [255, 0, 0]);
  const out = resize(img, 32, 32);
  assert.equal(out.width, 32);
  const centre = (16 * 32 + 16) * 4;
  assert.deepEqual(Array.from(out.data.subarray(centre, centre + 4)), [255, 0, 0, 255]);
  const corner = 0;
  assert.equal(out.data[corner + 3], 0); // rounded corner stays transparent
});

test('treatment: colourful tile gets hue rotation and lands on the target hue', () => {
  const img = tile(96, [217, 119, 87], [250, 240, 230]);
  const stats = analyze(img);
  assert.equal(chooseTreatment(stats), 'hue');
  const { img: out } = recolor(img, '#1b91e3', { stats });
  const o = (4 * 96 + 48) * 4; // top edge, field
  const [, , h] = hexToOklch('#' + [out.data[o], out.data[o + 1], out.data[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''));
  const [, , target] = hexToOklch('#1b91e3');
  assert.ok(Math.abs(h - target) < 3, `hue ${h} should be near ${target}`);
  const m = (48 * 96 + 48) * 4; // centre, mark stays near white
  assert.ok(out.data[m] > 220 && out.data[m + 1] > 220 && out.data[m + 2] > 220);
});

test('treatment: dark mark on light field -> white mark on target field', () => {
  const img = tile(96, [255, 255, 255], [0, 0, 0]);
  const stats = analyze(img);
  assert.equal(chooseTreatment(stats), 'ramp-light');
  const { img: out } = recolor(img, '#1b91e3', { stats });
  const field = (4 * 96 + 48) * 4, mark = (48 * 96 + 48) * 4;
  assert.deepEqual(Array.from(out.data.subarray(field, field + 3)), parseHex('#1b91e3'));
  assert.deepEqual(Array.from(out.data.subarray(mark, mark + 3)), [255, 255, 255]);
});

test('treatment: light mark on dark field, even when the mark dominates the area', () => {
  const img = tile(96, [20, 20, 20], [240, 240, 240], { disc: 0.47 });
  const stats = analyze(img);
  assert.equal(chooseTreatment(stats), 'ramp-dark');
  const { img: out } = recolor(img, '#1b91e3', { stats });
  const field = (2 * 96 + 48) * 4, mark = (48 * 96 + 48) * 4;
  assert.deepEqual(Array.from(out.data.subarray(field, field + 3)), parseHex('#1b91e3'));
  assert.ok(out.data[mark] > 240 && out.data[mark + 2] > 240);
});

test('palette: names resolve, hexes pass through, next colour skips used ones', () => {
  assert.equal(resolveColor('blue'), '#1b91e3');
  assert.equal(resolveColor('1B91E3'), '#1b91e3');
  assert.throws(() => resolveColor('not-a-colour'));
  assert.equal(nextColor([]), NAMED.blue);
  assert.equal(nextColor([NAMED.blue]), NAMED.green);
  const [L, C] = hexToOklch(NAMED.purple);
  assert.ok(Math.abs(L - 0.63) < 0.02 && C > 0.1);
  assert.match(oklchToHex(0.63, 0.16, 245), /^#[0-9a-f]{6}$/);
});
