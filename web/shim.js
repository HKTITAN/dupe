// Browser stand-ins for the two Node pieces the image modules touch:
// a Buffer subset (the exact methods png/ico/icns use) and a zlib whose
// deflateSync emits stored blocks (no compression, always valid) — icon
// files are small enough that this costs nothing worth fixing.

class Buffer extends Uint8Array {
  static alloc(n) { return new Buffer(n); }
  static from(src, enc) {
    if (typeof src === 'string') {
      const b = new Buffer(src.length);
      for (let i = 0; i < src.length; i++) b[i] = src.charCodeAt(i) & 0xff;
      return b;
    }
    if (src instanceof ArrayBuffer) return new Buffer(src);
    const b = new Buffer(src.length);
    b.set(src);
    return b;
  }
  static concat(list) {
    const total = list.reduce((s, b) => s + b.length, 0);
    const out = new Buffer(total);
    let o = 0;
    for (const b of list) { out.set(b, o); o += b.length; }
    return out;
  }
  static isBuffer(b) { return b instanceof Buffer; }
  subarray(s, e) { return new Buffer(this.buffer, this.byteOffset + (s || 0), Math.max(0, (e === undefined ? this.length : Math.min(e, this.length)) - (s || 0))); }
  get view() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUInt8(o) { return this[o]; }
  readUInt16LE(o) { return this.view.getUint16(o, true); }
  readUInt16BE(o) { return this.view.getUint16(o, false); }
  readUInt32LE(o) { return this.view.getUint32(o, true); }
  readUInt32BE(o) { return this.view.getUint32(o, false); }
  readInt32LE(o) { return this.view.getInt32(o, true); }
  writeUInt16LE(v, o) { this.view.setUint16(o, v, true); return o + 2; }
  writeUInt32LE(v, o) { this.view.setUint32(o, v >>> 0, true); return o + 4; }
  writeUInt32BE(v, o) { this.view.setUint32(o, v >>> 0, false); return o + 4; }
  writeInt32LE(v, o) { this.view.setInt32(o, v, true); return o + 4; }
  toString(enc, s = 0, e = this.length) {
    let out = '';
    for (let i = s; i < e; i++) out += String.fromCharCode(this[i]);
    return out;
  }
  write(str, off = 0) { for (let i = 0; i < str.length; i++) this[off + i] = str.charCodeAt(i) & 0xff; return str.length; }
  equals(other) {
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
}

function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const zlib = {
  deflateSync(data) {
    const blocks = Math.max(1, Math.ceil(data.length / 65535));
    const out = new Buffer(2 + data.length + blocks * 5 + 4);
    out[0] = 0x78; out[1] = 0x01;
    let o = 2, p = 0;
    for (let i = 0; i < blocks; i++) {
      const len = Math.min(65535, data.length - p);
      out[o++] = i === blocks - 1 ? 1 : 0;
      out[o++] = len & 0xff; out[o++] = len >> 8;
      out[o++] = ~len & 0xff; out[o++] = (~len >> 8) & 0xff;
      out.set(data.subarray(p, p + len), o);
      o += len; p += len;
    }
    out.writeUInt32BE(adler32(data), o);
    return out;
  },
  inflateSync() { throw new Error('PNG decoding in the browser goes through the canvas, not zlib'); },
};

export { Buffer, zlib };
