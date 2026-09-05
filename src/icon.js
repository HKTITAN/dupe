// Source icon in, recoloured icon files out.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, isPng } from './image/png.js';
import { largestFromIco, writeIco } from './image/ico.js';
import { largestFromIcns, writeIcns, ICNS_SIZES } from './image/icns.js';
import { largestIconFromExe } from './image/pe-icon.js';
import { analyze, chooseTreatment, recolor } from './image/recolor.js';
import { resize } from './image/resize.js';

export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
export const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512];

/** Load the largest available raster of an app icon from a file of any
 *  supported kind: .exe/.dll (PE resources), .ico, .icns, .png. */
export function loadIcon(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.exe' || ext === '.dll') return largestIconFromExe(file);
  const buf = fs.readFileSync(file);
  if (isPng(buf)) return decodePng(buf);
  if (ext === '.ico') return largestFromIco(buf);
  if (ext === '.icns') {
    const img = largestFromIcns(buf);
    if (!img) throw new Error(`${file} has no PNG-encoded sizes; render it to PNG first`);
    return img;
  }
  throw new Error(`Unsupported icon file: ${file}`);
}

/** Recolour and return the master image plus the treatment that was used. */
export function makeIcon(source, colorHex, treatment = 'auto') {
  const stats = analyze(source);
  const chosen = treatment === 'auto' ? chooseTreatment(stats) : treatment;
  const { img } = recolor(source, colorHex, { treatment: chosen, stats });
  return { master: img, treatment: chosen, stats };
}

function sizesFor(list, master) {
  return list.filter((s) => s <= Math.max(master.width, 256));
}

export function writeIcoFile(master, file) {
  const images = sizesFor(ICO_SIZES, master).map((s) => resize(master, s, s));
  fs.writeFileSync(file, writeIco(images));
  return images.map((i) => i.width);
}

export function writeIcnsFile(master, file) {
  const images = ICNS_SIZES.filter((s) => s <= Math.max(master.width, 512)).map((s) => resize(master, s, s));
  fs.writeFileSync(file, writeIcns(images));
  return images.map((i) => i.width);
}

export function writePngSet(master, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const s of sizesFor(PNG_SIZES, master)) {
    const file = path.join(dir, `${name}-${s}.png`);
    fs.writeFileSync(file, encodePng(resize(master, s, s)));
    written.push({ size: s, file });
  }
  return written;
}

export function writePng(img, file) {
  fs.writeFileSync(file, encodePng(img));
}
