import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
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

// The connection's own lookup. assertSafeDownloadUrl's check is a separate DNS answer, so a name re-pointed inward just after it is caught here.
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  defaultResolver(hostname).then(
    (addresses) => {
      if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
        callback(new Error(`${hostname} does not resolve to public addresses`), '', 0);
      } else if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    },
    (err: NodeJS.ErrnoException) => callback(err, '', 0)
  );
};

// A response of any status is returned, redirects included: nothing here follows one.
function request(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    // agent: false so a pooled connection, which would skip the lookup, is never reused.
    (url.protocol === 'https:' ? https : http).get(url, { agent: false, lookup: publicOnlyLookup, signal }, resolve).on('error', reject);
  });
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
  const failed = () => new HttpError(502, 'DOWNLOAD_FAILED', controller.signal.aborted ? 'The download timed out.' : 'The file could not be downloaded.');
  try {
    let res: IncomingMessage;
    try {
      res = await request(new URL(url), controller.signal);
    } catch {
      throw failed();
    }
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.destroy();
      throw new HttpError(502, 'DOWNLOAD_FAILED', `The file could not be downloaded (HTTP ${status}).`);
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      res.destroy();
      throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large.');
    }

    let bytes = 0;
    try {
      await pipeline(
        res,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > limits.maxBytes) throw new HttpError(413, 'FILE_TOO_LARGE', 'That file is too large.');
            yield chunk;
          }
        },
        createWriteStream(destPath)
      );
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw failed();
    }
    return { bytes };
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
