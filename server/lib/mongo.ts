import { MongoClient, MongoServerError, type ClientSession, type Collection, type Db, type Document, type IndexDescription } from 'mongodb';
import { env } from './env';

/**
 * The one MongoDB connection the whole process shares. Every record (accounts, sessions, workspaces, projects, jobs, shares)
 * and every stored file (GridFS, see mediaStore.ts) lives in this database; nothing else holds application data.
 *
 * The server must be a replica set (a single-node one is fine): multi-document transactions, which the job, billing and
 * invitation logic depend on, only exist there. `connectMongo` refuses to start otherwise, with the fix in the message.
 */
const client = new MongoClient(env.mongodbUri, {
  appName: 'dubly',
  // A partial update may legitimately carry `undefined` (e.g. clearing a message); it is left out instead of being stored as null.
  ignoreUndefined: true,
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 10_000,
  retryWrites: true,
  retryReads: true,
  writeConcern: { w: 'majority' },
});

let database: Db = client.db(env.mongodbDb);

export function mongoClient(): MongoClient {
  return client;
}

export function mongoDb(): Db {
  return database;
}

// Test seam: points the process at another database (each test run gets a fresh one).
export function useDatabase(name: string): void {
  database = client.db(name);
}

export function col<T extends Document>(name: CollectionName): Collection<T> {
  return database.collection<T>(name);
}

// Every collection the app uses, in one place, so a typo cannot silently create a new one.
export const COLLECTIONS = [
  'users',
  'sessions',
  'authTokens',
  'loginAttempts',
  'devices',
  'userSettings',
  'workspaces',
  'members',
  'memberships',
  'plans',
  'usage',
  'glossaries',
  'projects',
  'projectSegments',
  'jobs',
  'jobIdempotency',
  'invites',
  'shares',
  'quotaRequests',
  'system',
  'rateLimits',
  'leases',
  'cacheEvents',
  'dubAdmission',
  'uploadSessions',
  'captionFailures',
  // Each AI model's queue of turns and quota pause (aiPacing.ts), and each server process's heartbeat (instances.ts).
  'aiPace',
  'instances',
] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

