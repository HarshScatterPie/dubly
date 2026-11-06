import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { col, createUser, mergeUsage, resetDatabase, startApi, type TestApi } from '../test/helpers';
import { setMailSenderForTests, type MailMessage } from './mailer';
import { composeEmail } from './emailTemplates';
import { buildMovedAccountEmail } from './authEmail';
import { checkUsageAlerts, usageLevel, welcomeOnce } from './notifications';
import { currentUsagePeriod } from './projectRepo';

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

const settle = () => new Promise((r) => setTimeout(r, 150));
const workspaceOf = async (token: string) => (await api.call('GET', '/api/workspace', { token })).body.id as string;

describe('email design', () => {
  it('sends HTML with a plain-text twin and its pictures inside the message', () => {
    const message = buildMovedAccountEmail('a@team.test', 'https://dubly.test/?reset=abc', 72);
    expect(message.html).toMatch(/^<!doctype html>/);
    expect(message.html).toContain('cid:hero-sunrise@dubly');
    expect(message.attachments?.map((a) => a.cid).sort()).toEqual(['hero-sunrise@dubly', 'logo@dubly', 'mark@dubly']);
    expect(message.attachments?.every((a) => a.content.length > 200)).toBe(true);
    expect(message.text).toContain('https://dubly.test/?reset=abc');
    expect(message.text).not.toMatch(/<[a-z]/i);
  });

  it('escapes everything a person typed, and keeps headers on one line', () => {
    const message = composeEmail({
      to: 'x@team.test',
      subject: 'Hello\r\nBcc: evil@x.test',
      preheader: '<script>',
      hero: 'dusk',
      eyebrow: '<i>e</i>',
      title: '<b>Acme</b>',
      paragraphs: ['<img src=x onerror=alert(1)>'],
      details: [['<td>', '"quoted"']],
      quote: '</td><script>alert(1)</script>',
    });
    expect(message.subject).not.toMatch(/[\r\n]/);
    for (const raw of ['<script>', '<b>', '<img src=x', '<i>e</i>', '"quoted"']) expect(message.html).not.toContain(raw);
    expect(message.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
  });
});

describe('welcome email', () => {
  it('goes once, on the first sign-in, and names the workspace and plan', async () => {
    await createUser('new.face@team.test', 'a good password');
    const signIn = () => api.call('POST', '/api/auth/login', { body: { email: 'new.face@team.test', password: 'a good password' } });
    expect((await signIn()).status).toBe(200);
    await settle();
    expect((await signIn()).status).toBe(200);
    await settle();
    const welcomes = mail.filter((m) => /welcome/i.test(m.subject));
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].to).toBe('new.face@team.test');
  });

  it('waits for a sign-up to confirm its email', async () => {
    const user = await createUser('unconfirmed@team.test', 'a good password', false);
    expect(await welcomeOnce(user.uid)).toBe(false);
    await col('users').updateOne({ _id: user.uid as never }, { $set: { emailVerified: true } });
    expect(await welcomeOnce(user.uid)).toBe(true);
    expect(await welcomeOnce(user.uid)).toBe(false);
  });
});

describe('password notice', () => {
  it('tells the owner whenever the password changes', async () => {
    const user = await createUser('careful@team.test', 'first password');
    const changed = await api.call('POST', '/api/auth/change-password', { token: user.token, body: { currentPassword: 'first password', newPassword: 'second password' } });
    expect(changed.status).toBe(200);
    await settle();
    const notice = mail.find((m) => /password was changed/i.test(m.subject));
    expect(notice?.to).toBe('careful@team.test');
    expect(notice?.text).toContain('changed from Settings');
  });
});

describe('usage emails', () => {
  it('knows when minutes are low or used up', () => {
    expect(usageLevel({ used: 39, limit: 50 })).toBeNull();
    expect(usageLevel({ used: 40, limit: 50 })).toBe('low');
    expect(usageLevel({ used: 49.96, limit: 50 })).toBe('out');
  });

  it('emails the admins once at 80% and once when used up, per period', async () => {
    const admin = await createUser('boss@team.test');
    const workspaceId = await workspaceOf(admin.token);
    const period = currentUsagePeriod();

    await mergeUsage(workspaceId, { minutesDubbed: 30, usagePeriod: period });
    expect(await checkUsageAlerts(workspaceId)).toBeNull();

    await mergeUsage(workspaceId, { minutesDubbed: 41, usagePeriod: period });
    expect(await checkUsageAlerts(workspaceId)).toBe('low');
    expect(await checkUsageAlerts(workspaceId)).toBeNull();
    expect(mail.filter((m) => m.to === 'boss@team.test' && /used 82%/.test(m.subject))).toHaveLength(1);

    await mergeUsage(workspaceId, { minutesDubbed: 50, usagePeriod: period });
    expect(await checkUsageAlerts(workspaceId)).toBe('out');
    expect(await checkUsageAlerts(workspaceId)).toBeNull();
    expect(mail.filter((m) => /used all your/i.test(m.subject))).toHaveLength(1);
  });

  it('sends nothing and marks nothing when email is not set up', async () => {
    setMailSenderForTests(null);
    try {
      const admin = await createUser('quiet@team.test');
      const workspaceId = await workspaceOf(admin.token);
      await mergeUsage(workspaceId, { minutesDubbed: 45, usagePeriod: currentUsagePeriod() });
      expect(await checkUsageAlerts(workspaceId)).toBeNull();
      expect((await col<{ _id: string; alerts?: unknown }>('usage').findOne({ _id: workspaceId }))?.alerts).toBeUndefined();
    } finally {
      setMailSenderForTests(async (message) => {
        mail.push(message);
      });
    }
  });
});
