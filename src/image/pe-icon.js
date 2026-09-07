// Pulls the application icon out of a Windows PE executable by walking the
// .rsrc tree: RT_GROUP_ICON (14) -> RT_ICON (3). Reads only the headers and
// the resource section, so a 200 MB Electron binary costs a few MB of RAM.
import fs from 'node:fs';
import { decodeIconImage } from './ico.js';

const RT_ICON = 3, RT_GROUP_ICON = 14;

// Every length here comes out of the file's own headers, so each one is
// clamped to what the file actually holds before it becomes an allocation.
// Buffer.alloc zero-fills, so an unclamped SizeOfRawData is memory really
// touched: a 5KB executable could ask for 2GB.
function readAt(fd, offset, length, limit = Infinity) {
  const want = Math.max(0, Math.min(length, limit));
  const buf = Buffer.alloc(want);
  const n = want ? fs.readSync(fd, buf, 0, want, offset) : 0;
  return buf.subarray(0, n);
}

export function readPeIcons(exePath) {
  const fd = fs.openSync(exePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const head = readAt(fd, 0, 8192, fileSize);
    if (head.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a PE file');
    const pe = head.readUInt32LE(0x3c);
    if (head.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Bad PE signature');
    const coff = pe + 4;
    const numSections = head.readUInt16LE(coff + 2);
    const optSize = head.readUInt16LE(coff + 16);
    const opt = coff + 20;
    const magic = head.readUInt16LE(opt);
    const ddOffset = magic === 0x20b ? 112 : 96;
    const rsrcRva = head.readUInt32LE(opt + ddOffset + 2 * 8);
    if (!rsrcRva) throw new Error('No resource section');
    const secTable = opt + optSize;
    // The section table has to be inside the 8KB we read, or the reads below
    // walk off the end of the buffer with a raw RangeError.
    if (secTable < 0 || secTable + numSections * 40 > head.length) throw new Error('PE section table is past the headers dupe read');
    let section = null;
    for (let i = 0; i < numSections; i++) {
      const s = secTable + i * 40;
      const vsize = head.readUInt32LE(s + 8);
      const va = head.readUInt32LE(s + 12), rawSize = head.readUInt32LE(s + 16), rawPtr = head.readUInt32LE(s + 20);
      if (rsrcRva >= va && rsrcRva < va + Math.max(vsize, rawSize)) { section = { va, rawSize, rawPtr }; break; }
    }
    if (!section) throw new Error('Resource section not found');
    if (section.rawPtr >= fileSize) throw new Error('Resource section starts outside the file');
    const rsrc = readAt(fd, section.rawPtr, section.rawSize, fileSize - section.rawPtr);
    const base = rsrcRva - section.va; // offset of the root directory inside rsrc

    function dirEntries(off) {
      if (off < 0 || off + 16 > rsrc.length) return [];
      const named = rsrc.readUInt16LE(off + 12), ids = rsrc.readUInt16LE(off + 14);
      const out = [];
      for (let i = 0; i < named + ids; i++) {
        const e = off + 16 + i * 8;
        if (e + 8 > rsrc.length) break;
        out.push({ id: rsrc.readUInt32LE(e), off: rsrc.readUInt32LE(e + 4) });
      }
      return out;
    }
    // Descend through name -> language subdirectories to the data entry. The
    // real tree is three deep — type, name, language — and a subdirectory
    // offset pointing back at its own directory used to spin here forever,
    // synchronously, which stops `dupe ui` answering at all.
    function leafData(entry) {
      let off = entry.off;
      for (let depth = 0; off & 0x80000000; depth++) {
        if (depth >= 4) return null;
        const kids = dirEntries(off & 0x7fffffff);
        if (!kids.length) return null;
        off = kids[0].off;
      }
      if (off < 0 || off + 8 > rsrc.length) return null;
      const rva = rsrc.readUInt32LE(off), size = rsrc.readUInt32LE(off + 4);
      const start = rva - section.va;
      if (start < 0 || start >= rsrc.length) return null;
      return rsrc.subarray(start, start + Math.min(size, rsrc.length - start));
    }
    const types = dirEntries(base);
    const groups = types.find((t) => t.id === RT_GROUP_ICON);
    const icons = types.find((t) => t.id === RT_ICON);
    if (!groups || !icons) throw new Error('Executable has no icon resources');
    const iconEntries = dirEntries(icons.off & 0x7fffffff);
    const iconData = (id) => {
      const e = iconEntries.find((x) => x.id === id);
      return e ? leafData(e) : null;
    };
    const result = [];
    for (const g of dirEntries(groups.off & 0x7fffffff)) {
      const grp = leafData(g);
      if (!grp) continue;
      if (grp.length < 6) continue;
      // A truncated group resource can claim more members than it carries.
      const count = Math.min(grp.readUInt16LE(4), Math.max(0, (grp.length - 6) / 14 | 0));
      const members = [];
      for (let i = 0; i < count; i++) {
        const e = 6 + i * 14;
        members.push({
          width: grp[e] || 256, height: grp[e + 1] || 256,
          bits: grp.readUInt16LE(e + 6), size: grp.readUInt32LE(e + 8), id: grp.readUInt16LE(e + 12),
        });
      }
      result.push({ groupId: g.id, members, data: iconData });
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

// The first (lowest-id) icon group is the application icon in every Electron
// build and nearly every other toolchain. Returns its largest member as RGBA.
export function largestIconFromExe(exePath) {
  const groups = readPeIcons(exePath).sort((a, b) => a.groupId - b.groupId);
  for (const g of groups) {
    const members = [...g.members].sort((a, b) => b.width * b.height - a.width * a.height || b.bits - a.bits);
    for (const m of members) {
      const data = g.data(m.id);
      if (!data) continue;
      try { return decodeIconImage(data); } catch { /* next member */ }
    }
  }
  throw new Error('No decodable icon in executable');
}
