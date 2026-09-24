import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authAdmin, createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';

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

async function invite(admin: TestUser, email: string, role = 'editor') {
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

  it('returns a removed member to their own workspace and projects', async () => {
    const admin = await createUser('admin@team.test');
    const member = await createUser('leaver@team.test');
    await workspaceOf(admin);
    const ownWs = await workspaceOf(member);
    const own = await createProject(member, 'Mine');
    await accept(member, (await invite(admin, member.email)).body.token);

    expect((await api.call('DELETE', `/api/workspace/members/${member.uid}`, { token: admin.token })).status).toBe(204);
    expect((await workspaceOf(member)).id).toBe(ownWs.id);
    const list = await api.call('GET', '/api/projects', { token: member.token });
    expect(list.body.map((p: { id: string }) => p.id)).toContain(own.id);
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
