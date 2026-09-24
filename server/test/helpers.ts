import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app';
import { authAdmin, db } from '../lib/firebaseAdmin';
import { clearMembershipCache } from '../lib/workspaces';
import { clearAccountStateCache } from '../lib/auth';
import { resetLifecycleForTests } from '../lib/lifecycle';
import { clearRateLimits } from '../lib/rateLimit';
import { resetQueueForTests } from '../lib/dubQueue';

const projectId = () => process.env.GCLOUD_PROJECT || 'demo-dubly';

// Wipes Firestore and Auth in the emulator between tests, plus the in-process caches that would otherwise remember wiped data.
export async function resetEmulators(): Promise<void> {
  const fs = process.env.FIRESTORE_EMULATOR_HOST;
  const auth = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  await Promise.all([
    fetch(`http://${fs}/emulator/v1/projects/${projectId()}/databases/(default)/documents`, { method: 'DELETE' }),
    fetch(`http://${auth}/emulator/v1/projects/${projectId()}/accounts`, { method: 'DELETE' }),
  ]);
  clearMembershipCache();
  clearAccountStateCache();
  resetLifecycleForTests();
  clearRateLimits();
  resetQueueForTests();
}

export interface TestUser {
  uid: string;
  email: string;
  token: string;
}

// A real emulator account and a real ID token for it, verified by the same requireAuth production uses.
export async function createUser(email: string, password = 'correct-horse-battery'): Promise<TestUser> {
  const user = await authAdmin.createUser({ email, password });
  return { uid: user.uid, email, token: await signIn(email, password) };
}

export async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
  const res = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) }
  );
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`Emulator sign-in failed for ${email}`);
  return body.idToken;
}

export interface TestApi {
  baseUrl: string;
  close: () => Promise<void>;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any }>;
}

export async function startApi(): Promise<TestApi> {
  const app = createApp({ serveFrontend: false, logRequests: false });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    call: async (method, path, opts = {}) => {
      const headers: Record<string, string> = { ...(opts.headers || {}) };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${baseUrl}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
      const text = await res.text();
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        // Non-JSON responses (share pages) are returned as text.
      }
      return { status: res.status, body };
    },
  };
}

export { db, authAdmin };
