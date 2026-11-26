// A copy of hard-fork/bench/perfect-sim/png.mjs, which test/paint-hard/scoring.mjs decodes the five bundled goals with
// in Node. A minimal PNG decoder: 8-bit, non-interlaced, color type 2 (RGB), 6 (RGBA) or 3 (palette, with PLTE and
// tRNS). Returns RGBA bytes (alpha 255 where the file has none).
import fs from "node:fs";
import zlib from "node:zlib";

export function decodePNG(path) {
  const buf = fs.readFileSync(path);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error(`${path}: not a PNG`);
  let off = 8, w, h, bitDepth, colorType, interlace, plte = null, trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "PLTE") plte = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 3, 6].includes(colorType)) throw new Error(`${path}: unsupported depth ${bitDepth} type ${colorType} interlace ${interlace}`);
  if (colorType === 3 && !plte) throw new Error(`${path}: palette image without PLTE`);
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (raw.length !== h * (stride + 1)) throw new Error(`${path}: inflated ${raw.length} bytes, expected ${h * (stride + 1)}`);
  const px = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    if (f > 4) throw new Error(`${path}: bad filter ${f} on row ${y}`);
    const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = x >= bpp && y > 0 ? px[prev + x - bpp] : 0;
      let v = raw[p++];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    if (colorType === 6) { rgba[4 * i] = px[4 * i]; rgba[4 * i + 1] = px[4 * i + 1]; rgba[4 * i + 2] = px[4 * i + 2]; rgba[4 * i + 3] = px[4 * i + 3]; }
    else if (colorType === 2) { rgba[4 * i] = px[3 * i]; rgba[4 * i + 1] = px[3 * i + 1]; rgba[4 * i + 2] = px[3 * i + 2]; rgba[4 * i + 3] = 255; }
    else {
      const k = px[i];
      if (3 * k + 2 >= plte.length) throw new Error(`${path}: palette index ${k} out of range`);
      rgba[4 * i] = plte[3 * k]; rgba[4 * i + 1] = plte[3 * k + 1]; rgba[4 * i + 2] = plte[3 * k + 2];
      rgba[4 * i + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { w, h, colorType, rgba };
}