const INDEXES: Partial<Record<CollectionName, IndexDescription[]>> = {
  users: [{ key: { email: 1 }, unique: true, name: 'email_unique' }],
  // Expired sessions and one-time tokens are removed by MongoDB itself (TTL), on top of the expiry check every read makes.
  sessions: [
    { key: { uid: 1 }, name: 'uid' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
  ],
  authTokens: [
    { key: { uid: 1, purpose: 1 }, name: 'uid_purpose' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
  ],
  // Email-link sign-ins: found by the link's hash, gone 15 minutes after they were asked for.
  loginAttempts: [
    { key: { linkHash: 1 }, unique: true, name: 'link' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
  ],
  // Devices each account has signed in from, for "new sign-in" emails; forgotten after two years unused, as their cookie is.
  devices: [
    { key: { uid: 1 }, name: 'uid' },
    { key: { lastSeenAt: 1 }, expireAfterSeconds: 2 * 365 * 24 * 60 * 60, name: 'unused_ttl' },
  ],
  members: [
    { key: { workspaceId: 1, uid: 1 }, unique: true, name: 'workspace_uid' },
    { key: { workspaceId: 1, role: 1 }, name: 'workspace_role' },
    { key: { workspaceId: 1, email: 1 }, name: 'workspace_email' },
    { key: { uid: 1 }, name: 'uid' },
  ],
  projects: [{ key: { workspaceId: 1, createdAt: -1 }, name: 'workspace_created' }],
  projectSegments: [{ key: { projectId: 1 }, name: 'project' }],
  jobs: [
    { key: { settled: 1 }, name: 'settled' },
    { key: { finishedAt: 1 }, name: 'finished' },
    // The dub queue: oldest waiting first, and what a workspace has running.
    { key: { type: 1, status: 1, createdAt: 1 }, name: 'queue' },
    { key: { workspaceId: 1, type: 1, status: 1 }, name: 'workspace_running' },
  ],
  jobIdempotency: [{ key: { createdAt: 1 }, name: 'created' }],
  invites: [
    { key: { workspaceId: 1, invitedEmail: 1, status: 1 }, name: 'workspace_email_status' },
    { key: { invitedEmail: 1, status: 1 }, name: 'email_status' },
    { key: { expiresAt: 1 }, name: 'expires' },
  ],
  shares: [
    { key: { projectId: 1 }, name: 'project' },
    { key: { expiresAt: 1 }, name: 'expires' },
  ],
  quotaRequests: [{ key: { workspaceId: 1, createdAt: -1 }, name: 'workspace_created' }],
  // Shared counters and claims clean themselves up; nothing here outlives its window by more than TTL's own lag.
  rateLimits: [{ key: { expireAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }],
  leases: [{ key: { expireAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }],
  cacheEvents: [{ key: { at: 1 }, expireAfterSeconds: 60 * 60, name: 'ttl' }],
  uploadSessions: [{ key: { expiresAt: 1 }, name: 'expires' }],
  captionFailures: [{ key: { expireAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }],
  // A server process's heartbeat (instances.ts); one that stopped without saying so expires by itself.
  instances: [{ key: { expireAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }],
};

export async function ensureIndexes(): Promise<void> {
  for (const [name, indexes] of Object.entries(INDEXES)) {
    if (indexes?.length) await database.collection(name).createIndexes(indexes);
  }
}

let connecting: Promise<void> | null = null;

// Connects, checks the server can run transactions, and creates the indexes. Safe to call more than once.
export function connectMongo(): Promise<void> {
  connecting ??= (async () => {
    await client.connect();
    const hello = await database.admin().command({ hello: 1 });
    if (!hello.setName) {
      throw new Error(
        'MongoDB is running as a standalone server, but Dubly needs a replica set for transactions. ' +
          'Add "replication: { replSetName: rs0 }" to mongod.cfg (or start mongod with --replSet rs0), restart it, then run ' +
          'mongosh --eval "rs.initiate()" once. See docs/MONGODB.md.'
      );
    }
    await ensureIndexes();
  })().catch((err) => {
    connecting = null;
    throw err;
  });
  return connecting;
}

export async function closeMongo(): Promise<void> {
  connecting = null;
  await client.close();
}

// Whether the database answers right now; used by the health check.
export async function pingMongo(): Promise<boolean> {
  try {
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn` as one ACID transaction (snapshot reads, majority-committed writes). The driver retries the whole callback on
 * transient errors and write conflicts, so `fn` must be safe to run again: read everything through `session`, and keep side
 * effects outside it. Operations on one session must not run in parallel, so callers await them one after another.
 * An error `fn` throws on purpose aborts the transaction and comes back out unchanged.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }
    );
    return result as T;
  } finally {
    await session.endSession();
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/** Placed as a value in a merge patch, removes that field (the counterpart of `$unset`). */
export const DELETE_FIELD: unique symbol = Symbol('dubly.deleteField');
export type DeleteField = typeof DELETE_FIELD;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A key that can be part of a dotted update path; any other key keeps its whole object as one value.
const pathSafe = (key: string) => key.length > 0 && !key.includes('.') && !key.startsWith('$');

/**
 * Turns a nested patch into a `$set`/`$unset` update that changes only the fields it names, at any depth, the way a merge write
 * should: `{ languageOutputs: { hi: { status: 'completed' } } }` sets that one field and leaves the other languages alone. Arrays,
 * dates and empty objects are written whole; `undefined` is skipped; `DELETE_FIELD` removes the field.
 */
export function mergeUpdate(patch: Record<string, unknown>): { $set?: Document; $unset?: Document } {
  const $set: Document = {};
  const $unset: Document = {};
  const walk = (value: Record<string, unknown>, prefix: string) => {
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if (v === DELETE_FIELD) $unset[path] = '';
      else if (isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every(pathSafe)) walk(v, path);
      else $set[path] = stripDeletes(v);
    }
  };
  const safe = Object.keys(patch).every(pathSafe);
  if (!safe) throw new Error('A patch key may not contain "." or start with "$"');
  walk(patch, '');
  return { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) };
}

// Inside a value written whole, a DELETE_FIELD simply means "not there".
function stripDeletes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDeletes);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== DELETE_FIELD && v !== undefined).map(([k, v]) => [k, stripDeletes(v)]));
}

/** The document as the app sees it: without MongoDB's own `_id`. */
export function withoutId<T extends { _id?: unknown }>(doc: T): Omit<T, '_id'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...rest } = doc;
  return rest;
}
