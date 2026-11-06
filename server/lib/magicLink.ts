import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { col } from './mongo';
import { getUser, getUserByEmail, normalizeEmail, sha256, type UserDoc } from './accounts';
import { cookieIsSecure, readCookie } from './auth';
import { clientInfo } from './clientInfo';

/**
 * Sign-in without a password, by email.
 *
 * 1. The person asks on device A. A gets an attempt id and a secret in an httpOnly cookie that ties the attempt to that browser;
 *    the email carries a one-time link.
 * 2. Opened in that same browser (the cookie comes along), the link signs A in.
 * 3. Opened anywhere else (a phone), the link signs nobody in: it shows a 6-digit code, which the person types on A. Only the
 *    browser holding the cookie can redeem the code, so the sign-in always lands on the device that asked; someone who asks for
 *    a link to another person's address gets nothing unless that person reads the code out to them. The code page says which
 *    device and place asked, to make that harder.
 *
 * Links work once, for 15 minutes; codes for 10 minutes and 5 tries. Links and codes are stored only as hashes. An address with no
 * account gets the same answers and simply never receives an email.
 */
export const ATTEMPT_COOKIE = 'dubly_magic';
export const LINK_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_TRIES = 5;

export interface RequestedFrom {
  device: string;
  location: string | null;
  ip: string | null;
  at: Date;
}

interface AttemptDoc {
  _id: string;
  uid: string | null;
  email: string;
  linkHash: string;
  browserHash: string;
  status: 'sent' | 'opened' | 'done';
  codeHash?: string;
  codeExpiresAt?: Date;
  codeTries: number;
  requestedFrom: RequestedFrom;
  createdAt: Date;
  expiresAt: Date;
}

const attempts = () => col<AttemptDoc>('loginAttempts');
type Account = Omit<UserDoc, 'passwordHash'>;

const codeHash = (attemptId: string, code: string) => sha256(`${attemptId}:${code}`);
function sameHash(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// The browser's own secret for its attempts; kept if it already has one, so asking twice still lets either link sign it in.
function browserSecret(req: Request, res: Response): string {
  const existing = readCookie(req, ATTEMPT_COOKIE);
  const secret = existing && /^[A-Za-z0-9_-]{40,64}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
  res.cookie(ATTEMPT_COOKIE, secret, { httpOnly: true, sameSite: 'strict', secure: cookieIsSecure(req), path: '/api/auth/magic', maxAge: LINK_TTL_MS });
  return secret;
}

function heldByThisBrowser(req: Request, doc: AttemptDoc): boolean {
  const secret = readCookie(req, ATTEMPT_COOKIE);
  return Boolean(secret) && sameHash(doc.browserHash, sha256(secret!));
}

/** Records the attempt and returns what to email (nothing for an address without a usable account). */
export async function startMagicSignIn(
  req: Request,
  res: Response,
  email: string
): Promise<{ attemptId: string; expiresInSeconds: number; send: { account: Account; linkToken: string; from: RequestedFrom } | null }> {
  const address = normalizeEmail(email);
  const account = await getUserByEmail(address);
  const usable = account && !account.disabled ? account : null;
  const info = clientInfo(req);
  const now = new Date();
  const attemptId = randomBytes(18).toString('base64url');
  const linkToken = randomBytes(32).toString('base64url');
  const from: RequestedFrom = { device: info.device, location: info.location, ip: info.ip, at: now };
  await attempts().insertOne({
    _id: attemptId,
    uid: usable?._id ?? null,
    email: address,
    linkHash: sha256(linkToken),
    browserHash: sha256(browserSecret(req, res)),
    status: 'sent',
    codeTries: 0,
    requestedFrom: from,
    createdAt: now,
    expiresAt: new Date(now.getTime() + LINK_TTL_MS),
  });
  return { attemptId, expiresInSeconds: LINK_TTL_MS / 1000, send: usable ? { account: usable, linkToken, from } : null };
}

export type OpenResult = { kind: 'signed-in'; account: Account } | { kind: 'code'; code: string; from: RequestedFrom } | { kind: 'invalid' };

/** The link was opened: signs in the browser that asked, or gives a code to type there. */
export async function openMagicLink(req: Request, linkToken: string): Promise<OpenResult> {
  if (typeof linkToken !== 'string' || linkToken.length > 100) return { kind: 'invalid' };
  const doc = await attempts().findOne({ linkHash: sha256(linkToken) });
  const now = new Date();
  if (!doc || !doc.uid || doc.status === 'done' || doc.expiresAt <= now) return { kind: 'invalid' };

  if (heldByThisBrowser(req, doc)) {
    const claimed = await attempts().findOneAndUpdate({ _id: doc._id, status: { $ne: 'done' } }, { $set: { status: 'done' } });
    const account = claimed ? await getUser(doc.uid) : null;
    return account && !account.disabled ? { kind: 'signed-in', account } : { kind: 'invalid' };
  }

  // Another device: a fresh code each time the link is opened (an earlier one stops working), redeemable only where it was asked for.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const updated = await attempts().updateOne(
    { _id: doc._id, status: { $ne: 'done' } },
    { $set: { status: 'opened', codeHash: codeHash(doc._id, code), codeExpiresAt: new Date(now.getTime() + CODE_TTL_MS), codeTries: 0 } }
  );
  return updated.modifiedCount ? { kind: 'code', code, from: doc.requestedFrom } : { kind: 'invalid' };
}

export type VerifyResult =
  | { kind: 'signed-in'; account: Account }
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'not-opened' }
  | { kind: 'invalid' };

/** The code typed on the device that asked. */
export async function verifyMagicCode(req: Request, attemptId: string, code: string): Promise<VerifyResult> {
  const doc = await attempts().findOne({ _id: String(attemptId) });
  const now = new Date();
  // Only the browser that asked can redeem a code; anywhere else the attempt looks like it does not exist.
  if (!doc || !heldByThisBrowser(req, doc) || doc.status === 'done' || doc.expiresAt <= now) return { kind: 'invalid' };
  if (doc.status === 'sent') return { kind: 'not-opened' };
  if (!doc.uid || !doc.codeExpiresAt || doc.codeExpiresAt <= now || doc.codeTries >= MAX_CODE_TRIES) return { kind: 'invalid' };

  // A try is taken before the code is compared, in one atomic step, so even many guesses sent at once get 5 comparisons in all.
  const tried = await attempts().findOneAndUpdate(
    { _id: doc._id, status: 'opened', codeTries: { $lt: MAX_CODE_TRIES }, codeExpiresAt: { $gt: now } },
    { $inc: { codeTries: 1 } },
    { returnDocument: 'after' }
  );
  if (!tried) return { kind: 'invalid' };
  if (!/^\d{6}$/.test(code) || !sameHash(tried.codeHash, codeHash(tried._id, code))) {
    const left = Math.max(0, MAX_CODE_TRIES - tried.codeTries);
    return left > 0 ? { kind: 'wrong', triesLeft: left } : { kind: 'invalid' };
  }
  // The code a person read is only good with the code hash it was given with, so a link opened again meanwhile voids it.
  const claimed = await attempts().findOneAndUpdate({ _id: tried._id, status: 'opened', codeHash: tried.codeHash }, { $set: { status: 'done' } });
  const account = claimed ? await getUser(doc.uid) : null;
  return account && !account.disabled ? { kind: 'signed-in', account } : { kind: 'invalid' };
}
