// Dubly's fixed public address (https://dubly.<account>.workers.dev) for a PC with no domain of its own. Every request is passed,
// unchanged and streamed, to the PC's current tunnel address, which deploy/local-prod/run.ps1 keeps in KV (key "origin") whenever the
// tunnel starts. The visitor's IP goes along in X-Dubly-Client-IP with a shared secret, so the app's per-address limits still apply
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

export default {
  async fetch(request, env) {
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
