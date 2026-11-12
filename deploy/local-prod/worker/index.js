// Dubly's fixed public address (https://dubly.<account>.workers.dev) for a machine with no domain of its own. Every request is passed,
// unchanged and streamed, to the current tunnel address, kept in KV (key "origin"). The Docker container sets it itself whenever it opens
// a tunnel (deploy/docker/front-door.mjs, through POST /__dubly/origin below); the older PC launcher (deploy/local-prod/run.ps1) writes
// KV with wrangler. The visitor's IP goes along in X-Dubly-Client-IP with a shared secret, so the app's per-address limits still apply
// per visitor. Nothing is cached or stored here.
// The Dubly mark (public/dubly-mark.svg), inline: when the PC is off, nothing can be fetched from it.
const MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="14.4" fill="#F05637"/><g transform="translate(12 12)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></g></svg>';
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dubly is offline</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(MARK)}"><meta name="theme-color" content="#F05637">
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0f172a;text-align:center">
<div style="width:56px;height:56px;margin:0 auto 18px;filter:drop-shadow(0 8px 16px rgba(240,86,55,.35))">${MARK}</div>
<h1 style="font-size:1.25rem;margin:0 0 8px">Dubly is offline right now</h1><p style="color:#475569;line-height:1.5">The computer that runs Dubly is switched off, asleep or restarting. Try again in a few minutes.</p></body>`;

function offline(status) {
  return new Response(OFFLINE, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' } });
}

const REGISTER_PATH = '/__dubly/origin';
// Only a Cloudflare quick tunnel can become the origin, so even the holder of the secret cannot send visitors anywhere else.
const QUICK_TUNNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

const plain = (status, text) => new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

// The container's tunnel reporting its new address, with the secret the Worker and the app already share. The address must answer
// /api/healthz with 200 (Dubly, with its database up) before it replaces the current one; KV is written only when it changes.
async function register(request, env) {
  if (!sameSecret(request.headers.get('X-Dubly-Edge-Secret'), env.EDGE_SECRET)) return plain(403, 'forbidden');
  let origin;
  try {
    origin = String((await request.json()).origin || '').replace(/\/+$/, '');
  } catch {
    return plain(400, 'expected {"origin": "https://<name>.trycloudflare.com"}');
  }
  if (!QUICK_TUNNEL.test(origin)) return plain(400, 'origin must be https://<name>.trycloudflare.com');
  try {
    const probe = await fetch(new URL('/api/healthz', origin), { redirect: 'manual' });
    if (probe.status !== 200) return plain(502, `${origin}/api/healthz answered ${probe.status}`);
  } catch (err) {
    return plain(502, `${origin} is not reachable yet: ${err}`);
  }
  const current = await env.DUBLY.get('origin');
  if (current !== origin) await env.DUBLY.put('origin', origin);
  return Response.json({ origin, changed: current !== origin }, { headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'POST' && new URL(request.url).pathname === REGISTER_PATH) return register(request, env);
    const origin = await env.DUBLY.get('origin', { cacheTtl: 60 });
    if (!origin) return offline(503);
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, origin);

    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.set('X-Dubly-Client-IP', request.headers.get('CF-Connecting-IP') || '');
    // Rough location from Cloudflare (city, region, country), shown in "new sign-in" emails; trusted only with the secret below.
    const cf = request.cf || {};
    headers.set('X-Dubly-Client-Geo', encodeURIComponent(JSON.stringify({ city: cf.city, region: cf.region, country: cf.country })));
    headers.set('X-Dubly-Edge-Secret', env.EDGE_SECRET);
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Forwarded-Host', url.host);

    let response;
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch {
      return offline(502);
    }
    // 530: Cloudflare could not reach the tunnel (the PC is off, or its tunnel address is about to change).
    if (response.status === 530) return offline(502);
    return response;
  },
};
