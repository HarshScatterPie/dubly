// Release gate: starts the server the way production's systemd unit does (`node --import tsx server/index.ts`, built frontend,
// NODE_ENV=production) against a throwaway MongoDB (MONGODB_URI/MONGODB_DB), and fails unless it boots quickly, serves the app with its security
// and cache headers, keeps the API behind sign-in, answers a burst of requests fast without errors, stays small in memory and
// shuts down cleanly.
// Run after `npm run build` with a MongoDB replica set reachable. PERF_BUDGET_SCALE multiplies the time budgets.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';

const scale = Number(process.env.PERF_BUDGET_SCALE) || 1;
const port = 18787;
const base = `http://127.0.0.1:${port}`;
const failures = [];
const report = [];
const check = (ok, label) => {
  report.push(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};

const started = Date.now();
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));
const exited = new Promise((resolve) => server.on('exit', (code, signal) => resolve({ code, signal })));

async function get(path, headers = {}) {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, { headers });
  const body = await res.text();
  return { res, body, ms: performance.now() - t };
}

try {
  let healthy = false;
  while (!healthy && Date.now() - started < 60_000) {
    healthy = await get('/api/healthz').then((r) => r.res.ok, () => false);
    if (!healthy) await new Promise((r) => setTimeout(r, 200));
  }
  const bootSeconds = (Date.now() - started) / 1000;
  check(healthy && bootSeconds <= 30 * scale, `boots and answers /api/healthz in ${bootSeconds.toFixed(1)} s (budget ${30 * scale} s)`);
  if (!healthy) throw new Error('server never became healthy');

  const page = await get('/', { 'Accept-Encoding': 'gzip' });
  check(page.res.status === 200 && page.body.includes('<div id="root"'), 'serves the built app at /');
  check(page.res.headers.get('cache-control') === 'no-cache', 'the app page is revalidated on every visit (Cache-Control: no-cache)');
  for (const [name, value] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'strict-origin-when-cross-origin'],
  ]) check(page.res.headers.get(name) === value, `security header ${name}: ${value}`);
  check(/script-src 'self'/.test(page.res.headers.get('content-security-policy') ?? ''), 'content security policy is enforced');
check(!/unsafe-inline/.test(page.res.headers.get('content-security-policy') ?? ''), 'no inline styles or scripts are allowed');

  const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
  check(Boolean(script), 'the page loads a hashed script bundle');
  if (script) {
    const asset = await get(script, { 'Accept-Encoding': 'gzip' });
    check(asset.res.status === 200 && /immutable/.test(asset.res.headers.get('cache-control') ?? ''), 'hashed assets are cached for good (immutable)');
    check(asset.res.headers.get('content-encoding') === 'gzip', 'scripts are gzip-compressed');
  }
  const deepLink = await get('/projects/some-project');
  check(deepLink.res.status === 200 && deepLink.body.includes('<div id="root"'), 'client-side routes get the app page');

  const unauthenticated = await get('/api/projects');
  check(unauthenticated.res.status === 401, 'the API refuses requests without sign-in (401)');
  check(!/stack|at \w+ \(/.test(unauthenticated.body), 'error responses carry no stack traces');

  // A burst like many open tabs polling at once: 20 at a time, 400 requests over the health check and the page.
  const timings = [];
  let errors = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (next < 400) {
        const k = next++;
        const r = await get(k % 4 === 0 ? '/' : '/api/healthz').catch(() => null);
        if (!r || r.res.status !== 200) errors++;
        else timings.push(r.ms);
      }
    })
  );
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * 0.95)] ?? Infinity;
  check(errors === 0, `burst of 400 requests: ${errors} failed`);
  check(p95 <= 250 * scale, `burst of 400 requests: p95 ${p95.toFixed(0)} ms (budget ${250 * scale} ms)`);

  // Resident memory of the server process once it is up (Linux only: read from /proc).
  if (process.platform === 'linux') {
    const rssKb = Number(/VmRSS:s+(d+)/.exec(readFileSync(`/proc/${server.pid}/status`, 'utf8'))?.[1]) || 0;
    if (rssKb) check(rssKb / 1024 <= 450, `memory after boot ${Math.round(rssKb / 1024)} MB (budget 450 MB)`);
  }

  const stopAt = Date.now();
  server.kill('SIGTERM');
  const { code, signal } = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 35_000))]);
  check(code === 0 || signal === 'SIGTERM', `stops cleanly on SIGTERM in ${((Date.now() - stopAt) / 1000).toFixed(1)} s (exit ${code ?? signal})`);
} catch (err) {
  check(false, `smoke test aborted: ${err.message}`);
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}

const text = `## Release gate: production start\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`;
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
if (failures.length) {
  console.error(`server output (last lines):\n${output.split('\n').slice(-40).join('\n')}`);
  process.exit(1);
}
process.exit(0);

