/* Build the raster icons from the same geometry as app/icon.svg.
 *
 *   node apps/terminal/scripts/make-icons.mjs
 *     → app/favicon.ico     16 + 32 + 48, PNG-in-ICO
 *     → app/apple-icon.png  180x180
 *
 * Why draw rather than rasterise: a stock macOS box has no SVG rasteriser we
 * can use. No Pillow, no cairosvg, no rsvg-convert, no ImageMagick; `sips`
 * cannot read SVG at all; `qlmanage` renders through WebKit onto an opaque
 * backing, which would fill the tile's rounded corners with white. The mark is
 * three analytic primitives, so drawing it directly is both shorter and exact.
 *
 * Zero dependencies (node stdlib only) and no network — the terminal build is
 * deliberately hermetic (.github/workflows/ci.yml) and this must not change
 * that. Committed output, run-once script: nothing in CI executes this.
 *
 * If app/icon.svg changes, re-run this so the two do not drift.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "app");

/* ---- the palette, from app/globals.css :root ---- */
const GENESIS = [0, 11, 36]; // --genesis  #000b24
const LEDGER = [11, 34, 62]; // --ledger   #0b223e
const SAND = [255, 204, 111]; // --sand     #ffcc6f  ("THE rate color")
const GOLD = [233, 161, 63]; // --gold     #e9a13f
const VALID = [50, 103, 150]; // the cool end of --horizon-line  #326796

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c, d, t) => [lerp(c[0], d[0], t), lerp(c[1], d[1], t), lerp(c[2], d[2], t)];

/* the rule's ramp — the same stops as #acr-rule in app/icon.svg */
const STOPS = [
  [0, VALID, 0],
  [0.1, VALID, 1],
  [0.52, GOLD, 1],
  [0.9, GOLD, 1],
  [1, GOLD, 0],
];
function ramp(t) {
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const u = (t - a[0]) / (b[0] - a[0]);
      return [...mix(a[1], b[1], u), lerp(a[2], b[2], u)];
    }
  }
  return [0, 0, 0, 0];
}

/* rounded rect over [0,32]^2: clamp to the inner rect, then distance <= radius */
function inTile(x, y, r) {
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/* one sample of the mark, in the 32-unit design space of app/icon.svg */
function sample(x, y, tileRadius) {
  if (!inTile(x, y, tileRadius)) return [0, 0, 0, 0];
  let c = mix(GENESIS, LEDGER, y / 32); // the pre-dawn sky
  const d = Math.hypot(x - 16, y - 18) / 12; // the glow
  if (d < 1) c = mix(c, SAND, 0.3 * (1 - d));
  if (y >= 18 && y < 22) {
    const h = ramp(x / 32); // the house rule
    c = mix(c, [h[0], h[1], h[2]], h[3]);
  }
  if (y <= 18 && (x - 16) ** 2 + (y - 18) ** 2 <= 64) c = SAND; // the rate, cresting
  return [c[0], c[1], c[2], 255];
}

/* 4x4 supersample, premultiplied so the rounded corners antialias correctly */
function render(size, tileRadius) {
  const px = Buffer.alloc(size * size * 4);
  const S = 4;
  const k = 32 / size;
  for (let py = 0; py < size; py++) {
    for (let pi = 0; pi < size; pi++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const s = sample((pi + (i + 0.5) / S) * k, (py + (j + 0.5) / S) * k, tileRadius);
          const a = s[3] / 255;
          R += s[0] * a;
          G += s[1] * a;
          B += s[2] * a;
          A += a;
        }
      }
      const o = (py * size + pi) * 4;
      if (A > 0) {
        px[o] = Math.round(R / A);
        px[o + 1] = Math.round(G / A);
        px[o + 2] = Math.round(B / A);
      }
      px[o + 3] = Math.round((A / (S * S)) * 255);
    }
  }
  return px;
}

/* ---- PNG (8-bit RGBA, filter 0) ---- */
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---- ICO container (ICONDIR + ICONDIRENTRY[] + PNG payloads) ---- */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // width  (0 means 256)
    e[1] = e[0]; // height
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.buf)]);
}

const sizes = [16, 32, 48];
writeFileSync(
  join(APP, "favicon.ico"),
  ico(sizes.map((s) => ({ size: s, buf: png(s, render(s, 7)) }))),
);
// iOS masks the corners itself, so the apple icon ships square and full-bleed.
writeFileSync(join(APP, "apple-icon.png"), png(180, render(180, 0)));
console.log("wrote app/favicon.ico (16/32/48) and app/apple-icon.png (180)");
