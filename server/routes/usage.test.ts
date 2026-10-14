import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { env } from '../lib/env';
import { clearPlanCaches, setWorkspacePlan } from '../lib/plans';
import { setMailSenderForTests, type MailMessage } from '../lib/mailer';
import { startDubJob } from '../lib/jobs';
import { QuotaExceededError } from '../lib/projectRepo';

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await resetEmulators();
});
afterEach(() => {
  env.newWorkspacePlan = 'starter';
  env.quotaRequestTo = '';
  setMailSenderForTests(null);
});

const usageOf = async (user: TestUser) => (await api.call('GET', '/api/usage', { token: user.token })).body;
const workspaceIdOf = async (user: TestUser) => (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
const newProject = async (user: TestUser) => (await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Clip' } })).body.id as string;

describe('the Free plan', () => {
  it('starts a new workspace on five free minutes that never refresh, and leaves older workspaces on Starter', async () => {
    env.newWorkspacePlan = 'free';
    const user = await createUser('new@free.test');
    const usage = await usageOf(user);
    expect(usage).toMatchObject({ planId: 'free', activePlan: 'Free', minutesLimit: 5, renewsMonthly: false, paidExtrasAllowed: false, teamInvites: false });
    expect(usage.resetsAt).toBeUndefined();

    // A workspace made before Free existed has no plan recorded, and keeps its monthly Starter allowance.
    await db.collection('workspaces').doc(await workspaceIdOf(user)).update({ plan: FieldValue.delete() });
    clearPlanCaches();
    const legacy = await usageOf(user);
    expect(legacy).toMatchObject({ planId: 'starter', minutesLimit: 50, renewsMonthly: true });
    expect(legacy.resetsAt).toBeTruthy();
  });

  it('charges the free minutes once, refuses beyond them with a pointer to a quota request, and a bigger plan starts afresh', async () => {
    env.newWorkspacePlan = 'free';
    const user = await createUser('trial@free.test');
    const workspaceId = await workspaceIdOf(user);
    const [first, second] = [await newProject(user), await newProject(user)];

    await startDubJob({ workspaceId, projectId: first, userId: user.uid, languages: ['hi'], minutes: 4 });
    const usageDoc = await db.collection('workspaces').doc(workspaceId).collection('meta').doc('usage').get();
    // Kept under a period that never rolls over, so the 1st of the month gives nothing back.
    expect(usageDoc.get('usagePeriod')).toBe('lifetime');
    expect((await usageOf(user)).minutesDubbed).toBe(4);

    const refused = startDubJob({ workspaceId, projectId: second, userId: user.uid, languages: ['hi'], minutes: 2 });
    await expect(refused).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(refused).rejects.toThrow(/free min.*quota increase/);

    // Once ScatterPie moves the workspace to a monthly plan, the month's allowance is whole.
    await setWorkspacePlan(workspaceId, 'starter');
    expect(await usageOf(user)).toMatchObject({ planId: 'starter', minutesDubbed: 0, minutesLimit: 50, renewsMonthly: true });
  });
});

describe('quota increase requests', () => {
  const request = (user: TestUser | null, body: Record<string, unknown>) =>
    api.call('POST', '/api/usage/quota-request', { token: user?.token, body });
  const valid = { name: 'Asha', company: 'Acme', plan: 'enterprise', minutesPerMonth: 300, message: 'Weekly training videos into Hindi.' };

  it('records the request against the caller’s own account and workspace and emails the team, escaped', async () => {
    env.quotaRequestTo = 'sales@scatterpie.test';
    const sent: MailMessage[] = [];
    setMailSenderForTests(async (message) => {
      sent.push(message);
    });
    const user = await createUser('asker@team.test');
    const workspaceId = await workspaceIdOf(user);

    // Who is asking comes from the session: an email or workspace in the body is ignored.
    const res = await request(user, { ...valid, name: 'Asha <b>\r\nBcc: x@evil.test', email: 'spoof@evil.test', workspaceId: 'ws-someone-else' });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);
    const stored = (await db.collection('dublyQuotaRequests').doc(res.body.id).get()).data()!;
    expect(stored).toMatchObject({ email: 'asker@team.test', uid: user.uid, workspaceId, plan: 'enterprise', minutesPerMonth: 300, currentPlan: 'Starter', status: 'open' });

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('sales@scatterpie.test');
    expect(sent[0].subject).not.toMatch(/[\r\n]/);
    expect(sent[0].html).toContain('Asha &lt;b&gt;');
    expect(sent[0].html).not.toContain('<b>');
    expect(sent[0].text).toContain('asker@team.test');
  });

  it('keeps the request when no mailbox is set up', async () => {
    const user = await createUser('quiet@team.test');
    const res = await request(user, valid);
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(false);
    expect((await db.collection('dublyQuotaRequests').doc(res.body.id).get()).exists).toBe(true);
  });

  it('refuses unsigned callers, bad input and more than five requests a day', async () => {
    expect((await request(null, valid)).status).toBe(401);
    const careless = await createUser('careless@team.test');
    for (const bad of [{ ...valid, plan: 'platinum' }, { ...valid, minutesPerMonth: 0 }, { ...valid, message: '' }, { ...valid, phone: '<script>' }]) {
      expect((await request(careless, bad)).status).toBe(400);
    }
    expect((await db.collection('dublyQuotaRequests').get()).size).toBe(0);

    const user = await createUser('busy@team.test');
    for (let i = 0; i < 5; i++) expect((await request(user, valid)).status).toBe(201);
    const limited = await request(user, valid);
    expect(limited.status).toBe(429);
    expect((await db.collection('dublyQuotaRequests').get()).size).toBe(5);
  });
});
