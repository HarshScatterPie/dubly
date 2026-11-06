import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app';
import { col, mergeUpdate, mongoDb, withTransaction } from '../lib/mongo';
import { deleteProjectDocuments, insertPlan, loadProject, planProjectWrite } from '../lib/projectStorage';
import { updateStoredProject, type StoredProject } from '../lib/projectRepo';
import { checkCredentials, clearSessionCaches, createSession, createUser as createAccount } from '../lib/accounts';
import { resetMediaKeyForTests } from '../lib/mediaStore';
import { clearMembershipCache } from '../lib/workspaces';
import { resetLifecycleForTests } from '../lib/lifecycle';
import { clearRateLimits } from '../lib/rateLimit';
import { resetQueueForTests } from '../lib/dubQueue';
import { clearPlanCaches } from '../lib/plans';
import { clearUserCaches } from '../lib/projectRepo';

// Empties every collection of the test database between tests (indexes stay), plus the in-process caches that would remember wiped data.
export async function resetDatabase(): Promise<void> {
  const collections = await mongoDb().listCollections({}, { nameOnly: true }).toArray();
  for (const { name } of collections) {
    if (!name.startsWith('system.')) await mongoDb().collection(name).deleteMany({});
  }
  clearMembershipCache();
  resetLifecycleForTests();
  clearRateLimits();
  resetQueueForTests();
  clearPlanCaches();
  clearUserCaches();
  resetMediaKeyForTests();
  clearSessionCaches();
}

// The name the tests have always used for "start from a clean slate".
export const resetEmulators = resetDatabase;

export interface TestUser {
  uid: string;
  email: string;
  token: string;
}

// A real account and a real session for it, checked by the same requireAuth production uses (sent as a Bearer token).
export async function createUser(email: string, password = 'correct-horse-battery', emailVerified = true): Promise<TestUser> {
  const user = await createAccount({ email, password, emailVerified });
  return { uid: user.uid, email: user.email, token: (await createSession(user.uid)).token };
}

export async function signIn(email: string, password = 'correct-horse-battery'): Promise<string> {
  const user = await checkCredentials(email, password);
  if (!user) throw new Error(`Sign-in failed for ${email}`);
  return (await createSession(user._id)).token;
}

export interface TestApi {
  baseUrl: string;
  close: () => Promise<void>;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any; headers: Headers }>;
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
      return { status: res.status, body, headers: res.headers };
    },
  };
}

// --- Direct database access for test setup and assertions, through the same layout the app uses ---------------------------------

// Writes a whole project (metadata and lines) the way the app stores it, replacing any earlier one with that id.
export async function seedProject(workspaceId: string, project: Record<string, unknown> & { id: string }): Promise<void> {
  await withTransaction(async (session) => {
    await deleteProjectDocuments(workspaceId, project.id, session);
    await insertPlan(workspaceId, project.id, planProjectWrite(workspaceId, project.id, undefined, project as Partial<StoredProject>), session);
  });
}

// The project reassembled (metadata and lines), or null.
export const readProject = (workspaceId: string, projectId: string) => loadProject(workspaceId, projectId);
// A partial update through the app's own write path (nested fields merge, lines go to their own documents).
export const writeProject = (workspaceId: string, projectId: string, patch: Record<string, unknown>) => updateStoredProject(workspaceId, projectId, patch as Partial<StoredProject>);

type Doc = Record<string, any>;
export const usageOf = async (workspaceId: string): Promise<Doc | null> => col<Doc & { _id: string }>('usage').findOne({ _id: workspaceId });
export const minutesUsedIn = async (workspaceId: string): Promise<number> => ((await usageOf(workspaceId))?.minutesDubbed as number) ?? 0;
export const mergeUsage = (workspaceId: string, fields: Doc) => col<Doc & { _id: string }>('usage').updateOne({ _id: workspaceId }, mergeUpdate(fields), { upsert: true });
export const replaceUsage = (workspaceId: string, doc: Doc) => col<Doc & { _id: string }>('usage').replaceOne({ _id: workspaceId }, doc, { upsert: true });
export const patchJob = (jobId: string, fields: Doc) => col<Doc & { _id: string }>('jobs').updateOne({ _id: jobId }, mergeUpdate(fields));
export const countJobs = () => col('jobs').countDocuments();
export const planDoc = (planId: string) => col<Doc & { _id: string }>('plans').findOne({ _id: planId });
export const mergePlan = (planId: string, fields: Doc) => col<Doc & { _id: string }>('plans').updateOne({ _id: planId }, mergeUpdate(fields), { upsert: true });

export { col, mongoDb };
