import type { Request, Response } from 'express';
import { Router } from '../lib/router';
import { env } from '../lib/env';
import {
  AccountError,
  checkCredentials,
  consumeAuthToken,
  createSession,
  createUser,
  getUser,
  getUserByEmail,
  hashPassword,
  isEmail,
  issueAuthToken,
  markEmailVerified,
  normalizeEmail,
  passwordProblem,
  peekAuthToken,
  revokeAllSessions,
  revokeSession,
  setPassword,
  toPublicUser,
  type UserDoc,
} from '../lib/accounts';
import { authLink, buildResetEmail, buildVerifyEmail, deliverAuthEmail } from '../lib/authEmail';
import { clearSessionCookie, requireAuth, requireSameOrigin, sessionTokenOf, setSessionCookie } from '../lib/auth';
import { clientIp, forget, hit, rateLimit, retryAfter } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { schemas, validateBody } from '../lib/validation';
import { invalidateMembership } from '../lib/workspaces';
import { log } from '../lib/log';

/**
 * Sign-in and account management, all against MongoDB (lib/accounts.ts). Answers never say whether an email has an account:
 * sign-up and "forgot password" reply the same way either way, and a wrong email fails exactly like a wrong password.
 */
export const authRouter = Router();
authRouter.use(requireSameOrigin);

const ipLimit = (name: string, rule: typeof rateRules.loginPerIp) => rateLimit(name, [['ip', rule]]);

// A per-address ceiling, counted whether or not the address has an account; true when it is reached.
function addressLimited(res: Response, scope: string, email: string, rule: typeof rateRules.authEmailPerAddress): boolean {
  const wait = hit(`${scope}:email:${normalizeEmail(email)}`, rule);
  if (!wait) return false;
  res.setHeader('Retry-After', String(wait));
  res.status(429).json({ error: 'Too many attempts for this email. Wait a few minutes and try again.', code: 'RATE_LIMITED', retryAfterSeconds: wait });
  return true;
}

async function signIn(req: Request, res: Response, user: Pick<UserDoc, '_id' | 'email' | 'emailVerified' | 'displayName'>): Promise<void> {
  const { token, expiresAt } = await createSession(user._id, { userAgent: req.get('user-agent'), ip: clientIp(req) ?? undefined });
  setSessionCookie(req, res, token, expiresAt);
  invalidateMembership(user._id);
  res.status(200).json({ user: toPublicUser(user) });
}

