import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './httpError';

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// Loopback, private, link-local (incl. the 169.254.169.254 metadata server), CGNAT, multicast and reserved ranges are refused.
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    return !BLOCKED_V4.some(([base, bits]) => (value >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return false;
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast, 2001:db8::/32 documentation, 64:ff9b::/96 NAT64.
    return !/^(f[cd]|fe[89ab]|ff|2001:0?db8:|64:ff9b:)/.test(lower);
  }
  return false;
}

// Allows only https to an allow-listed host with no credentials or odd port, resolving only to public addresses (stops DNS pointed inward).
export async function assertSafeDownloadUrl(rawUrl: string, allowedHosts: readonly string[], resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'INVALID_URL', 'That address is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'URL_NOT_ALLOWED', 'Only https downloads are allowed.');
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new HttpError(400, 'URL_NOT_ALLOWED', 'That address is not allowed.');
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || !allowedHosts.includes(host)) {
    throw new HttpError(400, 'URL_NOT_ALLOWED', 'That address is not allowed.');
  }
  const addresses = await resolve(host).catch(() => []);
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new HttpError(400, 'URL_NOT_ALLOWED', 'That address is not allowed.');
  }
  return url;
}

// Streams a download to disk with a byte cap and deadline, refusing redirects; a partial file is removed on failure.
export async function streamToFile(
  url: URL | string,
  destPath: string,
  limits: { maxBytes: number; timeoutMs: number }
): Promise<{ bytes: number }> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'error', signal: controller.signal });
    } catch {
      throw new HttpError(502, 'DOWNLOAD_FAILED', controller.signal.aborted ? 'The download timed out.' : 'The file could not be downloaded.');
    }
    if (!res.ok || !res.body) throw new HttpError(502, 'DOWNLOAD_FAILED', `The file could not be downloaded (HTTP ${res.status}).`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large.');
    }

    const out = createWriteStream(destPath);
    let bytes = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limits.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large.');
        }
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'DOWNLOAD_FAILED', controller.signal.aborted ? 'The download timed out.' : 'The file could not be downloaded.');
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    return { bytes };
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
