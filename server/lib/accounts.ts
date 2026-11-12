import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { sharedInvalidator } from './cacheBus';
import { guessableReason } from './commonPasswords';
import { log } from './log';
import { col, isDuplicateKeyError } from './mongo';

/**
 * Dubly's own accounts, all in MongoDB: users (scrypt password hashes), sessions and one-time email tokens.
 *
 * - A session token is 32 random bytes held only by the browser (an httpOnly cookie); the database keeps its SHA-256, so a
 *   leaked database or backup cannot be replayed as a sign-in. The same goes for reset and verification tokens.
 * - Sessions end after 30 days, or 7 days without use, and are deleted at once on sign-out, password change, password reset,
 *   "sign out everywhere", disabling or deleting the account; every request looks its session up, so that is immediate.
 * - Until an account's email is confirmed, anyone could have set it up (typed someone else's address at sign-up, or used an
 *   invitation link the inviting admin also holds). So the first time the inbox is proven (confirmInbox), every session ends and a
 *   password set before then is dropped, unless the proof itself shows the same person set it.
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
  // A sign-up's confirmation link: the hash of the password chosen at that sign-up, which takes effect only when the link is used.
  passwordHash?: string;
  createdAt: Date;
  expiresAt: Date;
}

export type Account = Omit<UserDoc, 'passwordHash'>;

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

// scrypt with N=2^16, r=8 (64 MiB, about 140 ms per hash on the production laptop): memory-hard, built into Node, and run on the
// libuv pool, off the main thread. Each hash records its own cost, so one made at an earlier, lower cost still verifies, and is made
// again at this cost the next time its owner signs in.
const SCRYPT = { N: 1 << 16, r: 8, p: 1, keyLength: 32 };
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
  return guessableReason(password, email);
}

// The stored hash of an account with no password: it signs in by emailed link until its owner chooses one. Nothing verifies against it.
export const NO_PASSWORD = '';

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const [scheme, n, r, p, saltB64, keyB64] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return null;
  return { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(saltB64, 'base64'), key: Buffer.from(keyB64, 'base64') };
}

export const hasPassword = (stored: string) => parseHash(stored) !== null;
const isCurrentCost = (stored: string) => {
  const hash = parseHash(stored);
  return hash !== null && hash.N === SCRYPT.N && hash.r === SCRYPT.r && hash.p === SCRYPT.p;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keyLength, scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p));
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const hash = parseHash(stored);
  if (!hash) return false;
  const actual = await scrypt(password.normalize('NFKC'), hash.salt, hash.key.length, scryptOptions(hash.N, hash.r, hash.p));
  return actual.length === hash.key.length && timingSafeEqual(actual, hash.key);
}

// After a wrong password against a hash made at a lower cost, the work it is short of, so an account not yet made again at today's
// cost answers in the same time as any other account, and as an email with no account.
async function padToCurrentCost(stored: string): Promise<void> {
  const hash = parseHash(stored);
  if (!hash || !(hash.N > 1) || hash.N >= SCRYPT.N) return;
  const rounds = Math.min(15, Math.round(SCRYPT.N / hash.N) - 1);
  for (let i = 0; i < rounds; i++) await scrypt(randomBytes(16).toString('hex'), randomBytes(16), SCRYPT.keyLength, scryptOptions(hash.N, hash.r, hash.p));
}

// Made again at today's cost once the right password is known, after the answer; only if the hash is still the one just checked,
// so a password changed in the meantime is never overwritten.
function upgradeHash(uid: string, stored: string, password: string): void {
  setImmediate(() =>
    void hashPassword(password)
      .then((fresh) => users().updateOne({ _id: uid, passwordHash: stored }, { $set: { passwordHash: fresh } }))
      .catch((err) => log.error('password_rehash_failed', err, { userId: uid }))
  );
}

// Checked against when the email has no account, so a wrong email takes as long as a wrong password and reveals nothing.
let decoyHash: Promise<string> | null = null;
const decoy = () => (decoyHash ??= hashPassword(randomBytes(16).toString('hex')));

// --- Session and account cache -----------------------------------------------------------------------------------------------
//
// Every request looks up its session and account (the UI polls once a second while a dub runs), so both are kept in memory for a
// short while. Everything that ends a session or changes an account goes through this module, which clears the entry at once here
// and, through the cache bus, in every other process, so a sign-out, password change, removal or disabling takes effect on the next
// request here and within moments everywhere else. Only edits made straight in the database (Compass) wait for the entry to age out.
export const SESSION_CACHE_MS = 30_000;
const CACHE_LIMIT = 10_000;
const sessionCache = new Map<string, { session: SessionDoc; at: number }>();
const accountCache = new Map<string, { user: Omit<UserDoc, 'passwordHash'> | null; at: number }>();

// Test seam, and for scripts that change accounts behind the app's back.
export function clearSessionCaches(): void {
  sessionCache.clear();
  accountCache.clear();
}

const forgetAccount = sharedInvalidator('account', (uid) => (uid === null ? accountCache.clear() : void accountCache.delete(uid)));

const forgetSession = sharedInvalidator('session', (id) => (id === null ? sessionCache.clear() : void sessionCache.delete(id)));

const forgetSessionsMatching = sharedInvalidator('sessions-of', (key) => {
  if (key === null) return sessionCache.clear();
  const [uid, keepSessionId] = key.split(' ');
  for (const [id, entry] of sessionCache) if (entry.session.uid === uid && id !== keepSessionId) sessionCache.delete(id);
});

function forgetSessionsOf(uid: string, keepSessionId = ''): void {
  forgetSessionsMatching(`${uid} ${keepSessionId}`);
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

// `password: null` makes an account with no password yet: a sign-up, whose password comes with its confirmation link (issueAuthToken).
export async function createUser(input: { email: string; password: string | null; displayName?: string; emailVerified?: boolean }): Promise<PublicUser> {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new AccountError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const problem = input.password === null ? null : passwordProblem(input.password, email);
  if (problem) throw new AccountError(400, 'WEAK_PASSWORD', problem);
  const now = new Date();
  const doc: UserDoc = {
    _id: `u-${randomUUID()}`,
    email,
    emailVerified: input.emailVerified === true,
    passwordHash: input.password === null ? NO_PASSWORD : await hashPassword(input.password),
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

export type SignInCheck = { kind: 'ok'; user: Account } | { kind: 'unconfirmed'; user: Account } | { kind: 'wrong' };

// The password chosen at a sign-up still waiting for its confirmation link, if there is one.
async function pendingSignUpPassword(uid: string): Promise<string | null> {
  const doc = await authTokens().findOne(
    { uid, purpose: 'verify-email', passwordHash: { $exists: true }, expiresAt: { $gt: new Date() } },
    { projection: { passwordHash: 1 }, sort: { createdAt: -1 } }
  );
  return doc?.passwordHash ?? null;
}

/**
 * How `password` compares with the one chosen at the account's sign-up still waiting for its link ('none' when nothing is waiting, or
 * `uid` is null). One hash comparison whatever the case, against a decoy when nothing is waiting, so the time taken tells nothing.
 */
