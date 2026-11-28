// Draws the app and tray icons (a ring with a quarter left open, on a black rounded square) into icons/.
// Run: node scripts/make-icons.mjs   (from clients/windows)
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA pixels of the icon at size s (supersampled 4×4 per pixel) */
function draw(s) {
  const px = Buffer.alloc(s * s * 4);
  const r = s * 0.22; // corner radius of the square
  const cx = s / 2, cy = s / 2;
  const ringR = s * 0.3, stroke = s * 0.1;
  const inSquare = (x, y) => {
    const dx = Math.max(r - x, 0, x - (s - r)), dy = Math.max(r - y, 0, y - (s - r));
    return dx * dx + dy * dy <= r * r;
  };
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let bg = 0, ring = 0, track = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const X = x + (sx + 0.5) / 4, Y = y + (sy + 0.5) / 4;
          if (!inSquare(X, Y)) continue;
          bg++;
          const d = Math.hypot(X - cx, Y - cy);
          if (Math.abs(d - ringR) > stroke / 2) continue;
          // angle from 12 o'clock, clockwise; the arc covers three quarters (a quarter is left open)
          const a = (Math.atan2(X - cx, -(Y - cy)) + 2 * Math.PI) % (2 * Math.PI);
          if (a <= Math.PI * 1.5) ring++; else track++;
        }
      }
      const i = (y * s + x) * 4;
      const n = 16;
      // black square, white arc, dark gray track
      const R = (ring * 255 + track * 0x40) / Math.max(1, bg);
      px[i] = px[i + 1] = px[i + 2] = Math.round(R);
      px[i + 3] = Math.round((bg / n) * 255);
    }
  }
  return px;
}

function png(s) {
  const raw = draw(s);
  const rows = Buffer.alloc(s * (s * 4 + 1));
  for (let y = 0; y < s; y++) {
    rows[y * (s * 4 + 1)] = 0;
    raw.copy(rows, y * (s * 4 + 1) + 1, y * s * 4, (y + 1) * s * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s; header[e + 1] = s >= 256 ? 0 : s; header[e + 2] = 0; header[e + 3] = 0;
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync("icons", { recursive: true });
writeFileSync("icons/icon.png", png(256));
writeFileSync("icons/tray.png", png(32));
writeFileSync("icons/icon.ico", ico([16, 24, 32, 48, 64, 256]));
console.log("icons/icon.png, icons/tray.png, icons/icon.ico");
