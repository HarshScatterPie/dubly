#!/usr/bin/env node
// Draws the Dubly mark (the "languages" glyph in white on a coral rounded square) as an SVG and as crisp PNGs for every place
// it appears: browser tab, home screens, the web app manifest and emails. Pure Node, deterministic:
//   node server/scripts/render_brand_icons.mjs
// The glyph is Lucide's "languages" icon (ISC licence), the same one the app's sign-in screen and sidebar show.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const EMAIL = path.join(ROOT, 'server', 'assets', 'email');
export const CORAL = '#F05637';

// Lucide "languages", in its 24-unit box, as straight strokes (width 2, round caps and joins).
const GLYPH = [
  [[5, 8], [11, 14]],
  [[4, 14], [10, 8], [12, 5]],
  [[2, 5], [14, 5]],
  [[7, 2], [8, 2]],
  [[22, 22], [17, 12], [12, 22]],
  [[14, 18], [20, 18]],
];
const GLYPH_PATHS = ['m5 8 6 6', 'm4 14 6-6 2-3', 'M2 5h12', 'M7 2h1', 'm22 22-5-10-5 10', 'M14 18h6'];

// The app's own proportions: a 24px glyph in a 48px square with 16px corners (sign-in screen).
const MARK = { glyph: 0.5, radius: 0.3, stroke: 1 };

export function markSvg({ glyph = MARK.glyph, radius = MARK.radius, stroke = MARK.stroke } = {}) {
  const box = 48 * glyph;
  const offset = (48 - box) / 2;
  const scale = box / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="${+(48 * radius).toFixed(2)}" fill="${CORAL}"/><g transform="translate(${+offset.toFixed(3)} ${+offset.toFixed(3)}) scale(${+scale.toFixed(4)})" fill="none" stroke="#fff" stroke-width="${2 * stroke}" stroke-linecap="round" stroke-linejoin="round">${GLYPH_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g></svg>`;
}

function segmentDistance(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Anti-aliased by coverage from signed distances (in pixels), so edges stay smooth at 16 px and at 512 px.
function renderMark(size, { glyph = MARK.glyph, radius = MARK.radius, stroke = MARK.stroke } = {}) {
  const coral = [0xf0, 0x56, 0x37];
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const r = size * radius;
  const box = size * glyph;
  const offset = (size - box) / 2;
  const k = box / 24;
  const halfStroke = stroke * k;
  const segments = GLYPH.flatMap((line) => line.slice(1).map((p, i) => [line[i], p]));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Rounded square.
      const qx = Math.max(Math.abs(px - half) - (half - r), 0);
      const qy = Math.max(Math.abs(py - half) - (half - r), 0);
      const outside = Math.hypot(qx, qy) - r + Math.min(Math.max(Math.abs(px - half) - (half - r), Math.abs(py - half) - (half - r)), 0);
      const alpha = Math.max(0, Math.min(1, 0.5 - outside));
      // Glyph strokes, in glyph units mapped to pixels.
      const gx = (px - offset) / k;
      const gy = (py - offset) / k;
      let d = Infinity;
      for (const [a, b] of segments) d = Math.min(d, segmentDistance(gx, gy, a, b) * k);
      const ink = Math.max(0, Math.min(1, halfStroke + 0.5 - d));
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(coral[0] + (255 - coral[0]) * ink);
      rgba[o + 1] = Math.round(coral[1] + (255 - coral[1]) * ink);
      rgba[o + 2] = Math.round(coral[2] + (255 - coral[2]) * ink);
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

function png(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const OUTPUTS = [
  // Browser tabs: a little more glyph and stroke so it reads at 16-32 px.
  { file: path.join(PUBLIC, 'favicon-32.png'), size: 32, opts: { glyph: 0.6, stroke: 1.15 } },
  { file: path.join(PUBLIC, 'favicon-16.png'), size: 16, opts: { glyph: 0.64, stroke: 1.25 } },
  // iOS rounds the corners itself and wants no transparency.
  { file: path.join(PUBLIC, 'apple-touch-icon.png'), size: 180, opts: { radius: 0, glyph: 0.52 } },
  { file: path.join(PUBLIC, 'icon-192.png'), size: 192, opts: {} },
  { file: path.join(PUBLIC, 'icon-512.png'), size: 512, opts: {} },
  // Android may cut any shape out of it: full bleed, glyph inside the safe circle.
  { file: path.join(PUBLIC, 'icon-maskable-512.png'), size: 512, opts: { radius: 0, glyph: 0.42 } },
  // Emails show it at 38 px; drawn at 2x for sharp screens.
  { file: path.join(EMAIL, 'dubly-mark.png'), size: 96, opts: {} },
];

mkdirSync(PUBLIC, { recursive: true });
mkdirSync(EMAIL, { recursive: true });
writeFileSync(path.join(PUBLIC, 'favicon.svg'), markSvg({ glyph: 0.6, stroke: 1.1 }));
writeFileSync(path.join(PUBLIC, 'dubly-mark.svg'), markSvg());
for (const { file, size, opts } of OUTPUTS) {
  writeFileSync(file, png(size, renderMark(size, opts)));
  console.log(`wrote ${path.relative(ROOT, file)} (${size}px)`);
}
writeFileSync(
  path.join(PUBLIC, 'manifest.webmanifest'),
  JSON.stringify(
    {
      name: 'Dubly',
      short_name: 'Dubly',
      description: 'AI dubbing studio by ScatterPie',
      start_url: '/',
      display: 'standalone',
      background_color: '#FAFAF7',
      theme_color: CORAL,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
      ],
    },
    null,
    2
  ) + '\n'
);
console.log('wrote public/favicon.svg, public/dubly-mark.svg, public/manifest.webmanifest');
