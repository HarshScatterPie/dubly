import type { NextFunction, Request, Response } from 'express';
import { authAdmin } from './firebaseAdmin';
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
      workspaceId?: string;
      workspaceRole?: WorkspaceRole;
    }
  }
}

// How long a user's disabled/revoked state is trusted before Auth is asked again; bounds how long a revoked session lingers.
export const ACCOUNT_STATE_CACHE_MS = 30_000;
const accountState = new Map<string, { disabled: boolean; validSinceMs: number; at: number }>();

export function clearAccountStateCache(uid?: string): void {
  if (uid) accountState.delete(uid);
  else accountState.clear();
}

// verifyIdToken(token, true)'s checks (disabled, revoked since issue), cached per user briefly because the UI polls every second.
async function isSessionRevoked(uid: string, authTimeSeconds: number): Promise<boolean> {
  let state = accountState.get(uid);
  if (!state || Date.now() - state.at > ACCOUNT_STATE_CACHE_MS) {
    const user = await authAdmin.getUser(uid);
    state = {
      disabled: user.disabled,
      validSinceMs: user.tokensValidAfterTime ? new Date(user.tokensValidAfterTime).getTime() : 0,
      at: Date.now(),
    };
    accountState.set(uid, state);
  }
  return state.disabled || authTimeSeconds * 1000 < state.validSinceMs;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ error: 'Missing Authorization bearer token' });
    return;
  }

  try {
    const decoded = await authAdmin.verifyIdToken(token);
    // A deleted account makes getUser throw, which lands in the same 401 below.
    if (await isSessionRevoked(decoded.uid, decoded.auth_time)) throw new Error('revoked');
    req.uid = decoded.uid;
    req.email = decoded.email;
    addLogContext({ userId: decoded.uid });
  } catch {
    res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    return;
  }
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
    const membership = await resolveMembership(req.uid!);
    req.workspaceId = membership.workspaceId;
    addLogContext({ workspaceId: membership.workspaceId });
    req.workspaceRole = membership.role;
    next();
  } catch (err) {
    if (err instanceof WorkspaceAccessError) {
      res.status(403).json({ error: err.message, code: 'NO_WORKSPACE' });
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