export async function compareWithPendingSignUp(uid: string | null, password: string): Promise<'none' | 'same' | 'different'> {
  const pending = uid ? await pendingSignUpPassword(uid) : null;
  const matches = await verifyPassword(password, pending ?? (await decoy()));
  return pending === null ? 'none' : matches ? 'same' : 'different';
}

/**
 * An email and password checked, with one hash comparison whatever the case, so the time taken tells nothing apart: an email with no
 * account is checked against a decoy, and an account with no password against the password of its sign-up still waiting for the
 * emailed link (a match answers 'unconfirmed') or else the decoy. 'wrong' is the same answer for a wrong email and a wrong password.
 */
export async function checkSignIn(email: string, password: string): Promise<SignInCheck> {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX) return { kind: 'wrong' };
  const user = await users().findOne({ email: normalizeEmail(email) });
  if (!user) {
    await verifyPassword(password, await decoy());
    return { kind: 'wrong' };
  }
  const { passwordHash, ...account } = user;
  if (!hasPassword(passwordHash)) {
    return (await compareWithPendingSignUp(user._id, password)) === 'same' ? { kind: 'unconfirmed', user: account } : { kind: 'wrong' };
  }
  if (!(await verifyPassword(password, passwordHash))) {
    await padToCurrentCost(passwordHash);
    return { kind: 'wrong' };
  }
  if (!isCurrentCost(passwordHash)) upgradeHash(user._id, passwordHash, password);
  return { kind: 'ok', user: account };
}

