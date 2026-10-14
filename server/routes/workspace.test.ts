import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authAdmin, createUser, db, resetEmulators, signIn, startApi, type TestApi, type TestUser } from '../test/helpers';
import { setWorkspacePlan } from '../lib/plans';
import { isMailConfigured, setMailSenderForTests } from '../lib/mailer';

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

// First request provisions the caller's personal workspace, exactly as the app's first load does.
async function workspaceOf(user: TestUser) {
  const res = await api.call('GET', '/api/workspace', { token: user.token });
  expect(res.status).toBe(200);
  return res.body as { id: string; members: { uid: string; role: string }[]; myRole: string };
}

async function createProject(user: TestUser, title: string) {
  const res = await api.call('POST', '/api/projects', { token: user.token, body: { title } });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

// Teammates need a plan that includes them, so the inviter's workspace is put on Enterprise first.
async function invite(admin: TestUser, email: string, role = 'editor') {
  await setWorkspacePlan((await workspaceOf(admin)).id, 'enterprise');
  return api.call('POST', '/api/workspace/invites', { token: admin.token, body: { email, role } });
}

async function accept(user: TestUser, token: string) {
  return api.call('POST', '/api/invites/accept', { token: user.token, body: { token } });
}

describe('workspace invitations', () => {
  it('lets an existing user join only after they accept, and leaves their own projects where they were', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('invitee@team.test');
    const teamWs = await workspaceOf(admin);
    const inviteeWs = await workspaceOf(invitee);
    const personalProject = await createProject(invitee, 'Personal cut');

    const created = await invite(admin, 'Invitee@Team.test');
    expect(created.status).toBe(201);
    expect(created.body.invite.email).toBe('invitee@team.test');

    // Before accepting nothing about the invitee has changed.
    expect((await workspaceOf(invitee)).id).toBe(inviteeWs.id);
    expect((await workspaceOf(admin)).members).toHaveLength(1);

    const preview = await api.call('POST', '/api/invites/preview', { token: invitee.token, body: { token: created.body.token } });
    expect(preview.status).toBe(200);
    expect(preview.body.role).toBe('editor');

    const accepted = await accept(invitee, created.body.token);
    expect(accepted.status).toBe(200);
    expect(accepted.body.workspaceId).toBe(teamWs.id);
    expect((await workspaceOf(invitee)).id).toBe(teamWs.id);
    expect((await workspaceOf(admin)).members.map((m) => m.uid).sort()).toEqual([admin.uid, invitee.uid].sort());

    // The invitee's project was neither copied nor moved: it is still (only) in their own workspace.
    const oldProject = await db.collection('workspaces').doc(inviteeWs.id).collection('projects').doc(personalProject.id).get();
    expect(oldProject.exists).toBe(true);
    const copied = await db.collection('workspaces').doc(teamWs.id).collection('projects').doc(personalProject.id).get();
    expect(copied.exists).toBe(false);
    const adminProjects = await api.call('GET', '/api/projects', { token: admin.token });
    expect(adminProjects.body.map((p: { id: string }) => p.id)).not.toContain(personalProject.id);
  });

  it('never creates a login for an invited email and answers the same whether or not the email has an account', async () => {
    const admin = await createUser('admin@team.test');
    await createUser('exists@team.test');
    await workspaceOf(admin);

    const forExisting = await invite(admin, 'exists@team.test');
    const forUnknown = await invite(admin, 'nobody@team.test');
    expect(forExisting.status).toBe(201);
    expect(forUnknown.status).toBe(201);
    expect(Object.keys(forExisting.body).sort()).toEqual(Object.keys(forUnknown.body).sort());
    expect(Object.keys(forExisting.body.invite).sort()).toEqual(Object.keys(forUnknown.body.invite).sort());

    await expect(authAdmin.getUserByEmail('nobody@team.test')).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('retires the old direct-add endpoint without creating accounts or moving anyone', async () => {
    const admin = await createUser('admin@team.test');
    const victim = await createUser('victim@team.test');
    const victimWs = await workspaceOf(victim);
    await workspaceOf(admin);

    const res = await api.call('POST', '/api/workspace/members', {
      token: admin.token,
      body: { email: 'brand-new@team.test', password: 'hunter2hunter2', role: 'editor' },
    });
    expect(res.status).toBe(410);
    const again = await api.call('POST', '/api/workspace/members', { token: admin.token, body: { email: 'victim@team.test', role: 'editor' } });
    expect(again.status).toBe(410);

    await expect(authAdmin.getUserByEmail('brand-new@team.test')).rejects.toMatchObject({ code: 'auth/user-not-found' });
    expect((await workspaceOf(victim)).id).toBe(victimWs.id);
  });

  it('rejects the link for anyone signed in with a different email, without revealing who it was for', async () => {
    const admin = await createUser('admin@team.test');
    const intended = await createUser('intended@team.test');
    const other = await createUser('other@team.test');
    await workspaceOf(admin);
    const otherWs = await workspaceOf(other);
    const { body } = await invite(admin, intended.email);

    const preview = await api.call('POST', '/api/invites/preview', { token: other.token, body: { token: body.token } });
    const res = await accept(other, body.token);
    const bogus = await accept(other, 'not-a-real-token');
    expect(preview.status).toBe(404);
    expect(res.status).toBe(404);
    expect(bogus.status).toBe(404);
    expect(res.body.error.message).toBe(bogus.body.error.message);
    expect((await workspaceOf(other)).id).toBe(otherWs.id);

    // The intended person can still use it afterwards.
    expect((await accept(intended, body.token)).status).toBe(200);
  });

  it('refuses expired invitations', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('late@team.test');
    await workspaceOf(admin);
    const inviteeWs = await workspaceOf(invitee);
    const { body } = await invite(admin, invitee.email);
    await db.collection('invites').doc(body.invite.id).update({ expiresAt: new Date(Date.now() - 1000).toISOString() });

    const res = await accept(invitee, body.token);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITE_EXPIRED');
    expect((await workspaceOf(invitee)).id).toBe(inviteeWs.id);
  });

  it('makes accepting idempotent for the invitee and useless to anyone replaying the link', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('twice@team.test');
    const teamWs = await workspaceOf(admin);
    await workspaceOf(invitee);
    const { body } = await invite(admin, invitee.email);

    const [first, second] = await Promise.all([accept(invitee, body.token), accept(invitee, body.token)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await accept(invitee, body.token)).body.workspaceId).toBe(teamWs.id);
    const members = await db.collection('workspaces').doc(teamWs.id).collection('members').get();
    expect(members.size).toBe(2);

    // A second account that somehow holds the link still cannot use it.
    const replayer = await createUser('replayer@team.test');
    expect((await accept(replayer, body.token)).status).toBe(404);
  });

  it('keeps one live link per email: re-inviting revokes the earlier link', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('dup@team.test');
    await workspaceOf(admin);
    await workspaceOf(invitee);
    const first = await invite(admin, invitee.email);
    const second = await invite(admin, invitee.email, 'admin');
    expect(first.body.token).not.toBe(second.body.token);

    const pending = await api.call('GET', '/api/workspace/invites', { token: admin.token });
    expect(pending.body.invites).toHaveLength(1);
    expect(pending.body.invites[0].role).toBe('admin');

    expect((await accept(invitee, first.body.token)).status).toBe(404);
    const ok = await accept(invitee, second.body.token);
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('admin');
  });

  it('lets an admin withdraw an invitation, and only in their own workspace', async () => {
    const admin = await createUser('admin@team.test');
    const otherAdmin = await createUser('other-admin@team.test');
    const invitee = await createUser('withdrawn@team.test');
    await workspaceOf(admin);
    await workspaceOf(otherAdmin);
    await workspaceOf(invitee);
    const { body } = await invite(admin, invitee.email);

    const foreign = await api.call('DELETE', `/api/workspace/invites/${body.invite.id}`, { token: otherAdmin.token });
    expect(foreign.status).toBe(400);
    const own = await api.call('DELETE', `/api/workspace/invites/${body.invite.id}`, { token: admin.token });
    expect(own.status).toBe(204);
    expect((await accept(invitee, body.token)).status).toBe(404);
  });

  it('stops an attacker from reaching a victim: inviting changes nothing until the victim accepts, and never exposes their projects', async () => {
    const attacker = await createUser('attacker@evil.test');
    const victim = await createUser('victim@corp.test');
    const attackerWs = await workspaceOf(attacker);
    const victimWs = await workspaceOf(victim);
    const secret = await createProject(victim, 'Confidential launch video');

    const res = await invite(attacker, victim.email, 'editor');
    expect(res.status).toBe(201);

    expect((await workspaceOf(victim)).id).toBe(victimWs.id);
    const attackerList = await api.call('GET', '/api/projects', { token: attacker.token });
    expect(attackerList.body.map((p: { id: string }) => p.id)).not.toContain(secret.id);
    expect((await api.call('GET', `/api/projects/${secret.id}`, { token: attacker.token })).status).toBe(404);
    expect((await api.call('PATCH', `/api/projects/${secret.id}`, { token: attacker.token, body: { title: 'pwned' } })).status).toBe(404);
    expect((await api.call('DELETE', `/api/projects/${secret.id}`, { token: attacker.token })).status).toBe(404);
    const stillThere = await db.collection('workspaces').doc(victimWs.id).collection('projects').doc(secret.id).get();
    expect(stillThere.get('title')).toBe('Confidential launch video');
    expect((await db.collection('workspaces').doc(attackerWs.id).collection('members').get()).size).toBe(1);
  });

  it('only lets admins invite', async () => {
    const admin = await createUser('admin@team.test');
    const editor = await createUser('editor@team.test');
    await workspaceOf(admin);
    await workspaceOf(editor);
    const { body } = await invite(admin, editor.email, 'editor');
    await accept(editor, body.token);

    const res = await invite(editor, 'someone@team.test');
    expect(res.status).toBe(403);
    expect((await api.call('GET', '/api/workspace/invites', { token: editor.token })).status).toBe(403);
  });

  it('refuses to pull someone out of another team they belong to', async () => {
    const adminA = await createUser('a@team.test');
    const adminB = await createUser('b@team.test');
    const member = await createUser('member@team.test');
    const wsA = await workspaceOf(adminA);
    await workspaceOf(adminB);
    await workspaceOf(member);
    await accept(member, (await invite(adminA, member.email)).body.token);

    const res = await accept(member, (await invite(adminB, member.email)).body.token);
    expect(res.status).toBe(409);
    expect((await workspaceOf(member)).id).toBe(wsA.id);
  });

  it('locks a removed member out of Dubly for good, including their own earlier workspace', async () => {
    const admin = await createUser('admin@team.test');
    const member = await createUser('leaver@team.test');
    await workspaceOf(admin);
    await workspaceOf(member);
    await createProject(member, 'Mine');
    const link = await invite(admin, member.email);
    await accept(member, link.body.token);

    expect((await api.call('DELETE', `/api/workspace/members/${member.uid}`, { token: admin.token })).status).toBe(204);
    // The very next request is refused, with the session they still hold (revocation is recorded to the second, so a token issued in the
    // same second is turned away by the workspace check instead of the session check).
    for (const path of ['/api/workspace', '/api/projects', '/api/bootstrap', '/api/usage']) {
      const res = await api.call('GET', path, { token: member.token });
      expect([401, 403], path).toContain(res.status);
      if (res.status === 403) expect(res.body.error.code).toBe('NO_WORKSPACE');
    }
    // ...a brand-new sign-in gets nowhere either, with no workspace quietly made for them...
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = await signIn(member.email);
    expect((await api.call('GET', '/api/projects', { token: fresh })).status).toBe(403);
    // ...and the link they used to join is spent. Checked with the fresh session: the old one may already be refused as revoked (401).
    expect((await api.call('POST', '/api/invites/accept', { token: fresh, body: { token: link.body.token } })).status).toBe(404);
    expect((await db.collection('workspaceMembership').doc(member.uid).get()).get('workspaceId')).toBeNull();
  });

  it('signs a removed member out everywhere at once, and deletes a login Dubly made for the invitation', async () => {
    const admin = await createUser('admin@team.test');
    const existing = await createUser('existing@team.test');
    await workspaceOf(admin);
    const teamId = (await workspaceOf(admin)).id;
    await accept(existing, (await invite(admin, existing.email)).body.token);

    const created = (await invite(admin, 'brand-new@team.test')).body;
    await api.call('POST', '/api/invite-signup/claim', { body: { token: created.token, password: 'a-good-password' } });
    const newcomer = await signIn('brand-new@team.test', 'a-good-password');
    await api.call('POST', '/api/invites/accept', { token: newcomer, body: { token: created.token } });
    const newcomerUid = (await authAdmin.getUserByEmail('brand-new@team.test')).uid;
    expect((await workspaceOf({ token: newcomer } as TestUser)).id).toBe(teamId);

    // Revocation is recorded to the second, so a session older than that is what it is checked against.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await api.call('DELETE', `/api/workspace/members/${existing.uid}`, { token: admin.token })).status).toBe(204);
    expect((await api.call('DELETE', `/api/workspace/members/${newcomerUid}`, { token: admin.token })).status).toBe(204);

    // A login that pre-existed (shared with ScatterStudio) survives, but its sessions are gone.
    expect((await api.call('GET', '/api/settings', { token: existing.token })).status).toBe(401);
    expect(await authAdmin.getUser(existing.uid)).toBeTruthy();
    // The one made from the invitation is gone altogether.
    await expect(authAdmin.getUser(newcomerUid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    expect((await api.call('GET', '/api/settings', { token: newcomer })).status).toBe(401);
    await expect(signIn('brand-new@team.test', 'a-good-password')).rejects.toBeTruthy();
  });

  it('lets an admin invite a removed person back, and never remove themselves', async () => {
    const admin = await createUser('admin@team.test');
    const member = await createUser('boomerang@team.test');
    const teamWs = await workspaceOf(admin);
    await workspaceOf(member);
    await accept(member, (await invite(admin, member.email)).body.token);
    await api.call('DELETE', `/api/workspace/members/${member.uid}`, { token: admin.token });
    // Their old sessions were ended, so coming back means signing in again (a second later, as revocation is recorded to the second).
    await new Promise((r) => setTimeout(r, 1100));
    const back = { ...member, token: await signIn(member.email) };
    expect((await api.call('GET', '/api/projects', { token: back.token })).status).toBe(403);

    const again = await api.call('POST', '/api/workspace/invites', { token: admin.token, body: { email: member.email, role: 'editor' } });
    expect((await accept(back, again.body.token)).status).toBe(200);
    expect((await workspaceOf(back)).id).toBe(teamWs.id);

    const self = await api.call('DELETE', `/api/workspace/members/${admin.uid}`, { token: admin.token });
    expect(self.status).toBe(400);
    expect((await workspaceOf(admin)).members).toHaveLength(2);
  });

  it('rejects malformed invite input', async () => {
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    expect((await invite(admin, 'not-an-email')).status).toBe(400);
    expect((await invite(admin, 'ok@team.test', 'owner')).status).toBe(400);
    expect((await invite(admin, admin.email)).status).toBe(400);
  });

  it('requires a signed-in caller for every invite endpoint', async () => {
    expect((await api.call('POST', '/api/invites/accept', { body: { token: 'x' } })).status).toBe(401);
    expect((await api.call('POST', '/api/workspace/invites', { body: { email: 'a@b.co', role: 'editor' } })).status).toBe(401);
  });
});

describe('plans and teammates', () => {
  it('keeps a Starter workspace to one person', async () => {
    const admin = await createUser('solo@team.test');
    await workspaceOf(admin);
    const res = await api.call('POST', '/api/workspace/invites', { token: admin.token, body: { email: 'friend@team.test', role: 'editor' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_NO_TEAM');
    expect((await db.collection('invites').get()).size).toBe(0);
  });

  it('stops a link made on Enterprise from working once the workspace is back on Starter', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('invitee@team.test');
    const teamWs = await workspaceOf(admin);
    await workspaceOf(invitee);
    const created = await invite(admin, invitee.email);
    expect(created.status).toBe(201);

    await setWorkspacePlan(teamWs.id, 'starter');
    const res = await accept(invitee, created.body.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PLAN_NO_TEAM');
    expect((await workspaceOf(admin)).members).toHaveLength(1);
  });
});

describe('invitation emails', () => {
  type Sent = { to: string; subject: string; text: string; html: string; from: string };
  let sent: Sent[] = [];
  afterAll(() => setMailSenderForTests(null));

  it('emails the invitee their link, with names escaped in the HTML', async () => {
    sent = [];
    setMailSenderForTests(async (message) => {
      sent.push(message as Sent);
    });
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    expect((await api.call('PATCH', '/api/workspace', { token: admin.token, body: { name: '<b>Acme</b> Studio' } })).status).toBe(200);

    const created = await invite(admin, 'new.person@team.test');
    expect(created.status).toBe(201);
    expect(created.body.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('new.person@team.test');
    expect(sent[0].subject).toContain('<b>Acme</b> Studio');
    expect(sent[0].text).toContain(`?invite=${encodeURIComponent(created.body.token)}`);
    expect(sent[0].html).toContain('&lt;b&gt;Acme&lt;/b&gt; Studio');
    expect(sent[0].html).not.toContain('<b>Acme</b>');
  });

  it('still creates the invitation, with its link, when the email fails or is not set up', async () => {
    setMailSenderForTests(async () => {
      throw new Error('SMTP down');
    });
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    const failed = await invite(admin, 'one@team.test');
    expect(failed.status).toBe(201);
    expect(failed.body.emailed).toBe(false);
    expect(failed.body.token).toBeTruthy();

    setMailSenderForTests(null);
    // Checked before inviting, so a leaked real SMTP setting fails here instead of sending mail.
    expect(isMailConfigured()).toBe(false);
    const unconfigured = await invite(admin, 'two@team.test');
    expect(unconfigured.status).toBe(201);
    expect(unconfigured.body.emailed).toBe(false);
  });
});

describe('invite sign-up for people with no account', () => {
  const lookup = (token: string) => api.call('POST', '/api/invite-signup/lookup', { body: { token } });
  const claim = (token: string, password: string) => api.call('POST', '/api/invite-signup/claim', { body: { token, password } });

  it('lets a new invitee set a password from the link, sign in, and join', async () => {
    const admin = await createUser('admin@team.test');
    const teamWs = await workspaceOf(admin);
    const { body } = await invite(admin, 'Newbie@Team.test');

    const info = await lookup(body.token);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ email: 'newbie@team.test', accountExists: false, role: 'editor' });

    expect((await claim(body.token, 'short')).status).toBe(400);
    const created = await claim(body.token, 'a-good-password');
    expect(created.status).toBe(201);
    expect(created.body.email).toBe('newbie@team.test');

    const token = await signIn('newbie@team.test', 'a-good-password');
    const joined = await api.call('POST', '/api/invites/accept', { token, body: { token: body.token } });
    expect(joined.status).toBe(200);
    expect(joined.body.workspaceId).toBe(teamWs.id);
  });

  it('never creates or changes an account that already exists', async () => {
    const admin = await createUser('admin@team.test');
    const existing = await createUser('existing@team.test', 'original-password');
    await workspaceOf(admin);
    const { body } = await invite(admin, existing.email);

    expect((await lookup(body.token)).body.accountExists).toBe(true);
    const res = await claim(body.token, 'attacker-password');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_EXISTS');
    // The original password still works; the attacker's does not.
    await expect(signIn(existing.email, 'original-password')).resolves.toBeTruthy();
    await expect(signIn(existing.email, 'attacker-password')).rejects.toBeTruthy();
  });

  it('refuses unknown, revoked and expired links, and a second claim', async () => {
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    expect((await lookup('not-a-real-token-at-all')).status).toBe(404);

    const revoked = (await invite(admin, 'revoked@team.test')).body;
    await api.call('DELETE', `/api/workspace/invites/${revoked.invite.id}`, { token: admin.token });
    expect((await claim(revoked.token, 'a-good-password')).status).toBe(404);
    await expect(authAdmin.getUserByEmail('revoked@team.test')).rejects.toMatchObject({ code: 'auth/user-not-found' });

    const expired = (await invite(admin, 'expired@team.test')).body;
    await db.collection('invites').doc(expired.invite.id).update({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await claim(expired.token, 'a-good-password')).status).toBe(410);

    const once = (await invite(admin, 'once@team.test')).body;
    expect((await claim(once.token, 'a-good-password')).status).toBe(201);
    expect((await claim(once.token, 'another-password')).status).toBe(409);
  });
});

describe('people who have been invited but have not joined', () => {
  const claim = (token: string, password: string) => api.call('POST', '/api/invite-signup/claim', { body: { token, password } });
  const mine = (token: string) => api.call('GET', '/api/invites/mine', { token });
  const acceptById = (token: string, inviteId: string) => api.call('POST', '/api/invites/accept-by-id', { token, body: { inviteId } });

  it('gives a new invitee nothing, and no Starter workspace, until they join', async () => {
    const admin = await createUser('admin@team.test');
    const teamWs = await workspaceOf(admin);
    const { body } = await invite(admin, 'newbie@team.test');
    expect((await claim(body.token, 'a-good-password')).status).toBe(201);
    const token = await signIn('newbie@team.test', 'a-good-password');

    for (const path of ['/api/workspace', '/api/projects', '/api/bootstrap', '/api/usage']) {
      const res = await api.call('GET', path, { token });
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('AWAITING_INVITE');
    }
    expect((await api.call('POST', '/api/projects', { token, body: { title: 'sneaky' } })).status).toBe(403);
    // Declining the dialog changes nothing: still no workspace of their own appears.
    expect((await db.collection('workspaces').get()).size).toBe(1);

    // Their invitation is waiting in their notifications, and joining from there needs no link.
    const waiting = await mine(token);
    expect(waiting.body.invites).toHaveLength(1);
    expect(waiting.body.invites[0]).toMatchObject({ id: body.invite.id, role: 'editor' });
    const joined = await acceptById(token, body.invite.id);
    expect(joined.status).toBe(200);
    expect(joined.body.workspaceId).toBe(teamWs.id);
    expect((await workspaceOf({ token } as TestUser)).id).toBe(teamWs.id);
    expect((await mine(token)).body.invites).toHaveLength(0);
  });

  it('keeps a login made from an invitation without a workspace even after the invitation lapses', async () => {
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    const { body } = await invite(admin, 'lapsed@team.test');
    await claim(body.token, 'a-good-password');
    const token = await signIn('lapsed@team.test', 'a-good-password');
    await db.collection('invites').doc(body.invite.id).update({ expiresAt: new Date(Date.now() - 1000).toISOString() });

    const res = await api.call('GET', '/api/projects', { token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AWAITING_INVITE');
    expect((await mine(token)).body.invites).toHaveLength(0);
    expect((await db.collection('workspaces').get()).size).toBe(1);
  });

  it('holds an existing login that has never used Dubly until it answers its invitation', async () => {
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    const scatterStudioUser = await createUser('studio@team.test');
    const { body } = await invite(admin, scatterStudioUser.email);

    const res = await api.call('GET', '/api/projects', { token: scatterStudioUser.token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AWAITING_INVITE');
    expect((await acceptById(scatterStudioUser.token, body.invite.id)).status).toBe(200);
  });

  it('leaves someone who already has a workspace of their own where they are, with the invitation in their notifications', async () => {
    const admin = await createUser('admin@team.test');
    const invitee = await createUser('has-own@team.test');
    await workspaceOf(admin);
    const own = await workspaceOf(invitee);
    const { body } = await invite(admin, invitee.email);

    expect((await workspaceOf(invitee)).id).toBe(own.id);
    expect((await mine(invitee.token)).body.invites.map((i: { id: string }) => i.id)).toEqual([body.invite.id]);
  });

  it('only offers and accepts invitations by id for an address that is verified and is the one invited', async () => {
    const admin = await createUser('admin@team.test');
    await workspaceOf(admin);
    const unverified = await createUser('typed-in@team.test', 'correct-horse-battery', false);
    const bystander = await createUser('bystander@team.test');
    const { body } = await invite(admin, unverified.email);

    // Anyone can type an address into an account; without the secret link that must not be enough.
    expect((await mine(unverified.token)).body.invites).toEqual([]);
    const refused = await acceptById(unverified.token, body.invite.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    // A verified account for another address learns nothing and cannot join.
    expect((await mine(bystander.token)).body.invites).toEqual([]);
    expect((await acceptById(bystander.token, body.invite.id)).status).toBe(404);
    expect((await acceptById(bystander.token, 'not-an-id')).status).toBe(400);
    // The emailed link still works for the unverified account, as it always did.
    expect((await accept(unverified, body.token)).status).toBe(200);
  });

  it('never lets a login made from one team’s link collect another team’s invitation to that address', async () => {
    // An admin holds every link they create, so a login made from it proves nothing about who reads the inbox.
    const attacker = await createUser('admin@attacker.test');
    await workspaceOf(attacker);
    const victimAdmin = await createUser('admin@victim.test');
    const victimWs = await workspaceOf(victimAdmin);
    const bait = (await invite(attacker, 'newhire@victim.test')).body;
    expect((await claim(bait.token, 'attacker-chosen-password')).status).toBe(201);
    const login = await authAdmin.getUserByEmail('newhire@victim.test');
    expect(login.emailVerified).toBe(false);
    const token = await signIn('newhire@victim.test', 'attacker-chosen-password');

    const real = (await invite(victimAdmin, 'newhire@victim.test')).body;
    expect((await mine(token)).body.invites.map((i: { id: string }) => i.id)).toEqual([bait.invite.id]);
    const refused = await acceptById(token, real.invite.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await db.collection('workspaces').doc(victimWs.id).collection('members').doc(login.uid).get()).exists).toBe(false);
  });
});

describe('name and picture', () => {
  // A tiny JPEG: just enough bytes to pass the signature check.
  const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`;

  it('lets a member set their name and picture, shows them to the team, and lets them remove the picture', async () => {
    const admin = await createUser('admin@team.test');
    const editor = await createUser('editor@team.test');
    await workspaceOf(admin);
    await workspaceOf(editor);
    await accept(editor, (await invite(admin, editor.email)).body.token);

    const saved = await api.call('PATCH', '/api/profile', { token: editor.token, body: { name: '  Priya Nair  ', avatar: JPEG } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Priya Nair', avatar: JPEG });

    const team = await api.call('GET', '/api/workspace', { token: admin.token });
    expect(team.body.members.find((m: { uid: string }) => m.uid === editor.uid)).toMatchObject({ name: 'Priya Nair', avatar: JPEG });
    expect((await api.call('GET', '/api/bootstrap', { token: editor.token })).body.profile).toMatchObject({ name: 'Priya Nair', avatar: JPEG });

    const cleared = await api.call('PATCH', '/api/profile', { token: editor.token, body: { avatar: null } });
    expect(cleared.body).toMatchObject({ name: 'Priya Nair', avatar: null });
    const after = await api.call('GET', '/api/workspace', { token: admin.token });
    expect(after.body.members.find((m: { uid: string }) => m.uid === editor.uid).avatar).toBeUndefined();
  });

  it('never touches the ScatterStudio profile, and refuses empty, oversized and fake-image input', async () => {
    const user = await createUser('profile@team.test');
    await db.collection('users').doc(user.uid).set({ name: 'Studio Name', role: 'editor', workspace: 'x', api_key: 'secret' });
    await workspaceOf(user);

    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: { name: 'Dubly Name' } })).status).toBe(200);
    expect((await db.collection('users').doc(user.uid).get()).data()).toEqual({ name: 'Studio Name', role: 'editor', workspace: 'x', api_key: 'secret' });

    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: {} })).status).toBe(400);
    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: { name: '   ' } })).status).toBe(400);
    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: { avatar: 'https://evil.test/x.png' } })).status).toBe(400);
    const fake = `data:image/jpeg;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: { avatar: fake } })).status).toBe(400);
    const huge = `data:image/jpeg;base64,${'A'.repeat(70_000)}`;
    expect((await api.call('PATCH', '/api/profile', { token: user.token, body: { avatar: huge } })).status).toBe(400);
    expect((await api.call('PATCH', '/api/profile', { body: { name: 'x' } })).status).toBe(401);
  });
});
