import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { col, createUser, resetDatabase, signIn, startApi, type TestApi } from '../test/helpers';
import { createSession, deleteUser, hashPassword, setUserDisabled, sha256, verifyPassword } from './accounts';
import { setMailSenderForTests, type MailMessage } from './mailer';
import { getSignedDownloadUrl, signReadUrl, uploadBufferToStorage } from './mediaStore';

let api: TestApi;
const mail: MailMessage[] = [];
beforeAll(async () => {
  api = await startApi();
  setMailSenderForTests(async (message) => {
    mail.push(message);
  });
});
afterAll(async () => {
  setMailSenderForTests(null);
  await api.close();
});
beforeEach(async () => {
  await resetDatabase();
  mail.length = 0;
});

const profile = (token?: string) => api.call('GET', '/api/profile', { token });
// Mail goes out after the answer; give it a moment.
// The next email matching `subject` (other emails, e.g. a welcome sent in the background, are left in the queue).
const nextMail = async (subject: RegExp = /./, to?: string): Promise<MailMessage> => {
  const find = () => mail.findIndex((m) => subject.test(m.subject) && (!to || m.to === to));
  for (let i = 0; i < 100 && find() < 0; i++) await new Promise((r) => setTimeout(r, 20));
  const at = find();
  if (at < 0) throw new Error(`no mail matching ${subject} was sent`);
  return mail.splice(at, 1)[0];
};
const linkToken = (message: MailMessage, param: 'verify' | 'reset') => decodeURIComponent(new RegExp(`[?&]${param}=([^\\s&"]+)`).exec(message.text)![1]);
const cookieOf = (headers: Headers) => (headers.get('set-cookie') || '').split(';')[0];

