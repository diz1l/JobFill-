#!/usr/bin/env node
/**
 * Generates placeholder JobFill icons in public/icons/.
 * Uses only Node.js built-ins — no npm dependencies.
 */
const { deflateSync } = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 32, 48, 128];

// CRC-32 lookup table
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = -1;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

/**
 * Draw a simple rounded rectangle with a blue gradient "J" letter.
 * Format: RGBA (color type 6).
 */
function drawIcon(size) {
  // Background: #2563eb (blue-600)
  const bgR = 0x25, bgG = 0x63, bgB = 0xeb;
  // Letter color: white
  const fgR = 0xff, fgG = 0xff, fgB = 0xff;

  const pixels = Buffer.alloc(size * size * 4, 0);

  // Fill background with rounded corners
  const r = Math.max(2, Math.round(size * 0.2)); // corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCorner =
        (x < r && y < r && (x - r) ** 2 + (y - r) ** 2 > r * r) ||
        (x >= size - r && y < r && (x - (size - r - 1)) ** 2 + (y - r) ** 2 > r * r) ||
        (x < r && y >= size - r && (x - r) ** 2 + (y - (size - r - 1)) ** 2 > r * r) ||
        (x >= size - r && y >= size - r &&
          (x - (size - r - 1)) ** 2 + (y - (size - r - 1)) ** 2 > r * r);

      const off = (y * size + x) * 4;
      if (!inCorner) {
        pixels[off] = bgR;
        pixels[off + 1] = bgG;
        pixels[off + 2] = bgB;
        pixels[off + 3] = 255;
      }
    }
  }

  // Draw a simple "J" using a thick stroke
  const stroke = Math.max(1, Math.round(size * 0.12));
  const pad = Math.round(size * 0.22);
  const top = Math.round(size * 0.18);
  const bottom = size - pad;
  const cx = Math.round(size * 0.55); // center-x of J vertical bar
  const hookEndX = Math.round(size * 0.3);
  const hookY = Math.round(size * 0.72);

  function setPixel(x, y) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const off = (y * size + x) * 4;
    if (pixels[off + 3] === 0) return; // don't paint on transparent
    pixels[off] = fgR;
    pixels[off + 1] = fgG;
    pixels[off + 2] = fgB;
    pixels[off + 3] = 255;
  }

  // Top horizontal bar of J
  const barLeft = Math.round(size * 0.28);
  const barRight = Math.round(size * 0.78);
  for (let x = barLeft; x <= barRight; x++) {
    for (let s = 0; s < stroke; s++) setPixel(x, top + s);
  }

  // Vertical stem of J
  for (let y = top; y <= hookY; y++) {
    for (let s = 0; s < stroke; s++) setPixel(cx + s, y);
  }

  // Hook (semicircle at bottom)
  const hookR = (cx - hookEndX + stroke / 2);
  const hookCx = cx + stroke / 2;
  const hookCy = hookY;
  for (let angle = 0; angle <= 180; angle += 2) {
    const rad = (angle * Math.PI) / 180;
    for (let dr = -stroke / 2; dr <= stroke / 2; dr++) {
      const px = Math.round(hookCx - (hookR + dr) * Math.sin(rad));
      const py = Math.round(hookCy + (hookR + dr) * Math.cos(rad));
      setPixel(px, py);
    }
  }

  return pixels;
}

function buildPng(size) {
  const pixels = drawIcon(size);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data (filter byte + RGBA per row)
  const raw = Buffer.alloc((1 + size * 4) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0; // filter: None
    pixels.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const idat = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const png = buildPng(size);
  const out = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✔ ${out} (${png.length} bytes)`);
}

console.log('Icons generated successfully.');
