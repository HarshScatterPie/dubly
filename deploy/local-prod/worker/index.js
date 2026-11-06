// Dubly's fixed public address (https://dubly.<account>.workers.dev) for a PC with no domain of its own. Every request is passed,
// unchanged and streamed, to the PC's current tunnel address, which deploy/local-prod/run.ps1 keeps in KV (key "origin") whenever the
// tunnel starts. The visitor's IP goes along in X-Dubly-Client-IP with a shared secret, so the app's per-address limits still apply
// per visitor. Nothing is cached or stored here.
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dubly is offline</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#0f172a">
<h1 style="font-size:1.25rem">Dubly is offline right now</h1><p>The computer that runs Dubly is switched off, asleep or restarting. Try again in a few minutes.</p></body>`;

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
