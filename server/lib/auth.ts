import type { NextFunction, Request, Response } from 'express';
import { env } from './env';
import { resolveSession } from './accounts';
import { hit } from './rateLimit';
import { addLogContext } from './log';
import { rateRules } from './limits';
import { resolveMembership, WorkspaceAccessError, type WorkspaceRole } from './workspaces';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      uid?: string;
      email?: string;
      // Whether the person has proved they read this inbox (an email link); anything that acts on the address alone requires it.
      emailVerified?: boolean;
      sessionId?: string;
      sessionToken?: string;
      workspaceId?: string;
      workspaceRole?: WorkspaceRole;
    }
  }
}

export const SESSION_COOKIE = 'dubly_session';

// The session token from the httpOnly cookie the browser sends, or from `Authorization: Bearer` (scripts and tests).
export function sessionTokenOf(req: Request): { token: string; via: 'cookie' | 'bearer' } | null {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return { token: header.slice('Bearer '.length).trim(), via: 'bearer' };
  const value = readCookie(req, SESSION_COOKIE);
  return value ? { token: value, via: 'cookie' } : null;
}

// One cookie's value from the request, or null.
export function readCookie(req: Request, name: string): string | null {
  const cookies = req.headers.cookie;
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim()) || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// A proxy that ends TLS hides HTTPS from req.secure unless TRUST_PROXY is set, so a site whose public address is https is always Secure.
export function cookieIsSecure(req: Request): boolean {
  return env.cookieSecure === 'always' || (env.cookieSecure === 'auto' && (req.secure || env.webOrigin.startsWith('https://')));
}

// httpOnly (no script can read it), SameSite=Strict (no other site's page can send it), Secure over HTTPS.
export function setSessionCookie(req: Request, res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: cookieIsSecure(req), path: '/', expires: expiresAt });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: cookieIsSecure(req), path: '/' });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery guard for cookie sessions, on top of SameSite=Strict: a request that changes something must come from
 * Dubly's own pages. Browsers say where a request came from (Sec-Fetch-Site, Origin); requests from other sites are refused.
 * Bearer-token calls are not affected, since a browser never attaches those by itself.
 */
export function isCrossSite(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return false;
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.origin !== new URL(env.webOrigin).origin && url.host !== req.get('host');
  } catch {
    return true;
  }
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (isCrossSite(req)) {
    res.status(403).json({ error: 'This request did not come from Dubly.', code: 'CROSS_SITE' });
    return;
  }
  next();
}

// Whether the request carries a live session of the account `uid`: whoever holds one signed in to it, so knew how to.
export async function holdsSessionOf(req: Request, uid: string): Promise<boolean> {
  const presented = sessionTokenOf(req);
  if (!presented) return false;
  const session = await resolveSession(presented.token);
  return session?.user._id === uid;
}

// Signs the caller in from their session; every request checks the session in the database, so a revoked one stops working at once.
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const presented = sessionTokenOf(req);
  if (!presented) {
    res.status(401).json({ error: 'You are not signed in.', code: 'UNAUTHENTICATED' });
    return;
  }
  if (presented.via === 'cookie' && isCrossSite(req)) {
    res.status(403).json({ error: 'This request did not come from Dubly.', code: 'CROSS_SITE' });
    return;
  }
  let session: Awaited<ReturnType<typeof resolveSession>>;
  try {
    session = await resolveSession(presented.token);
  } catch (err) {
    next(err);
    return;
  }
  if (!session) {
    if (presented.via === 'cookie') clearSessionCookie(req, res);
    res.status(401).json({ error: 'Your session has ended. Please sign in again.', code: 'UNAUTHENTICATED' });
    return;
  }
  req.uid = session.user._id;
  req.email = session.user.email;
  req.emailVerified = session.user.emailVerified;
  req.sessionId = session.sessionId;
  req.sessionToken = presented.token;
  addLogContext({ userId: req.uid });

  // A ceiling on any one account's request rate, far above what the UI's own polling needs.
  const retryAfter = hit(`api:user:${req.uid}`, rateRules.apiPerUser);
  if (retryAfter) {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED', retryAfterSeconds: retryAfter });
    return;
  }
  next();
}

// Resolves which workspace the caller works in and their role there; runs after requireAuth.
export async function requireWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const membership = await resolveMembership(req.uid!, { emailVerified: req.emailVerified === true });
    req.workspaceId = membership.workspaceId;
    addLogContext({ workspaceId: membership.workspaceId });
    req.workspaceRole = membership.role;
    next();
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      res.status(403).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// Admin-only actions: deleting projects and managing the team.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.workspaceRole !== 'admin') {
    res.status(403).json({ error: 'Only a workspace admin can do that.' });
    return;
  }
  next();
}