/** The account for an email and password, or null; the same time and the same answer whether the email or the password is wrong. */
export async function checkCredentials(email: string, password: string): Promise<Account | null> {
  const result = await checkSignIn(email, password);
  return result.kind === 'ok' ? result.user : null;
}

/** Whether the account has a password it can sign in with (one confirmed by email link may have none yet). */
export async function accountHasPassword(uid: string): Promise<boolean> {
  const user = await users().findOne({ _id: uid }, { projection: { passwordHash: 1 } });
  return user !== null && hasPassword(user.passwordHash);
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

/**
 * The person proved they read the account's inbox (they used a link or code sent to it). The first time, what was set up before
 * cannot be trusted, since anyone could have set it up: every session ends, and the password goes, unless this proof carries the one
 * chosen at the sign-up that sent the link (`passwordHash`), or comes from a browser already signed in to this account, which so knew
 * the password (`keepPassword`). Once confirmed, later proofs change nothing. `passwordless` says the account is left with no password.
 */
export async function confirmInbox(uid: string, proof: { passwordHash?: string; keepPassword?: boolean } = {}): Promise<{ first: boolean; passwordless: boolean }> {
  const now = new Date();
  const $set: Partial<UserDoc> = { emailVerified: true, updatedAt: now };
  if (proof.passwordHash) Object.assign($set, { passwordHash: proof.passwordHash, passwordChangedAt: now });
  else if (!proof.keepPassword) Object.assign($set, { passwordHash: NO_PASSWORD, passwordChangedAt: now });
  const before = await users().findOneAndUpdate({ _id: uid, emailVerified: false }, { $set }, { projection: { passwordHash: 1 } });
  forgetAccount(uid);
  if (!before) return { first: false, passwordless: false };
  await revokeAllSessions(uid);
  const passwordless = !proof.passwordHash && (!proof.keepPassword || !hasPassword(before.passwordHash));
  return { first: true, passwordless };
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
  await sessions().deleteOne({ _id: sha256(token) });
  // After the delete, so no process can read the session back in between.
  forgetSession(sha256(token));
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
// `passwordHash` goes with a sign-up's confirmation link: the password chosen there, set when (and only if) the link is used.
export async function issueAuthToken(
  uid: string,
  email: string,
  purpose: AuthTokenPurpose,
  ttlMs = TOKEN_TTL_MS[purpose],
  passwordHash?: string
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  // Only the newest link of each kind works.
  await authTokens().deleteMany({ uid, purpose });
  await authTokens().insertOne({
    _id: sha256(token),
    uid,
    purpose,
    email: normalizeEmail(email),
    ...(passwordHash ? { passwordHash } : {}),
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  });
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

/**
 * Uses up a token: it works once, for its purpose, before it expires, and only while the account still has the address it went to.
 * `passwordHash` is the password a sign-up's confirmation link carries, if any.
 */
export async function consumeAuthToken(token: string, purpose: AuthTokenPurpose): Promise<{ user: Account; passwordHash?: string } | null> {
  if (typeof token !== 'string' || !token || token.length > 100) return null;
  const doc = await authTokens().findOneAndDelete({ _id: sha256(token), purpose });
  if (!doc || doc.expiresAt.getTime() <= Date.now()) return null;
  const user = await getUser(doc.uid);
  if (!user || user.disabled || user.email !== doc.email) return null;
  return { user, ...(doc.passwordHash ? { passwordHash: doc.passwordHash } : {}) };
}
