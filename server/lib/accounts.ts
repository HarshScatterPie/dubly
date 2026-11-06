import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { col, isDuplicateKeyError } from './mongo';

/**
 * Dubly's own accounts, all in MongoDB: users (scrypt password hashes), sessions and one-time email tokens.
 *
 * - A session token is 32 random bytes held only by the browser (an httpOnly cookie); the database keeps its SHA-256, so a
 *   leaked database or backup cannot be replayed as a sign-in. The same goes for reset and verification tokens.
 * - Sessions end after 30 days, or 7 days without use, and are deleted at once on sign-out, password change, password reset,
 *   "sign out everywhere", disabling or deleting the account; every request looks its session up, so that is immediate.
 */
export interface UserDoc {
  _id: string;
  email: string;
  emailVerified: boolean;
  passwordHash: string;
  passwordChangedAt: Date;
  disabled: boolean;
  // The name and picture chosen at sign-up or in Settings.
  displayName?: string;
  avatar?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: string;
  uid: string;
  createdAt: Date;
  lastSeenAt: Date;
  // The earlier of the absolute and the idle limit; MongoDB's TTL index removes the record after it.
  expiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent?: string;
  ip?: string;
}

export type AuthTokenPurpose = 'verify-email' | 'reset-password';

interface AuthTokenDoc {
  _id: string;
  uid: string;
  purpose: AuthTokenPurpose;
  // The address the link was sent to; a verification link is only good for the address the account still has.
  email: string;
  createdAt: Date;
  expiresAt: Date;
}

export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
// A session's last use is written at most this often, not on every request (the UI polls every second).
const SESSION_TOUCH_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  'verify-email': 24 * 60 * 60 * 1000,
  'reset-password': 30 * 60 * 1000,
};

const users = () => col<UserDoc>('users');
const sessions = () => col<SessionDoc>('sessions');
const authTokens = () => col<AuthTokenDoc>('authTokens');

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const normalizeEmail = (email: string) => String(email ?? '').trim().toLowerCase();
// local@label.label..., with each part bounded and domain labels that cannot contain the dot that separates them, so a match takes
// linear time whatever the input (the earlier pattern could backtrack quadratically on a long run of dots).
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/;
export const isEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email);

export class AccountError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

// --- Passwords --------------------------------------------------------------------------------------------------------------

