// Release gate: the built frontend stays within its size budget, measured gzip-compressed as it is served, so an import that
// bloats the first page load fails here instead of slowing every visit. Run after `npm run build`.
// The budgets are the sizes of 2026-10-19 plus about 15% headroom; raise them deliberately when a feature needs it.
import { readdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = {
  // Scripts and styles index.html loads before anything renders.
  firstLoad: 170,
  // Every script in the build, lazily loaded chunks included.
  allScripts: 245,
  allStyles: 17,
  largestFile: 155,
};

const dist = 'dist';
const assets = readdirSync(path.join(dist, 'assets')).filter((f) => /\.(js|css)$/.test(f));
const gzipKb = new Map(assets.map((f) => [f, gzipSync(readFileSync(path.join(dist, 'assets', f))).length / 1024]));
const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const firstLoadFiles = [...new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
const sum = (files) => files.reduce((total, f) => total + (gzipKb.get(f) ?? 0), 0);

const measured = {
  firstLoad: sum(firstLoadFiles),
  allScripts: sum(assets.filter((f) => f.endsWith('.js'))),
  allStyles: sum(assets.filter((f) => f.endsWith('.css'))),
  largestFile: Math.max(...gzipKb.values()),
};

const lines = Object.entries(measured).map(([name, kb]) => {
  const over = kb > BUDGET_KB[name];
  return { over, text: `| ${name} | ${kb.toFixed(1)} KB | ${BUDGET_KB[name]} KB | ${over ? 'OVER' : 'ok'} |` };
});
const largest = [...gzipKb.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, kb]) => `| ${f} | ${kb.toFixed(1)} KB |`);
const text = [
  '## Release gate: frontend size (gzip)',
  '',
  '| Measure | Size | Budget | |',
  '|---|---|---|---|',
  ...lines.map((l) => l.text),
  '',
  '| Largest files | Size |',
  '|---|---|',
  ...largest,
  '',
].join('\n');
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
if (firstLoadFiles.length === 0) {
  console.error('index.html loads no hashed assets: is this a production build?');
  process.exit(1);
}
if (lines.some((l) => l.over)) process.exit(1);