describe('passwords', () => {
  it('hashes with scrypt and a fresh salt, and verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('correct horsf', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});

describe('requireAuth', () => {
  it('accepts a valid session', async () => {
    const user = await createUser('valid@team.test');
    expect((await profile(user.token)).status).toBe(200);
  });

  it('rejects missing, malformed and made-up tokens', async () => {
    expect((await profile()).status).toBe(401);
    expect((await profile('not-a-session')).status).toBe(401);
    expect((await api.call('GET', '/api/profile', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const user = await createUser('hash@team.test');
    expect(await col('sessions').findOne({ _id: user.token as never })).toBeNull();
    expect(await col('sessions').findOne({ _id: sha256(user.token) as never })).not.toBeNull();
  });

  it('rejects an expired session', async () => {
    const user = await createUser('expired@team.test');
    await col('sessions').updateOne({ _id: sha256(user.token) as never }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await profile(user.token)).status).toBe(401);
  });

  it('signs out everywhere at once, and accepts the next sign-in', async () => {
    const user = await createUser('revoked@team.test');
    const second = await signIn(user.email);
    expect((await api.call('POST', '/api/profile/sign-out-everywhere', { token: user.token })).status).toBe(204);
    expect((await profile(user.token)).status).toBe(401);
    expect((await profile(second)).status).toBe(401);
    expect((await profile(await signIn(user.email))).status).toBe(200);
  });

  it('rejects disabled and deleted accounts', async () => {
    const disabled = await createUser('disabled@team.test');
    const deleted = await createUser('deleted@team.test');
    // A session made after disabling (should one slip through) is refused too.
    await setUserDisabled(disabled.uid, true);
    const late = (await createSession(disabled.uid)).token;
    await deleteUser(deleted.uid);
    expect((await profile(disabled.token)).status).toBe(401);
    expect((await profile(late)).status).toBe(401);
    expect((await profile(deleted.token)).status).toBe(401);
  });

  it('refuses a cookie-authenticated change that comes from another site', async () => {
    const user = await createUser('csrf@team.test');
    const cookie = `dubly_session=${user.token}`;
    const crossSite = await api.call('PATCH', '/api/profile', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' }, body: { name: 'Mallory' } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe('CROSS_SITE');
    const sameOrigin = await api.call('GET', '/api/profile', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    expect(sameOrigin.status).toBe(200);
  });
});

describe('sign-up, email confirmation and sign-in', () => {
  it('creates an account that is used once its email is confirmed', async () => {
    const signup = await api.call('POST', '/api/auth/signup', { body: { name: 'Asha', email: 'Asha@Team.test', password: 'a good password' } });
    expect(signup.status).toBe(202);
    expect(signup.headers.get('set-cookie')).toBeNull();

    // Signed in before confirming: no workspace (and no free minutes) yet.
    const early = await api.call('POST', '/api/auth/login', { body: { email: 'asha@team.test', password: 'a good password' } });
    expect(early.status).toBe(200);
    const earlyCookie = cookieOf(early.headers);
    const blocked = await api.call('GET', '/api/bootstrap', { headers: { Cookie: earlyCookie } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const message = await nextMail(/confirm your email/i);
    expect(message.to).toBe('asha@team.test');
    const verified = await api.call('POST', '/api/auth/verify-email', { body: { token: linkToken(message, 'verify') } });
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({ email: 'asha@team.test', emailVerified: true, displayName: 'Asha' });
    const cookie = cookieOf(verified.headers);
    expect(verified.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(verified.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);

    const boot = await api.call('GET', '/api/bootstrap', { headers: { Cookie: cookie } });
    expect(boot.status).toBe(200);
    expect(boot.body.workspace.members[0]).toMatchObject({ email: 'asha@team.test', name: 'Asha', role: 'admin' });

    // A link works once.
    expect((await api.call('POST', '/api/auth/verify-email', { body: { token: linkToken(message, 'verify') } })).status).toBe(400);
  });

  it('answers sign-up for an existing email exactly like a new one, and never changes that account', async () => {
    await createUser('taken@team.test', 'original password');
    const again = await api.call('POST', '/api/auth/signup', { body: { name: 'Eve', email: 'taken@team.test', password: 'eves password' } });
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ status: 'verify-email', email: 'taken@team.test' });
    expect((await nextMail(/reset/i, 'taken@team.test')).subject).toMatch(/reset/i);
    expect((await api.call('POST', '/api/auth/login', { body: { email: 'taken@team.test', password: 'eves password' } })).status).toBe(401);
    expect((await api.call('POST', '/api/auth/login', { body: { email: 'taken@team.test', password: 'original password' } })).status).toBe(200);
  });

  it('refuses weak passwords with a reason', async () => {
    const short = await api.call('POST', '/api/auth/signup', { body: { name: 'A', email: 'a@team.test', password: 'short' } });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('WEAK_PASSWORD');
    const sameAsEmail = await api.call('POST', '/api/auth/signup', { body: { name: 'A', email: 'a@team.test', password: 'a@team.test' } });
    expect(sameAsEmail.body.error.code).toBe('WEAK_PASSWORD');
  });

  it('fails a wrong password and an unknown email the same way', async () => {
    await createUser('known@team.test');
    const wrong = await api.call('POST', '/api/auth/login', { body: { email: 'known@team.test', password: 'nope nope' } });
    const unknown = await api.call('POST', '/api/auth/login', { body: { email: 'nobody@team.test', password: 'nope nope' } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: unknown.body.error.message });
  });

  it('limits wrong passwords per email', async () => {
    await createUser('target@team.test');
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await api.call('POST', '/api/auth/login', { body: { email: 'target@team.test', password: `guess ${i}` } })).status;
    expect(last).toBe(429);
  });

  it('never locks the owner out: guesses from one address leave sign-in from another open', async () => {
    process.env.EDGE_SHARED_SECRET = 'edge-test-secret';
    try {
      await createUser('victim@team.test', 'the right password');
      const from = (ip: string) => ({ 'X-Dubly-Edge-Secret': 'edge-test-secret', 'X-Dubly-Client-IP': ip });
      let attacker = 0;
      for (let i = 0; i < 12; i++) {
        attacker = (await api.call('POST', '/api/auth/login', { headers: from('203.0.113.9'), body: { email: 'victim@team.test', password: `guess ${i}` } })).status;
      }
      expect(attacker).toBe(429);
      const owner = await api.call('POST', '/api/auth/login', { headers: from('198.51.100.7'), body: { email: 'victim@team.test', password: 'the right password' } });
      expect(owner.status).toBe(200);
      // A forged address without the shared secret is ignored, so it cannot be used to dodge the limit.
      const forged = await api.call('POST', '/api/auth/login', { headers: { 'X-Dubly-Client-IP': '192.0.2.1' }, body: { email: 'victim@team.test', password: 'still guessing' } });
      expect(forged.status).toBe(401);
    } finally {
      delete process.env.EDGE_SHARED_SECRET;
    }
  });

  it('sends an enforced content security policy and the per-address request ceiling', async () => {
    const res = await fetch(`${api.baseUrl}/api/healthz`);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'self'.*script-src 'self'/);
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    expect(res.headers.get('ratelimit-policy')).toBeTruthy();
  });

  it('signs out the session on logout', async () => {
    await createUser('out@team.test');
    const login = await api.call('POST', '/api/auth/login', { body: { email: 'out@team.test', password: 'correct-horse-battery' } });
    const cookie = cookieOf(login.headers);
    expect((await api.call('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await api.call('POST', '/api/auth/logout', { headers: { Cookie: cookie } })).status).toBe(204);
    expect((await api.call('GET', '/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe('password reset and change', () => {
  it('resets through the emailed link once, signing out every other session', async () => {
    const user = await createUser('reset@team.test', 'old password 1');
    const forgot = await api.call('POST', '/api/auth/forgot-password', { body: { email: 'reset@team.test' } });
    expect(forgot.status).toBe(202);
    const token = linkToken(await nextMail(/reset your/i), 'reset');

    // A weak choice does not spend the link.
    expect((await api.call('POST', '/api/auth/reset-password', { body: { token, password: 'short' } })).status).toBe(400);
    const reset = await api.call('POST', '/api/auth/reset-password', { body: { token, password: 'new password 2' } });
    expect(reset.status).toBe(200);
    expect((await profile(user.token)).status).toBe(401);
    expect((await api.call('POST', '/api/auth/reset-password', { body: { token, password: 'new password 3' } })).status).toBe(400);
    expect((await api.call('POST', '/api/auth/login', { body: { email: 'reset@team.test', password: 'new password 2' } })).status).toBe(200);
  });

  it('says the same for an unknown email and sends nothing', async () => {
    const forgot = await api.call('POST', '/api/auth/forgot-password', { body: { email: 'ghost@team.test' } });
    expect(forgot.status).toBe(202);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.filter((m) => m.to === 'ghost@team.test')).toHaveLength(0);
  });

  it('changes the password only with the current one, and starts a fresh session', async () => {
    const user = await createUser('change@team.test', 'first password');
    const other = await signIn(user.email, 'first password');
    const wrong = await api.call('POST', '/api/auth/change-password', { token: user.token, body: { currentPassword: 'not it', newPassword: 'second password' } });
    expect(wrong.status).toBe(400);
    const changed = await api.call('POST', '/api/auth/change-password', { token: user.token, body: { currentPassword: 'first password', newPassword: 'second password' } });
    expect(changed.status).toBe(200);
    expect((await profile(other)).status).toBe(401);
    expect((await profile(user.token)).status).toBe(401);
    const fresh = cookieOf(changed.headers);
    expect((await api.call('GET', '/api/auth/me', { headers: { Cookie: fresh } })).status).toBe(200);
  });
});

describe('signed media URLs', () => {
  it('serves a stored file with ranges, and refuses altered or expired links', async () => {
    const path = 'workspaces/ws-media/projects/p1/clip.mp4';
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    await uploadBufferToStorage(path, bytes, 'video/mp4');
    const url = await getSignedDownloadUrl(path);

    const whole = await fetch(`${api.baseUrl}${url}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await fetch(`${api.baseUrl}${url}`, { headers: { Range: 'bytes=100-199' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);

    expect((await fetch(`${api.baseUrl}${url}`, { headers: { Range: 'bytes=9000-' } })).status).toBe(416);

    const otherPath = Buffer.from('workspaces/ws-other/projects/p2/clip.mp4').toString('base64url');
    const swapped = url.replace(/\/api\/media\/[^?]+/, `/api/media/${otherPath}`);
    expect((await fetch(`${api.baseUrl}${swapped}`)).status).toBe(403);
    expect((await fetch(`${api.baseUrl}${url.replace(/s=[^&]+/, 's=AAAA')}`)).status).toBe(403);
    const expired = await signReadUrl(path, Date.now() - 1000);
    expect((await fetch(`${api.baseUrl}${expired}`)).status).toBe(403);
  });
});
