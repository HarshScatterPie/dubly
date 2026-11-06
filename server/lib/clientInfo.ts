import type { Request } from 'express';
import { clientIp, fromTrustedEdge } from './rateLimit';

/**
 * Who is on the other end of a request, in words a person recognises: their device ("Chrome on Windows"), address and rough
 * location. Location comes only from Dubly's own Cloudflare front door (deploy/local-prod/worker), which looks it up from the
 * visitor's address; without the front door's secret the header is ignored, so nobody can claim a location of their choosing.
 */
export interface ClientInfo {
  ip: string | null;
  device: string;
  location: string | null;
  userAgent: string;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export function clientGeo(req: Request): string | null {
  const raw = req.get('x-dubly-client-geo');
  if (!raw || !fromTrustedEdge(req)) return null;
  try {
    const geo = JSON.parse(decodeURIComponent(raw)) as { city?: string; region?: string; country?: string };
    let country = geo.country;
    try {
      if (country && /^[A-Z]{2}$/.test(country)) country = regionNames.of(country) ?? country;
    } catch {
      // An unknown code stays as it is.
    }
    const parts = [geo.city, geo.region, country].filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim().slice(0, 60));
    return parts.length ? [...new Set(parts)].join(', ') : null;
  } catch {
    return null;
  }
}

// A short, human description of a browser's User-Agent; good enough to recognise one's own device, never used to decide anything.
export function describeDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /CrOS/.test(ua)
              ? 'ChromeOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || 'An unknown device';
}

export function clientInfo(req: Request): ClientInfo {
  const userAgent = (req.get('user-agent') ?? '').slice(0, 300);
  return { ip: clientIp(req), device: describeDevice(userAgent), location: clientGeo(req), userAgent };
}
