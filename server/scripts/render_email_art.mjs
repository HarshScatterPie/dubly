#!/usr/bin/env node
// Renders the hero images of Dubly's emails (server/assets/email/hero-*.jpg): layered hills shaped like sound waves, lit from the
// sun's side, with rim light, contact shadows between layers, topographic lines on the front layer and film grain. Deterministic,
// so a re-run gives the same pictures. Needs only Node and the bundled ffmpeg:  node server/scripts/render_email_art.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const W = 1200;
const H = 440;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'email');

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCENES = {
  sunrise: {
    seed: 7,
    sky: ['#FFC9B0', '#FFF3E8'],
    sun: { x: 0.76, y: 0.36, r: 62, core: '#FFE7D6', glow: '#FFB48F', side: 1 },
    layers: [
      { base: 0.5, amp: [24, 11, 5], top: '#FAC0AA', bottom: '#F5AC94' },
      { base: 0.61, amp: [30, 13, 6], top: '#F89A79', bottom: '#F08262' },
      { base: 0.73, amp: [34, 15, 7], top: '#F26443', bottom: '#D9472B' },
      { base: 0.86, amp: [26, 12, 5], top: '#3A2B45', bottom: '#1A1526', lines: true },
    ],
  },
  dusk: {
    seed: 21,
    sky: ['#FFCF86', '#FFF2DA'],
    sun: { x: 0.22, y: 0.42, r: 58, core: '#FFF1C9', glow: '#FFB24A', side: -1 },
    layers: [
      { base: 0.52, amp: [22, 10, 5], top: '#F8CD8C', bottom: '#F3BB76' },
      { base: 0.63, amp: [28, 13, 6], top: '#F5A35C', bottom: '#EC8C45' },
      { base: 0.75, amp: [32, 15, 7], top: '#E9693C', bottom: '#CC4E28' },
      { base: 0.87, amp: [24, 11, 5], top: '#3D2630', bottom: '#20141A', lines: true },
    ],
  },
  night: {
    seed: 43,
    sky: ['#121C42', '#33508F'],
    sun: { x: 0.8, y: 0.3, r: 34, core: '#FBF7EC', glow: '#6F8FD6', side: 1 },
    stars: true,
    layers: [
      { base: 0.54, amp: [22, 10, 5], top: '#3E5DA8', bottom: '#33508F' },
      { base: 0.65, amp: [28, 12, 6], top: '#2E468A', bottom: '#253A74' },
      { base: 0.76, amp: [30, 14, 6], top: '#F05637', bottom: '#C9432A' },
      { base: 0.87, amp: [24, 11, 5], top: '#151D3A', bottom: '#0A0F22', lines: true },
    ],
  },
};

function render(scene) {
  const rand = prng(scene.seed);
  const sky = scene.sky.map(rgb);
  const glow = rgb(scene.sun.glow);
  const core = rgb(scene.sun.core);
  // Each layer's skyline: three sine waves, like an audio waveform stretched into hills.
  const layers = scene.layers.map((l) => {
    const phase = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
    const freq = [1.1 + rand() * 0.6, 2.7 + rand() * 0.9, 6.3 + rand() * 1.8];
    const curve = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const u = (x / W) * Math.PI * 2;
      curve[x] = l.base * H + l.amp.reduce((s, a, k) => s + a * Math.sin(u * freq[k] + phase[k]), 0);
    }
    return { ...l, top: rgb(l.top), bottom: rgb(l.bottom), curve };
  });
  const stars = scene.stars ? Array.from({ length: 140 }, () => [rand() * W, rand() * H * 0.6, 0.35 + rand() * 0.65]) : [];
  const px = Buffer.alloc(W * H * 3);
  const sx = scene.sun.x * W;
  const sy = scene.sun.y * H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Sky, sun glow and disc.
      let c = mix(sky[0], sky[1], Math.pow(y / H, 0.85));
      const d = Math.hypot(x - sx, y - sy);
      c = mix(c, glow, Math.exp(-((d / (scene.sun.r * 3.2)) ** 2)) * 0.55);
      c = mix(c, core, 1 - smooth(scene.sun.r - 2, scene.sun.r + 2, d));
      // Topmost layer covering this pixel.
      let i = -1;
      for (let k = layers.length - 1; k >= 0; k--) {
        if (y >= layers[k].curve[x]) {
          i = k;
          break;
        }
      }
      if (i >= 0) {
        const l = layers[i];
        const top = l.curve[x];
        const depth = y - top;
        let lc = mix(l.top, l.bottom, Math.pow(clamp(depth / (H - top), 0, 1), 0.8));
        // Light from the sun's side: slopes facing it are brighter.
        const slope = (l.curve[Math.min(W - 1, x + 2)] - l.curve[Math.max(0, x - 2)]) / 4;
        const lit = 1 + 0.32 * clamp(slope * scene.sun.side, -0.7, 0.7);
        lc = lc.map((v) => v * lit);
        // Rim light along the skyline.
        if (depth < 5) lc = mix(lc, [255, 248, 240], (1 - depth / 5) * 0.28);
        // Contour lines on the front layer: the "3D terrain" texture.
        if (l.lines && depth > 8 && depth % 20 < 1.3) lc = mix(lc, [255, 255, 255], 0.07);
        // Far layers fade into the air.
        lc = mix(lc, sky[1], (1 - i / (layers.length - 1)) * 0.22);
        // Contact shadow where the next layer rises in front.
        const next = layers[i + 1];
        if (next) {
          const gap = next.curve[x] - y;
          if (gap > 0 && gap < 16) lc = lc.map((v) => v * (1 - (1 - gap / 16) * 0.2));
        }
        c = lc;
      } else {
        for (const [stx, sty, b] of stars) {
          const sd = Math.hypot(x - stx, y - sty);
          if (sd < 1.6) c = mix(c, [255, 255, 255], b * (1 - sd / 1.6));
        }
      }
      // Soft vignette and film grain.
      const vx = x / W - 0.5;
      const vy = y / H - 0.5;
      const vig = 1 - 0.14 * (vx * vx + vy * vy) * 2;
      const grain = (rand() - 0.5) * 9;
      const o = (y * W + x) * 3;
      px[o] = clamp(c[0] * vig + grain, 0, 255);
      px[o + 1] = clamp(c[1] * vig + grain, 0, 255);
      px[o + 2] = clamp(c[2] * vig + grain, 0, 255);
    }
  }
  return px;
}

mkdirSync(OUT, { recursive: true });
const work = path.join(tmpdir(), `dubly-email-art-${process.pid}`);
mkdirSync(work, { recursive: true });
try {
  for (const [name, scene] of Object.entries(SCENES)) {
    const ppm = path.join(work, `${name}.ppm`);
    writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), render(scene)]));
    const out = path.join(OUT, `hero-${name}.jpg`);
    const r = spawnSync(ffmpegPath, ['-y', '-loglevel', 'error', '-i', ppm, '-q:v', '3', out]);
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${r.stderr}`);
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
