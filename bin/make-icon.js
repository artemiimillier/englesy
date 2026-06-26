// Generates a 1024x1024 RGBA PNG app icon with no external deps (Node zlib only):
// a blue→purple gradient rounded square with two white "subtitle" bars.
// Used by bin/make-app.sh to build ENGLESY.app's icon. Run: node bin/make-icon.js out.png
const fs = require("fs");
const zlib = require("zlib");

const S = 1024;
const data = Buffer.alloc(S * S * 4);

// rounded-rect coverage (anti-aliased) → alpha 0..1
function roundRectCov(x, y, x0, y0, x1, y1, r) {
  // distance outside a rounded rectangle; returns coverage with ~1px AA
  let dx = 0, dy = 0;
  if (x < x0 + r) dx = x0 + r - x; else if (x > x1 - r) dx = x - (x1 - r);
  if (y < y0 + r) dy = y0 + r - y; else if (y > y1 - r) dy = y - (y1 - r);
  if (dx === 0 && dy === 0) return 1;
  const d = Math.sqrt(dx * dx + dy * dy) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}
const lerp = (a, b, t) => a + (b - a) * t;

const c0 = [91, 141, 239]; // #5B8DEF
const c1 = [139, 92, 246]; // #8B5CF6

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const t = (x + y) / (2 * S); // diagonal gradient
    let r = lerp(c0[0], c1[0], t);
    let g = lerp(c0[1], c1[1], t);
    let b = lerp(c0[2], c1[2], t);

    // two white rounded "subtitle" bars
    const bar1 = roundRectCov(x, y, 250, 436, 774, 540, 52);
    const bar2 = roundRectCov(x, y, 250, 588, 660, 692, 52);
    const white = Math.max(bar1, bar2);
    if (white > 0) { r = lerp(r, 255, white); g = lerp(g, 255, white); b = lerp(b, 255, white); }

    const shapeA = roundRectCov(x, y, 40, 40, S - 40, S - 40, 200);
    data[i] = r | 0; data[i + 1] = g | 0; data[i + 2] = b | 0; data[i + 3] = Math.round(shapeA * 255);
  }
}

// ---- minimal PNG encoder ----
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, body])) >>> 0, 0);
  return Buffer.concat([len, t, body, crc]);
}
const CRC_TABLE = (() => {
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; tbl[n] = c; }
  return tbl;
})();
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return ~c; }

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; data.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
fs.writeFileSync(process.argv[2] || "icon.png", png);
console.log("wrote", process.argv[2] || "icon.png", png.length, "bytes");
