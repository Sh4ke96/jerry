// Renders the JERRY app icon (rounded square with a "J") as PNG files for the web app manifest.
// Dependency-free: a tiny RGBA rasterizer plus a PNG encoder on node:zlib. The shape matches
// apps/dashboard/public/icons/icon.svg (512 x 512 design grid).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BACKGROUND = [0x2e, 0x6a, 0x8a, 0xff];
const FOREGROUND = [0xff, 0xff, 0xff, 0xff];

/** Inside the "J" on the 512 grid: top bar, stem, rounded bottom, left hook. */
function insideJ(x, y) {
  if (y >= 120 && y < 176 && x >= 160 && x < 400) return true; // top bar
  if (x >= 280 && x < 352 && y >= 176 && y < 360) return true; // stem
  if (y >= 352 && y < 416 && x >= 216 && x < 296) return true; // bottom bar
  if (x >= 160 && x < 224 && y >= 304 && y < 360) return true; // hook
  const corner = (cx, cy) => (x - cx) ** 2 + (y - cy) ** 2 <= 56 * 56;
  if (x >= 296 && y >= 360 && corner(296, 360)) return x < 352; // bottom-right round
  if (x < 216 && y >= 360 && corner(216, 360)) return x >= 160; // bottom-left round
  return false;
}

function insideRoundedSquare(x, y) {
  const r = 96;
  const cx = Math.min(Math.max(x, r), 512 - r);
  const cy = Math.min(Math.max(y, r), 512 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size) {
  const samples = 4; // 4x4 supersampling for smooth edges
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = ((px + (sx + 0.5) / samples) / size) * 512;
          const y = ((py + (sy + 0.5) / samples) / size) * 512;
          if (!insideRoundedSquare(x, y)) continue;
          if (insideJ(x, y)) fg += 1;
          else bg += 1;
        }
      }
      const total = samples * samples;
      const offset = (py * size + px) * 4;
      const coverage = (bg + fg) / total;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = bg + fg === 0 ? 0 : (BACKGROUND[channel] * bg + FOREGROUND[channel] * fg) / (bg + fg);
        pixels[offset + channel] = Math.round(value);
      }
      pixels[offset + 3] = Math.round(255 * coverage);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeIcons(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const size of [192, 512]) {
    fs.writeFileSync(path.join(directory, `icon-${size}.png`), encodePng(size, render(size)));
  }
}
