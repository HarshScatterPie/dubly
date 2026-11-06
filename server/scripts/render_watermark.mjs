// Draws the label burned into Free and Starter dubs: server/assets/watermark/dubbed-by-dubly.png, on a transparent background.
// Run it only to change the wording or look (npx is not needed): node server/scripts/render_watermark.mjs
// It needs Microsoft Edge or Chrome on this machine; the PNG it writes is committed, so servers never run this.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'Dubbed by Dubly Studio';
const WIDTH = 1180;
const HEIGHT = 176;

const browser = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find(existsSync);
if (!browser) throw new Error('No Edge or Chrome found.');

const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; }
  .label { box-sizing: border-box; width: ${WIDTH}px; height: ${HEIGHT}px; display: flex; align-items: center; gap: 36px; padding: 0 56px 0 28px;
    border-radius: 44px; background: rgba(15, 23, 42, 0.66); color: #fff; font: 600 88px 'Segoe UI', system-ui, sans-serif; letter-spacing: -1px; white-space: nowrap; }
  .mark { width: 120px; height: 120px; border-radius: 30px; background: #F05637; display: flex; align-items: center; justify-content: center; flex: none; }
</style>
<div class="label"><div class="mark">
  <svg width="84" height="84" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>
  </svg></div><span>${LABEL}</span></div>`;

const work = mkdtempSync(path.join(tmpdir(), 'dubly-label-'));
const page = path.join(work, 'label.html');
writeFileSync(page, html);
const target = fileURLToPath(new URL('../assets/watermark/dubbed-by-dubly.png', import.meta.url));
mkdirSync(path.dirname(target), { recursive: true });
try {
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    `--user-data-dir=${path.join(work, 'profile')}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `--screenshot=${target}`,
    pathToFileURL(page).href,
  ], { stdio: 'ignore', timeout: 60_000 });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Wrote ${target}`);
