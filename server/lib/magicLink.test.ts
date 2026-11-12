import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { col, createUser, resetDatabase, startApi, type TestApi } from '../test/helpers';
import { setMailSenderForTests, type MailMessage } from './mailer';
import { MAX_CODE_TRIES } from './magicLink';

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

// A tiny cookie jar: what one browser would send back.
class Browser {
  jar = new Map<string, string>();
  constructor(public headers: Record<string, string> = {}) {}
  async call(method: string, path: string, body?: unknown) {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await api.call(method, path, { body, headers: { ...this.headers, ...(cookie ? { Cookie: cookie } : {}) } });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1);
      if (/Expires=Thu, 01 Jan 1970/i.test(line) || !value) this.jar.delete(pair.slice(0, eq));
      else this.jar.set(pair.slice(0, eq), value);
    }
    return res;
  }
}

const waitForMail = async (subject: RegExp, to: string) => {
  for (let i = 0; i < 100; i++) {
    const found = mail.find((m) => subject.test(m.subject) && m.to === to);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no mail ${subject} to ${to}`);
};
const linkToken = (m: MailMessage) => decodeURIComponent(/[?&]magic=([^\s&"]+)/.exec(m.text)![1]);

describe('sign-in by email link', () => {
  it('signs the asking browser straight in when the link is opened there', async () => {
    await createUser('linky@team.test');
    const laptop = new Browser();
    const asked = await laptop.call('POST', '/api/auth/magic/request', { email: 'Linky@Team.test' });
    expect(asked.status).toBe(202);
    expect(asked.body.attemptId).toMatch(/^[A-Za-z0-9_-]{16,40}$/);
    const message = await waitForMail(/sign-in link/i, 'linky@team.test');
    expect(message.text).toMatch(/Requested from|Device/);

    const opened = await laptop.call('POST', '/api/auth/magic/open', { token: linkToken(message) });
    expect(opened.status).toBe(200);
    expect(opened.body.user.email).toBe('linky@team.test');
    expect((await laptop.call('GET', '/api/auth/me')).status).toBe(200);
    // A link works once.
    expect((await laptop.call('POST', '/api/auth/magic/open', { token: linkToken(message) })).status).toBe(400);
  });

  it('on another device shows a code, and only the asking browser can use it', async () => {
    await createUser('two.devices@team.test');
    const laptop = new Browser();
    const phone = new Browser();
    const stranger = new Browser();
    const { attemptId } = (await laptop.call('POST', '/api/auth/magic/request', { email: 'two.devices@team.test' })).body;

    // Before the link is opened there is no code to give.
    expect((await laptop.call('POST', '/api/auth/magic/verify', { attemptId, code: '123456' })).body.error.code).toBe('NOT_OPENED');

    const shown = await phone.call('POST', '/api/auth/magic/open', { token: linkToken(await waitForMail(/sign-in link/i, 'two.devices@team.test')) });
    expect(shown.status).toBe(200);
    expect(shown.body.status).toBe('code');
    expect(shown.body.code).toMatch(/^\d{6}$/);
    expect(shown.body.requestedFrom.device).toBeTruthy();
    // The phone is not signed in by opening the link.
    expect((await phone.call('GET', '/api/auth/me')).status).toBe(401);

    // Someone else holding the attempt id and the code still cannot use it.
    expect((await stranger.call('POST', '/api/auth/magic/verify', { attemptId, code: shown.body.code })).status).toBe(400);

    const signedIn = await laptop.call('POST', '/api/auth/magic/verify', { attemptId, code: shown.body.code });
    expect(signedIn.status).toBe(200);
    expect((await laptop.call('GET', '/api/auth/me')).status).toBe(200);
    expect((await laptop.call('POST', '/api/auth/magic/verify', { attemptId, code: shown.body.code })).status).toBe(400);
  });

  it('stops after five wrong codes, even for the right one', async () => {
    await createUser('guessy@team.test');
    const laptop = new Browser();
    const { attemptId } = (await laptop.call('POST', '/api/auth/magic/request', { email: 'guessy@team.test' })).body;
    const shown = await new Browser().call('POST', '/api/auth/magic/open', { token: linkToken(await waitForMail(/sign-in link/i, 'guessy@team.test')) });
    const wrong = shown.body.code === '000000' ? '111111' : '000000';
    const answers = [];
    for (let i = 0; i < MAX_CODE_TRIES; i++) answers.push((await laptop.call('POST', '/api/auth/magic/verify', { attemptId, code: wrong })).body.error.code);
    expect(answers.slice(0, -1).every((c) => c === 'WRONG_CODE')).toBe(true);
    expect(answers.at(-1)).toBe('INVALID_CODE');
    expect((await laptop.call('POST', '/api/auth/magic/verify', { attemptId, code: shown.body.code })).status).toBe(400);
  });

  it('compares at most five codes in all, even when many are sent at once', async () => {
    await createUser('burst@team.test');
    const laptop = new Browser();
    const { attemptId } = (await laptop.call('POST', '/api/auth/magic/request', { email: 'burst@team.test' })).body;
    const shown = await new Browser().call('POST', '/api/auth/magic/open', { token: linkToken(await waitForMail(/sign-in link/i, 'burst@team.test')) });
    const right: string = shown.body.code;
    const guesses = Array.from({ length: 30 }, (_, i) => String((Number(right) + 1 + i) % 1_000_000).padStart(6, '0'));
    // The right code goes last, after 30 wrong ones sent all at the same moment.
    const answers = await Promise.all([...guesses, right].map((code) => laptop.call('POST', '/api/auth/magic/verify', { attemptId, code })));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(0);
    expect(answers.filter((a) => a.body?.error?.code === 'WRONG_CODE').length).toBeLessThanOrEqual(MAX_CODE_TRIES - 1);
    const stored = await col('loginAttempts').findOne({ _id: attemptId as never });
    expect(stored?.codeTries).toBe(MAX_CODE_TRIES);
  });

  it('ends the session a browser already had when it signs in again', async () => {
    await createUser('again@team.test', 'correct-horse-battery');
    const laptop = new Browser();
    expect((await laptop.call('POST', '/api/auth/login', { email: 'again@team.test', password: 'correct-horse-battery' })).status).toBe(200);
    const first = laptop.jar.get('dubly_session')!;
    expect((await laptop.call('POST', '/api/auth/login', { email: 'again@team.test', password: 'correct-horse-battery' })).status).toBe(200);
    expect(laptop.jar.get('dubly_session')).not.toBe(first);
    expect((await laptop.call('GET', '/api/auth/me')).status).toBe(200);
    const old = new Browser();
    old.jar.set('dubly_session', first);
    expect((await old.call('GET', '/api/auth/me')).status).toBe(401);
  });

  it('answers an unknown address exactly like a known one, and emails nobody', async () => {
    const laptop = new Browser();
    const asked = await laptop.call('POST', '/api/auth/magic/request', { email: 'nobody@team.test' });
    expect(asked.status).toBe(202);
    expect(Object.keys(asked.body).sort()).toEqual(['attemptId', 'expiresInSeconds']);
    expect((await laptop.call('POST', '/api/auth/magic/verify', { attemptId: asked.body.attemptId, code: '123456' })).body.error.code).toBe('NOT_OPENED');
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.filter((m) => m.to === 'nobody@team.test')).toHaveLength(0);
  });

  it('keeps only hashes of links and codes', async () => {
    await createUser('hashed@team.test');
    const laptop = new Browser();
    await laptop.call('POST', '/api/auth/magic/request', { email: 'hashed@team.test' });
    const token = linkToken(await waitForMail(/sign-in link/i, 'hashed@team.test'));
    const shown = await new Browser().call('POST', '/api/auth/magic/open', { token });
    const stored = JSON.stringify(await col('loginAttempts').find().toArray());
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(`"${shown.body.code}"`);
  });
});

describe('the first proof of the inbox', () => {
  // An account whose email nobody has confirmed, with a password someone set: what an invitation link's holder (the inviting admin,
  // say) leaves behind, or a stranger who signed up with the address.
  const unconfirmed = (email: string, password: string) => createUser(email, password, false);
  const signInByLink = async (browser: Browser, email: string) => {
    await browser.call('POST', '/api/auth/magic/request', { email });
    const message = await waitForMail(/sign-in link/i, email);
    mail.splice(mail.indexOf(message), 1);
    return browser.call('POST', '/api/auth/magic/open', { token: linkToken(message) });
  };

  it('ends every earlier session and drops the password set before it', async () => {
    const planted = await unconfirmed('invitee@team.test', 'set by someone else');
    const stranger = new Browser();
    expect((await stranger.call('POST', '/api/auth/login', { email: 'invitee@team.test', password: 'set by someone else' })).status).toBe(200);

    const owner = new Browser();
    const opened = await signInByLink(owner, 'invitee@team.test');
    expect(opened.status).toBe(200);
    expect(opened.body.user.emailVerified).toBe(true);

    expect((await stranger.call('GET', '/api/auth/me')).status).toBe(401);
    expect((await api.call('GET', '/api/auth/me', { token: planted.token })).status).toBe(401);
    expect((await new Browser().call('POST', '/api/auth/login', { email: 'invitee@team.test', password: 'set by someone else' })).status).toBe(401);
    expect((await owner.call('GET', '/api/auth/me')).status).toBe(200);
    // The owner learns why, by email, and Settings says how to choose a password rather than asking for one they never had.
    expect((await waitForMail(/email is confirmed/i, 'invitee@team.test')).text).toMatch(/Forgot password/);
    const change = await owner.call('POST', '/api/auth/change-password', { currentPassword: 'set by someone else', newPassword: 'my own new phrase' });
    expect(change.body.error.code).toBe('NO_PASSWORD');
  });

  it('keeps the password when the browser proving the inbox is already signed in with it', async () => {
    const other = await unconfirmed('self.made@team.test', 'chosen by me 2026');
    const laptop = new Browser();
    expect((await laptop.call('POST', '/api/auth/login', { email: 'self.made@team.test', password: 'chosen by me 2026' })).status).toBe(200);
    expect((await signInByLink(laptop, 'self.made@team.test')).status).toBe(200);

    expect((await new Browser().call('POST', '/api/auth/login', { email: 'self.made@team.test', password: 'chosen by me 2026' })).status).toBe(200);
    // Every other session still ends.
    expect((await api.call('GET', '/api/auth/me', { token: other.token })).status).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    expect(mail.filter((m) => /email is confirmed/i.test(m.subject))).toHaveLength(0);
  });

  it('applies to the code typed on the asking device too, and only the first time', async () => {
    await unconfirmed('coded@team.test', 'set by someone else');
    const laptop = new Browser();
    const asked = await laptop.call('POST', '/api/auth/magic/request', { email: 'coded@team.test' });
    const message = await waitForMail(/sign-in link/i, 'coded@team.test');
    const shown = await new Browser().call('POST', '/api/auth/magic/open', { token: linkToken(message) });
    expect((await laptop.call('POST', '/api/auth/magic/verify', { attemptId: asked.body.attemptId, code: shown.body.code })).status).toBe(200);
    expect((await new Browser().call('POST', '/api/auth/login', { email: 'coded@team.test', password: 'set by someone else' })).status).toBe(401);

    // Confirmed now: later proofs leave sessions alone.
    const phone = new Browser();
    mail.length = 0;
    expect((await signInByLink(phone, 'coded@team.test')).status).toBe(200);
    expect((await laptop.call('GET', '/api/auth/me')).status).toBe(200);
  });
});

describe('new sign-in emails', () => {
  it('stays quiet for the first device and a known one, and tells the owner about a new one, with place and device', async () => {
    process.env.EDGE_SHARED_SECRET = 'edge-secret';
    try {
      await createUser('watched@team.test', 'the password');
      const login = (b: Browser) => b.call('POST', '/api/auth/login', { email: 'watched@team.test', password: 'the password' });
      const laptop = new Browser({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' });
      expect((await login(laptop)).status).toBe(200);
      expect((await login(laptop)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(mail.filter((m) => /new sign-in/i.test(m.subject))).toHaveLength(0);

      const phone = new Browser({
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        'X-Dubly-Edge-Secret': 'edge-secret',
        'X-Dubly-Client-IP': '203.0.113.7',
        'X-Dubly-Client-Geo': encodeURIComponent(JSON.stringify({ city: 'Pune', region: 'Maharashtra', country: 'IN' })),
      });
      expect((await login(phone)).status).toBe(200);
      const notice = await waitForMail(/new sign-in/i, 'watched@team.test');
      expect(notice.subject).toContain('Safari on iPhone');
      expect(notice.text).toContain('Pune, Maharashtra, India');
      expect(notice.text).toContain('203.0.113.7');
      expect(notice.text).toContain('Password');
    } finally {
      delete process.env.EDGE_SHARED_SECRET;
    }
  });

  it('ignores a location header that did not come through the front door', async () => {
    await createUser('spoofed@team.test', 'the password');
    await new Browser().call('POST', '/api/auth/login', { email: 'spoofed@team.test', password: 'the password' });
    const forged = new Browser({ 'X-Dubly-Client-Geo': encodeURIComponent(JSON.stringify({ city: 'Nowhere' })) });
    await forged.call('POST', '/api/auth/login', { email: 'spoofed@team.test', password: 'the password' });
    const notice = await waitForMail(/new sign-in/i, 'spoofed@team.test');
    expect(notice.text).not.toContain('Nowhere');
    expect(notice.text).toContain('Location: Not known');
  });
});