function sendAccountError(res: Response, err: unknown): void {
  if (err instanceof AccountError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

async function sendVerification(user: Pick<UserDoc, '_id' | 'email'>): Promise<boolean> {
  const token = await issueAuthToken(user._id, user.email, 'verify-email');
  const link = authLink('verify', token);
  return deliverAuthEmail(buildVerifyEmail(user.email, link), link);
}

async function sendReset(user: Pick<UserDoc, '_id' | 'email'>): Promise<boolean> {
  const token = await issueAuthToken(user._id, user.email, 'reset-password');
  const link = authLink('reset', token);
  return deliverAuthEmail(buildResetEmail(user.email, link), link);
}

// Mail is sent after the answer, so how long the request takes says nothing about whether the address has an account.
function inBackground(task: () => Promise<unknown>, event: string): void {
  setImmediate(() => void task().catch((err) => log.error(event, err)));
}

/** Creates an account and emails a link to confirm the address; using the link signs the person in. */
authRouter.post('/signup', ipLimit('signup', rateRules.signupPerIp), validateBody(schemas.signup), async (req, res) => {
  if (!env.allowSignup) {
    res.status(403).json({ error: 'New accounts are by invitation only. Ask your workspace admin for an invite.', code: 'SIGNUP_CLOSED' });
    return;
  }
  const email = normalizeEmail(req.body.email);
  const { password, name } = req.body as { password: string; name: string };
  if (!isEmail(email)) {
    res.status(400).json({ error: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    return;
  }
  const problem = passwordProblem(password, email);
  if (problem) {
    res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' });
    return;
  }
  if (addressLimited(res, 'auth-email', email, rateRules.authEmailPerAddress)) return;

  const existing = await getUserByEmail(email);
  if (existing) {
    // Never changes the existing account: its owner gets a link to confirm (if they never did) or to reset their password.
    inBackground(() => (existing.emailVerified ? sendReset(existing) : sendVerification(existing)), 'signup_existing_mail_failed');
    // A new account spends a password hash before answering; this does too, so the time taken does not tell the two apart.
    await hashPassword(password);
  } else {
    try {
      const user = await createUser({ email, password, displayName: name, emailVerified: false });
      inBackground(() => sendVerification({ _id: user.uid, email: user.email }), 'signup_mail_failed');
      log.info('account_created', { userId: user.uid });
    } catch (err) {
      // Created a moment ago by a parallel request: answered like any existing address.
      if (!(err instanceof AccountError && err.code === 'EMAIL_EXISTS')) {
        sendAccountError(res, err);
        return;
      }
    }
  }
  res.status(202).json({ status: 'verify-email', email });
});

authRouter.post('/verify-email', ipLimit('auth-token', rateRules.signupPerIp), validateBody(schemas.authToken), async (req, res) => {
  const user = await consumeAuthToken(req.body.token, 'verify-email');
  if (!user) {
    res.status(400).json({ error: 'This confirmation link is invalid or has expired. Sign in to send a new one.', code: 'INVALID_LINK' });
    return;
  }
  await markEmailVerified(user._id);
  log.info('email_verified', { userId: user._id });
  await signIn(req, res, { ...user, emailVerified: true });
});

authRouter.post('/login', ipLimit('login', rateRules.loginPerIp), validateBody(schemas.login), async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const address = normalizeEmail(email);
  const pairKey = `login-fail:${address}:${clientIp(req) ?? 'unknown'}`;
  const emailKey = `login-fail:${address}`;
  // Checked before the password, counted only when it is wrong: someone guessing locks out themselves, not the account's owner.
  const wait = Math.max(retryAfter(pairKey, rateRules.loginFailuresPerEmailAndIp), retryAfter(emailKey, rateRules.loginFailuresPerEmail));
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    res.status(429).json({ error: 'Too many wrong passwords. Wait a few minutes, or reset it with "Forgot password?".', code: 'RATE_LIMITED', retryAfterSeconds: wait });
    return;
  }
  const user = await checkCredentials(email, password);
  if (!user) {
    hit(pairKey, rateRules.loginFailuresPerEmailAndIp);
    hit(emailKey, rateRules.loginFailuresPerEmail);
    res.status(401).json({ error: 'That email and password do not match.', code: 'INVALID_CREDENTIALS' });
    return;
  }
  forget(pairKey);
  // Only said once the password is right, so it reveals nothing to someone guessing.
  if (user.disabled) {
    res.status(403).json({ error: 'This account has been disabled. Contact ScatterPie.', code: 'ACCOUNT_DISABLED' });
    return;
  }
  log.info('signed_in', { userId: user._id });
  await signIn(req, res, user);
});

authRouter.post('/logout', async (req, res) => {
  const presented = sessionTokenOf(req);
  if (presented) await revokeSession(presented.token);
  clearSessionCookie(req, res);
  res.status(204).send();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await getUser(req.uid!);
  res.json({ user: user ? toPublicUser(user) : { uid: req.uid, email: req.email, emailVerified: req.emailVerified === true, displayName: null } });
});

authRouter.post('/resend-verification', requireAuth, async (req, res) => {
  if (req.emailVerified) {
    res.status(204).send();
    return;
  }
  if (addressLimited(res, 'auth-email', req.email!, rateRules.authEmailPerAddress)) return;
  const emailed = await sendVerification({ _id: req.uid!, email: req.email! });
  res.status(202).json({ emailed });
});

authRouter.post('/forgot-password', ipLimit('auth-email', rateRules.authEmailPerIp), validateBody(schemas.emailOnly), async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (addressLimited(res, 'auth-email', email, rateRules.authEmailPerAddress)) return;
  inBackground(async () => {
    const user = await getUserByEmail(email);
    if (user && !user.disabled) await sendReset(user);
  }, 'password_reset_mail_failed');
  res.status(202).json({ status: 'sent-if-exists' });
});

authRouter.post('/reset-password', ipLimit('auth-token', rateRules.signupPerIp), validateBody(schemas.resetPassword), async (req, res) => {
  const { token, password } = req.body as { token: string; password: string };
  const holder = await peekAuthToken(token, 'reset-password');
  if (!holder) {
    res.status(400).json({ error: 'This reset link is invalid or has expired. Ask for a new one with "Forgot password?".', code: 'INVALID_LINK' });
    return;
  }
  const problem = passwordProblem(password, holder.email);
  if (problem) {
    res.status(400).json({ error: problem, code: 'WEAK_PASSWORD' });
    return;
  }
  const user = await consumeAuthToken(token, 'reset-password');
  if (!user) {
    res.status(400).json({ error: 'This reset link has already been used. Ask for a new one with "Forgot password?".', code: 'INVALID_LINK' });
    return;
  }
  await setPassword(user._id, password);
  // Every other device is signed out; the link reached the inbox, so the address is now confirmed too.
  await revokeAllSessions(user._id);
  await markEmailVerified(user._id);
  log.info('password_reset', { userId: user._id });
  await signIn(req, res, { ...user, emailVerified: true });
});

authRouter.post(
  '/change-password',
  requireAuth,
  rateLimit('change-password', [['user', rateRules.passwordChangePerUser]]),
  validateBody(schemas.changePassword),
  async (req, res) => {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    const user = await checkCredentials(req.email!, currentPassword);
    if (!user || user._id !== req.uid) {
      res.status(400).json({ error: 'Your current password is not correct.', code: 'WRONG_PASSWORD' });
      return;
    }
    try {
      await setPassword(req.uid!, newPassword);
    } catch (err) {
      sendAccountError(res, err);
      return;
    }
    // Signed out everywhere, then signed in again here with a fresh session.
    await revokeAllSessions(req.uid!);
    log.info('password_changed', { userId: req.uid });
    await signIn(req, res, user);
  }
);
