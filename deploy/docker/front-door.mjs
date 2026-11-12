#!/usr/bin/env node
// Puts the container behind Dubly's fixed public address, the Cloudflare Worker at FRONT_DOOR_URL (deploy/local-prod/worker), with no
// domain and no Cloudflare login. entrypoint.sh starts it when FRONT_DOOR_URL is set. It:
//   1. opens a Cloudflare quick tunnel to the app (cloudflared),
//   2. tells the Worker the tunnel's address (POST /__dubly/origin, with the EDGE_SHARED_SECRET the Worker and the app already share);
//      the Worker accepts it only once the address answers as Dubly,
//   3. checks the public address every minute, and opens a new tunnel when it stops answering while the app itself is fine. A quick
//      tunnel can vanish on Cloudflare's side while cloudflared keeps running ("Tunnel not found"); that is what took the PC's
//      front door down on 2026-11-12.
// It repeats the registration every few minutes, so whatever else wrote the Worker's address is corrected.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const FRONT_DOOR = (process.env.FRONT_DOOR_URL || '').replace(/\/+$/, '');
const SECRET = process.env.EDGE_SHARED_SECRET || '';
const LOCAL = `http://127.0.0.1:${Number(process.env.PORT) || 8787}`;
const CHECK_EVERY_MS = 60_000;
const REGISTER_EVERY_MS = 5 * 60_000;
const FAILED_CHECKS_BEFORE_NEW_TUNNEL = 3;

const log = (severity, message, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), severity, message, event: 'front_door', ...fields })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;
let current = null;

process.on('SIGTERM', () => {
  stopping = true;
  current?.child.kill('SIGTERM');
  process.exit(0);
});

// cloudflared (Go) trusts only the system bundle; on a network that inspects TLS it needs the same extra root the app gets.
function cloudflaredEnv() {
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  if (!extra || !existsSync(extra) || readFileSync(extra).length === 0) return process.env;
  const bundle = '/tmp/front-door-ca.pem';
  writeFileSync(bundle, `${readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')}\n${readFileSync(extra, 'utf8')}`);
  return { ...process.env, SSL_CERT_FILE: bundle };
}

async function healthy(base) {
  try {
    const res = await fetch(`${base}/api/healthz`, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    return res.status === 200;
  } catch {
    return false;
  }
}

// Starts cloudflared and resolves once it prints its address (or gives up after a minute).
function openTunnel() {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', LOCAL], { env: cloudflaredEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const tunnel = { child, url: null, lost: false, exited: false, lastError: '' };
  return new Promise((resolve) => {
    let pending = '';
    const onData = (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const found = line.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
        if (found && !tunnel.url) {
          tunnel.url = found[0];
          resolve(tunnel);
        }
        if (/Tunnel not found|Unauthorized/i.test(line)) tunnel.lost = true;
        if (/\bERR\b|"level":"error"/.test(line)) tunnel.lastError = line.slice(0, 300);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => {
      tunnel.exited = true;
      tunnel.lastError = err.message;
      resolve(tunnel);
    });
    child.once('exit', (code, signal) => {
      tunnel.exited = true;
      if (!tunnel.lastError) tunnel.lastError = `cloudflared exited (${signal ?? code})`;
      resolve(tunnel);
    });
    setTimeout(() => resolve(tunnel), 60_000);
  });
}

function closeTunnel(tunnel) {
  if (tunnel.exited) return Promise.resolve();
  return new Promise((resolve) => {
    tunnel.child.once('exit', resolve);
    tunnel.child.kill('SIGTERM');
    setTimeout(() => {
      tunnel.child.kill('SIGKILL');
      resolve();
    }, 10_000);
  });
}

async function register(url) {
  const res = await fetch(`${FRONT_DOOR}/__dubly/origin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dubly-Edge-Secret': SECRET },
    body: JSON.stringify({ origin: url }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`the front door answered ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Sleeps up to `ms`, waking early when the tunnel dies or the container stops.
async function watchFor(ms, tunnel) {
  const until = Date.now() + ms;
  while (Date.now() < until && !tunnel.exited && !tunnel.lost && !stopping) await sleep(Math.min(5_000, until - Date.now()));
}

async function serveOnce() {
  // The Worker only accepts an address that answers as Dubly, so wait for the app first.
  while (!(await healthy(LOCAL))) await sleep(5_000);
  const tunnel = (current = await openTunnel());
  try {
    if (!tunnel.url) {
      log('ERROR', `cloudflared gave no address: ${tunnel.lastError || 'nothing printed within a minute'}`);
      return;
    }
    log('INFO', `tunnel open at ${tunnel.url}`);
    // A new quick tunnel takes a few seconds to become reachable, so the first tries may be refused.
    let lastError = null;
    for (let attempt = 1; attempt <= 30 && !tunnel.exited && !tunnel.lost && !stopping; attempt++) {
      try {
        const result = await register(tunnel.url);
        log('INFO', `${FRONT_DOOR} now forwards to ${tunnel.url}${result.changed ? ' (live within a minute)' : ''}`);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await sleep(10_000);
      }
    }
    if (lastError) {
      log('ERROR', `the front door did not take the new address: ${lastError.message}`);
      return;
    }
    let failures = 0;
    let registeredAt = Date.now();
    while (!stopping) {
      await watchFor(CHECK_EVERY_MS, tunnel);
      if (tunnel.exited || tunnel.lost) {
        log('WARNING', `the tunnel is gone (${tunnel.lost ? 'Cloudflare no longer knows it' : tunnel.lastError}); opening a new one`);
        return;
      }
      if (Date.now() - registeredAt >= REGISTER_EVERY_MS) {
        try {
          const result = await register(tunnel.url);
          registeredAt = Date.now();
          if (result.changed) log('WARNING', `the front door pointed elsewhere; it forwards to ${tunnel.url} again`);
        } catch (err) {
          log('WARNING', `re-registering with the front door failed: ${err.message}`);
        }
      }
      if (await healthy(FRONT_DOOR)) {
        failures = 0;
        continue;
      }
      // The app itself is restarting or its database is down: a new tunnel would not help.
      if (!(await healthy(LOCAL))) {
        failures = 0;
        continue;
      }
      failures += 1;
      log('WARNING', `${FRONT_DOOR} did not answer (${failures} of ${FAILED_CHECKS_BEFORE_NEW_TUNNEL})`);
      if (failures >= FAILED_CHECKS_BEFORE_NEW_TUNNEL) {
        log('WARNING', 'the public address stopped answering; opening a new tunnel');
        return;
      }
    }
  } finally {
    await closeTunnel(tunnel);
    current = null;
  }
}

if (!FRONT_DOOR || !SECRET) {
  log('ERROR', 'the front door is off: FRONT_DOOR_URL and EDGE_SHARED_SECRET must both be set');
  process.exit(0);
}
// A short pause between tunnels, growing to a minute while they keep failing quickly; one that lasted resets it.
let quickFailures = 0;
while (!stopping) {
  const startedAt = Date.now();
  try {
    await serveOnce();
  } catch (err) {
    log('ERROR', `front door: ${err?.message || err}`);
  }
  if (stopping) break;
  quickFailures = Date.now() - startedAt > 10 * 60_000 ? 0 : quickFailures + 1;
  await sleep(Math.min(60_000, 5_000 * 2 ** Math.min(quickFailures, 4)));
}
