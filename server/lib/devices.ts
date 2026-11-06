import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { col, isDuplicateKeyError } from './mongo';
import { sha256 } from './accounts';
import { cookieIsSecure, readCookie } from './auth';
import { clientInfo, type ClientInfo } from './clientInfo';

/**
 * Devices an account has signed in from. Each browser gets a long-lived random id in an httpOnly cookie; a sign-in from an id the
 * account has not used before is a new device, and the owner gets an email saying when, where and on what (notifications.ts).
 * The very first device of an account is simply remembered: there is nothing to compare it with yet.
 */
export const DEVICE_COOKIE = 'dubly_device';
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export type SignInMethod = 'password' | 'email-link' | 'email-code' | 'password-reset' | 'email-confirmation';

export const METHOD_LABELS: Record<SignInMethod, string> = {
  password: 'Password',
  'email-link': 'Sign-in link from email',
  'email-code': 'Code from a sign-in email',
  'password-reset': 'Password reset link',
  'email-confirmation': 'Email confirmation link',
};

interface DeviceDoc {
  _id: string;
  uid: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  device: string;
  ip: string | null;
  location: string | null;
}

const devices = () => col<DeviceDoc>('devices');

export interface SignInContext extends ClientInfo {
  method: SignInMethod;
  at: Date;
}

/** Remembers this device for the account; true when the account has signed in elsewhere before but never from here. */
export async function noteDevice(req: Request, res: Response, uid: string, method: SignInMethod): Promise<{ isNew: boolean; context: SignInContext }> {
  let deviceId = readCookie(req, DEVICE_COOKIE);
  if (!deviceId || !/^[A-Za-z0-9_-]{24,64}$/.test(deviceId)) deviceId = randomBytes(24).toString('base64url');
  res.cookie(DEVICE_COOKIE, deviceId, { httpOnly: true, sameSite: 'strict', secure: cookieIsSecure(req), path: '/api/auth', maxAge: TWO_YEARS_MS });

  const info = clientInfo(req);
  const context: SignInContext = { ...info, method, at: new Date() };
  // Per account and device, so one browser shared by two accounts is new to each of them once. Only the cookie's value is hashed
  // (a database read cannot be replayed as someone's device); the account id is not secret.
  const id = `${sha256(deviceId)}:${uid}`;
  const seen = await devices().findOneAndUpdate(
    { _id: id, uid },
    { $set: { lastSeenAt: context.at, device: info.device, ip: info.ip, location: info.location } }
  );
  if (seen) return { isNew: false, context };
  const hadOthers = (await devices().countDocuments({ uid }, { limit: 1 })) > 0;
  try {
    await devices().insertOne({ _id: id, uid, firstSeenAt: context.at, lastSeenAt: context.at, device: info.device, ip: info.ip, location: info.location });
  } catch (err) {
    // The same device signing in twice at once: the other request recorded it.
    if (isDuplicateKeyError(err)) return { isNew: false, context };
    throw err;
  }
  return { isNew: hadOthers, context };
}