// scrypt with N=2^15, r=8 (32 MiB, about 100 ms per hash): memory-hard, built into Node, and run on the libuv pool, off the main thread.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLength: 32 };
const scrypt = (password: string, salt: Buffer, keyLength: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keyLength, options, (err, key) => (err ? reject(err) : resolve(key))));
const scryptOptions = (N: number, r: number, p: number): ScryptOptions => ({ N, r, p, maxmem: 128 * N * r * 2 });

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export function passwordProblem(password: unknown, email?: string): string | null {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the password.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters for the password.`;
  if (!password.trim()) return 'The password cannot be only spaces.';
  if (email && password.trim().toLowerCase() === normalizeEmail(email)) return 'The password cannot be your email address.';
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keyLength, scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, scryptOptions(Number(n), Number(r), Number(p)));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Checked against when the email has no account, so a wrong email takes as long as a wrong password and reveals nothing.
let decoyHash: Promise<string> | null = null;
const decoy = () => (decoyHash ??= hashPassword(randomBytes(16).toString('hex')));

// --- Session and account cache -----------------------------------------------------------------------------------------------
//
// Every request looks up its session and account (the UI polls once a second while a dub runs), so both are kept in memory for a
// short while. Everything that ends a session or changes an account goes through this module on this one process and clears the
// entry at once, so a sign-out, password change, removal or disabling still takes effect on the very next request. Only edits made
// straight in the database (Compass) wait for the entry to age out.
export const SESSION_CACHE_MS = 30_000;
const CACHE_LIMIT = 10_000;
const sessionCache = new Map<string, { session: SessionDoc; at: number }>();
const accountCache = new Map<string, { user: Omit<UserDoc, 'passwordHash'> | null; at: number }>();

// Test seam, and for scripts that change accounts behind the app's back.
export function clearSessionCaches(): void {
  sessionCache.clear();
  accountCache.clear();
}

function forgetAccount(uid: string): void {
  accountCache.delete(uid);
}

function forgetSessionsOf(uid: string, keepSessionId?: string): void {
  for (const [id, entry] of sessionCache) if (entry.session.uid === uid && id !== keepSessionId) sessionCache.delete(id);
}

function remember<V>(cache: Map<string, { at: number } & V>, key: string, value: V): void {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { ...value, at: Date.now() });
}

async function cachedAccount(uid: string): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  const hit = accountCache.get(uid);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.user;
  const user = await getUser(uid);
  remember(accountCache, uid, { user });
  return user;
}

// --- Users ------------------------------------------------------------------------------------------------------------------

export interface PublicUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
}

export const toPublicUser = (user: Pick<UserDoc, '_id' | 'email' | 'emailVerified' | 'displayName'>): PublicUser => ({
  uid: user._id,
  email: user.email,
  emailVerified: user.emailVerified,
  displayName: user.displayName || null,
});

// Never includes the password hash.
const USER_PROJECTION = { passwordHash: 0 } as const;

export async function getUser(uid: string): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  return users().findOne({ _id: uid }, { projection: USER_PROJECTION });
}

export async function getUserByEmail(email: string): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  return users().findOne({ email: normalizeEmail(email) }, { projection: USER_PROJECTION });
}

export async function createUser(input: { email: string; password: string; displayName?: string; emailVerified?: boolean }): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new AccountError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const problem = passwordProblem(input.password, email);
  if (problem) throw new AccountError(400, 'WEAK_PASSWORD', problem);
  const now = new Date();
  const doc: UserDoc = {
    _id: `u-${randomUUID()}`,
    email,
    emailVerified: input.emailVerified === true,
    passwordHash: await hashPassword(input.password),
    passwordChangedAt: now,
    disabled: false,
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim().slice(0, 80) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await users().insertOne(doc);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new AccountError(409, 'EMAIL_EXISTS', 'This email already has an account.');
    throw err;
  }
  return toPublicUser(doc);
}

/** The account for an email and password, or null; the same time and the same answer whether the email or the password is wrong. */
export async function checkCredentials(email: string, password: string): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  const user = await users().findOne({ email: normalizeEmail(email) });
  if (typeof password !== 'string' || password.length > PASSWORD_MAX) return null;
  if (!user) {
    await verifyPassword(password, await decoy());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}

export async function setPassword(uid: string, password: string): Promise<void> {
  const user = await getUser(uid);
  if (!user) throw new AccountError(404, 'USER_NOT_FOUND', 'This account no longer exists.');
  const problem = passwordProblem(password, user.email);
  if (problem) throw new AccountError(400, 'WEAK_PASSWORD', problem);
  const now = new Date();
  await users().updateOne({ _id: uid }, { $set: { passwordHash: await hashPassword(password), passwordChangedAt: now, updatedAt: now } });
  forgetAccount(uid);
}

export async function updateUserProfile(uid: string, patch: { displayName?: string; avatar?: string | null }): Promise<void> {
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  const $unset: Record<string, ''> = {};
  if (patch.displayName !== undefined) $set.displayName = patch.displayName;
  if (patch.avatar !== undefined) {
    if (patch.avatar) $set.avatar = patch.avatar;
    else $unset.avatar = '';
  }
  await users().updateOne({ _id: uid }, { $set, ...(Object.keys($unset).length ? { $unset } : {}) });
  forgetAccount(uid);
}

export async function markEmailVerified(uid: string): Promise<void> {
  await users().updateOne({ _id: uid }, { $set: { emailVerified: true, updatedAt: new Date() } });
  forgetAccount(uid);
}

export async function setUserDisabled(uid: string, disabled: boolean): Promise<void> {
  await users().updateOne({ _id: uid }, { $set: { disabled, updatedAt: new Date() } });
  forgetAccount(uid);
  if (disabled) await revokeAllSessions(uid);
}

export async function deleteUser(uid: string): Promise<void> {
  await revokeAllSessions(uid);
  await authTokens().deleteMany({ uid });
  // Where they signed in from, and sign-in links still waiting, go with the account.
  await col('devices').deleteMany({ uid });
  await col('loginAttempts').deleteMany({ uid });
  await users().deleteOne({ _id: uid });
  forgetAccount(uid);
}

// --- Sessions ---------------------------------------------------------------------------------------------------------------

export async function createSession(uid: string, meta: { userAgent?: string; ip?: string } = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  const expiresAt = new Date(Math.min(absoluteExpiresAt.getTime(), now.getTime() + SESSION_IDLE_MS));
  await sessions().insertOne({
    _id: sha256(token),
    uid,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    absoluteExpiresAt,
    ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 300) } : {}),
    ...(meta.ip ? { ip: meta.ip } : {}),
  });
  return { token, expiresAt: absoluteExpiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: Omit<UserDoc, 'passwordHash'>;
}

/** The live session and its account for a token; null when unknown, expired, revoked, or the account is gone or disabled. */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const now = Date.now();
  const hit = sessionCache.get(id);
  let session = hit && now - hit.at < SESSION_CACHE_MS ? hit.session : null;
  if (!session) {
    // An unknown token is not remembered, so made-up tokens cannot fill the cache.
    session = await sessions().findOne({ _id: id });
    if (!session) return null;
    remember(sessionCache, id, { session });
  }
  if (session.expiresAt.getTime() <= now) {
    sessionCache.delete(id);
    return null;
  }
  const user = await cachedAccount(session.uid);
  if (!user || user.disabled) return null;
  // A session from before the latest password change is dead even if a deletion was missed.
  if (session.createdAt.getTime() < user.passwordChangedAt.getTime() - 1000) return null;
  if (now - session.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    const expiresAt = new Date(Math.min(session.absoluteExpiresAt.getTime(), now + SESSION_IDLE_MS));
    await sessions().updateOne({ _id: id }, { $set: { lastSeenAt: new Date(now), expiresAt } });
    remember(sessionCache, id, { session: { ...session, lastSeenAt: new Date(now), expiresAt } });
  }
  return { sessionId: id, user };
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  sessionCache.delete(sha256(token));
  await sessions().deleteOne({ _id: sha256(token) });
}

// Every session of the account; `keepSessionId` spares the one making the request (e.g. after changing the password).
export async function revokeAllSessions(uid: string, keepSessionId?: string): Promise<number> {
  forgetSessionsOf(uid, keepSessionId);
  const result = await sessions().deleteMany({ uid, ...(keepSessionId ? { _id: { $ne: keepSessionId } } : {}) });
  // A request that read a session while the delete ran must not put it back.
  forgetSessionsOf(uid, keepSessionId);
  return result.deletedCount;
}

// --- One-time email tokens --------------------------------------------------------------------------------------------------

// `ttlMs` overrides the usual life of the link, e.g. a longer one for accounts moved over from the old sign-in (scripts only).
export async function issueAuthToken(uid: string, email: string, purpose: AuthTokenPurpose, ttlMs = TOKEN_TTL_MS[purpose]): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  // Only the newest link of each kind works.
  await authTokens().deleteMany({ uid, purpose });
  await authTokens().insertOne({ _id: sha256(token), uid, purpose, email: normalizeEmail(email), createdAt: now, expiresAt: new Date(now.getTime() + ttlMs) });
  return token;
}

/** The account a token is for, without using it up (so a form can be checked before the link is spent); null when it would not work. */
export async function peekAuthToken(token: string, purpose: AuthTokenPurpose): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const doc = await authTokens().findOne({ _id: sha256(token), purpose });
  if (!doc || doc.expiresAt.getTime() <= Date.now()) return null;
  const user = await getUser(doc.uid);
  return user && !user.disabled && user.email === doc.email ? user : null;
}

/** Uses up a token: it works once, for its purpose, before it expires, and only while the account still has the address it went to. */
export async function consumeAuthToken(token: string, purpose: AuthTokenPurpose): Promise<Omit<UserDoc, 'passwordHash'> | null> {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const doc = await authTokens().findOneAndDelete({ _id: sha256(token), purpose });
  if (!doc || doc.expiresAt.getTime() <= Date.now()) return null;
  const user = await getUser(doc.uid);
  if (!user || user.disabled || user.email !== doc.email) return null;
  return user;
}
