import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authAdmin, db } from './firebaseAdmin';
import { planForWorkspace } from './plans';

// A Dubly workspace is a team: projects and the monthly minute allowance belong to it, and each member is an admin or an editor.
export type WorkspaceRole = 'admin' | 'editor';

export interface WorkspaceMember {
  uid: string;
  email: string;
  name: string;
  role: WorkspaceRole;
  addedAt: string;
  addedBy: string;
}

export interface Membership {
  workspaceId: string;
  role: WorkspaceRole;
}

export class WorkspaceAccessError extends Error {}
export class WorkspaceRequestError extends Error {}

const workspaceDoc = (id: string) => db.collection('workspaces').doc(id);
const membersCol = (id: string) => workspaceDoc(id).collection('members');
// uid -> the one workspace that user belongs to; `workspaceId: null` marks someone an admin removed.
const pointerDoc = (uid: string) => db.collection('workspaceMembership').doc(uid);

// Every API request resolves membership (the UI polls once a second), so it is cached briefly and cleared on any change.
const CACHE_MS = 15_000;
const cache = new Map<string, { value: Membership; at: number }>();
const pendingCreates = new Map<string, Promise<Membership>>();

export function invalidateMembership(uid: string): void {
  cache.delete(uid);
}

export function clearMembershipCache(): void {
  cache.clear();
}

export async function resolveMembership(uid: string): Promise<Membership> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const pointer = await pointerDoc(uid).get();
  let membership: Membership;
  if (pointer.exists) {
    const workspaceId = pointer.get('workspaceId') as string | null;
    if (!workspaceId) throw new WorkspaceAccessError('You were removed from your Dubly workspace. Ask its admin to add you again.');
    const member = await membersCol(workspaceId).doc(uid).get();
    if (!member.exists) throw new WorkspaceAccessError('You are not a member of this workspace any more. Ask its admin to add you again.');
    membership = { workspaceId, role: member.get('role') as WorkspaceRole };
  } else {
    // Concurrent first requests (the app loads several things at once) share one creation instead of racing.
    let pending = pendingCreates.get(uid);
    if (!pending) {
      pending = createPersonalWorkspace(uid).finally(() => pendingCreates.delete(uid));
      pendingCreates.set(uid, pending);
    }
    membership = await pending;
  }
  cache.set(uid, { value: membership, at: Date.now() });
  return membership;
}

// The first time someone uses Dubly they get their own workspace as its admin, with their existing projects and this month's usage copied in.
async function createPersonalWorkspace(uid: string): Promise<Membership> {
  const user = await authAdmin.getUser(uid);
  const profile = (await db.collection('users').doc(uid).get()).data() || {};
  const name = (typeof profile.name === 'string' && profile.name) || user.displayName || user.email?.split('@')[0] || 'Member';
  const workspaceId = `ws-${randomUUID()}`;
  const now = new Date().toISOString();

  const created = await db.runTransaction(async (tx) => {
    const pointer = await tx.get(pointerDoc(uid));
    if (pointer.exists) return null;
    tx.set(workspaceDoc(workspaceId), {
      name: (typeof profile.workspace === 'string' && profile.workspace) || `${name}'s workspace`,
      createdAt: now,
      createdBy: uid,
    });
    tx.set(membersCol(workspaceId).doc(uid), {
      uid,
      email: user.email || '',
      name,
      role: 'admin',
      addedAt: now,
      addedBy: uid,
    } satisfies WorkspaceMember);
    tx.set(pointerDoc(uid), { workspaceId });
    return true;
  });
  if (!created) return resolveMembership(uid);

  // Copies, not moves: the originals stay where they were as a fallback.
  const oldProjects = await db.collection('users').doc(uid).collection('projects').get();
  await Promise.all(oldProjects.docs.map((d) => workspaceDoc(workspaceId).collection('projects').doc(d.id).set(d.data())));
  const oldUsage = await db.collection('users').doc(uid).collection('meta').doc('usage').get();
  if (oldUsage.exists) await workspaceDoc(workspaceId).collection('meta').doc('usage').set(oldUsage.data()!);
  console.log(`[workspaces] created ${workspaceId} for ${user.email}, copied ${oldProjects.size} projects`);
  return { workspaceId, role: 'admin' };
}

export async function getWorkspace(workspaceId: string): Promise<{ id: string; name: string; members: WorkspaceMember[] }> {
  const [ws, members] = await Promise.all([workspaceDoc(workspaceId).get(), membersCol(workspaceId).get()]);
  return {
    id: workspaceId,
    name: (ws.get('name') as string) || 'Workspace',
    members: members.docs
      .map((d) => d.data() as WorkspaceMember)
      .sort((a, b) => (a.role === b.role ? a.addedAt.localeCompare(b.addedAt) : a.role === 'admin' ? -1 : 1)),
  };
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new WorkspaceRequestError('Workspace name cannot be empty');
  await workspaceDoc(workspaceId).set({ name: trimmed }, { merge: true });
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

// Stored at invites/{sha256(token)}: the raw token only ever exists in the link the admin sends, so a database read cannot be replayed as an invite.
export interface StoredInvite {
  id: string;
  workspaceId: string;
  workspaceName: string;
  invitedEmail: string;
  role: WorkspaceRole;
  invitedBy: string;
  invitedByName: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
  revokedAt?: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const invitesCol = () => db.collection('invites');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Every "this invitation can't be used by you" case answers the same way, so a link cannot be probed for whom it was meant.
export const INVITE_NOT_FOUND = 'This invitation link is not valid for the account you are signed in with.';

function toSummary(invite: StoredInvite): InviteSummary {
  return {
    id: invite.id,
    email: invite.invitedEmail,
    role: invite.role,
    invitedByName: invite.invitedByName,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}

async function displayNameFor(uid: string): Promise<string> {
  const [user, profile] = await Promise.all([authAdmin.getUser(uid), db.collection('users').doc(uid).get()]);
  const profileName = profile.get('name');
  return (typeof profileName === 'string' && profileName) || user.displayName || user.email?.split('@')[0] || 'Member';
}

// Invites an email without looking anyone up, creating or moving anything; the response never reveals whether the email has a login.
export async function createInvite(
  workspaceId: string,
  actorUid: string,
  input: { email: string; role: WorkspaceRole }
): Promise<{ invite: InviteSummary; token: string }> {
  await assertPlanAllowsTeam(workspaceId);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new WorkspaceRequestError('Enter a valid email address');
  if (input.role !== 'admin' && input.role !== 'editor') throw new WorkspaceRequestError('Role must be admin or editor');

  // Checked against this workspace's own member list, which the admin can already see, so it reveals nothing about other accounts.
  const existingMember = await membersCol(workspaceId).where('email', '==', email).limit(1).get();
  if (!existingMember.empty) throw new WorkspaceRequestError(`${email} is already in this workspace`);

  const [ws, invitedByName] = await Promise.all([workspaceDoc(workspaceId).get(), displayNameFor(actorUid)]);
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const invite: StoredInvite = {
    id: hashToken(token),
    workspaceId,
    workspaceName: (ws.get('name') as string) || 'Workspace',
    invitedEmail: email,
    role: input.role,
    invitedBy: actorUid,
    invitedByName,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };

  await db.runTransaction(async (tx) => {
    const earlier = await tx.get(
      invitesCol().where('workspaceId', '==', workspaceId).where('invitedEmail', '==', email).where('status', '==', 'pending')
    );
    // One live link per person: re-inviting (lost link, different role) revokes the previous one.
    earlier.docs.forEach((d) => tx.update(d.ref, { status: 'revoked', revokedAt: invite.createdAt }));
    tx.set(invitesCol().doc(invite.id), invite);
  });
  return { invite: toSummary(invite), token };
}

export async function listPendingInvites(workspaceId: string): Promise<InviteSummary[]> {
  const snap = await invitesCol().where('workspaceId', '==', workspaceId).where('status', '==', 'pending').get();
  const now = Date.now();
  return snap.docs
    .map((d) => d.data() as StoredInvite)
    .filter((inv) => new Date(inv.expiresAt).getTime() > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSummary);
}

export async function revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = invitesCol().doc(inviteId);
    const snap = await tx.get(ref);
    // Another workspace's invite looks exactly like a missing one.
    if (!snap.exists || snap.get('workspaceId') !== workspaceId || snap.get('status') !== 'pending') {
      throw new WorkspaceRequestError('That invitation no longer exists');
    }
    tx.update(ref, { status: 'revoked', revokedAt: new Date().toISOString() });
  });
}

// Refuses when the workspace's plan is for one person; `joining` words it for the invitee rather than the admin.
async function assertPlanAllowsTeam(workspaceId: string, joining = false): Promise<void> {
  const plan = await planForWorkspace(workspaceId);
  if (plan.teamInvites) return;
  throw new InviteError(
    403,
    'PLAN_NO_TEAM',
    joining
      ? `This workspace is on the ${plan.name} plan, which does not include teammates, so the invitation can't be used. Ask its admin about the Enterprise plan.`
      : `The ${plan.name} plan is for one person. Move to the Enterprise plan to add teammates.`
  );
}

export class InviteError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function usableInvite(snap: FirebaseFirestore.DocumentSnapshot, callerEmail: string | undefined): StoredInvite {
  const invite = snap.exists ? (snap.data() as StoredInvite) : null;
  if (!invite || !callerEmail || invite.invitedEmail !== callerEmail.trim().toLowerCase() || invite.status === 'revoked') {
    throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_NOT_FOUND);
  }
  return invite;
}

// What the accept screen shows; only answers for the account the invitation was addressed to.
export async function previewInvite(
  token: string,
  callerEmail: string | undefined
): Promise<{ workspaceName: string; role: WorkspaceRole; invitedByName: string; expiresAt: string; status: InviteStatus }> {
  const invite = usableInvite(await invitesCol().doc(hashToken(String(token))).get(), callerEmail);
  return {
    workspaceName: invite.workspaceName,
    role: invite.role,
    invitedByName: invite.invitedByName,
    expiresAt: invite.expiresAt,
    status: invite.status,
  };
}

// Joins the caller to the invite's workspace, leaving their own workspace and projects in place to return to; accepting twice is a no-op.
export async function acceptInvite(token: string, uid: string, callerEmail: string | undefined): Promise<Membership> {
  const ref = invitesCol().doc(hashToken(String(token)));
  const name = await displayNameFor(uid);
  // Whether the caller's current workspace is a shared team is a policy check read up front, keeping the transaction to single-document reads.
  const before = await pointerDoc(uid).get();
  const beforeWorkspace = before.exists ? (before.get('workspaceId') as string | null) : null;
  const inSharedTeam = beforeWorkspace
    ? (await membersCol(beforeWorkspace).limit(2).get()).docs.some((d) => d.id !== uid)
    : false;
  const result = await db.runTransaction(async (tx) => {
    const invite = usableInvite(await tx.get(ref), callerEmail);
    if (invite.status === 'accepted') {
      if (invite.acceptedBy === uid) return { workspaceId: invite.workspaceId, role: invite.role };
      throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_NOT_FOUND);
    }
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw new InviteError(410, 'INVITE_EXPIRED', 'This invitation has expired. Ask the workspace admin for a new link.');
    }
    // A link made before the workspace moved to a plan without teammates must not let anyone in.
    await assertPlanAllowsTeam(invite.workspaceId, true);

    const pointer = await tx.get(pointerDoc(uid));
    const current = pointer.exists ? (pointer.get('workspaceId') as string | null) : null;
    const target = await tx.get(workspaceDoc(invite.workspaceId));
    if (!target.exists) throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_NOT_FOUND);
    const alreadyMember = await tx.get(membersCol(invite.workspaceId).doc(uid));

    // Their workspace changed since the check above (another tab accepted something): make them retry against the new state.
    if (current !== beforeWorkspace) {
      throw new InviteError(409, 'MEMBERSHIP_CHANGED', 'Your workspace just changed. Open the invitation link again.');
    }
    let personalWorkspaceId: string | null = pointer.exists ? ((pointer.get('personalWorkspaceId') as string | null) ?? null) : null;
    if (current && current !== invite.workspaceId) {
      if (inSharedTeam) {
        throw new InviteError(409, 'IN_OTHER_TEAM', 'You are already part of another team workspace. Ask its admin to remove you first, then open this link again.');
      }
      // Remembered so that leaving the team later brings them back to their own projects.
      personalWorkspaceId = current;
    }

    const now = new Date().toISOString();
    if (!alreadyMember.exists) {
      tx.set(membersCol(invite.workspaceId).doc(uid), {
        uid,
        email: invite.invitedEmail,
        name,
        role: invite.role,
        addedAt: now,
        addedBy: invite.invitedBy,
      } satisfies WorkspaceMember);
    }
    tx.set(pointerDoc(uid), { workspaceId: invite.workspaceId, personalWorkspaceId });
    tx.update(ref, { status: 'accepted', acceptedAt: now, acceptedBy: uid });
    return {
      workspaceId: invite.workspaceId,
      role: alreadyMember.exists ? (alreadyMember.get('role') as WorkspaceRole) : invite.role,
    };
  });
  invalidateMembership(uid);
  return result;
}

async function assertAnotherAdmin(workspaceId: string, uid: string): Promise<void> {
  const admins = await membersCol(workspaceId).where('role', '==', 'admin').get();
  if (!admins.docs.some((d) => d.id !== uid)) {
    throw new WorkspaceRequestError('A workspace needs at least one admin. Make someone else an admin first.');
  }
}

export async function changeRole(workspaceId: string, uid: string, role: WorkspaceRole): Promise<void> {
  if (role !== 'admin' && role !== 'editor') throw new WorkspaceRequestError('Role must be admin or editor');
  const member = await membersCol(workspaceId).doc(uid).get();
  if (!member.exists) throw new WorkspaceRequestError('That person is not in this workspace');
  if (member.get('role') === 'admin' && role === 'editor') await assertAnotherAdmin(workspaceId, uid);
  await membersCol(workspaceId).doc(uid).update({ role });
  invalidateMembership(uid);
}

// Removes workspace access only; the person's ScatterPie login itself is left alone, and if they joined from a workspace of their own they go back to it.
export async function removeMember(workspaceId: string, uid: string): Promise<void> {
  const member = await membersCol(workspaceId).doc(uid).get();
  if (!member.exists) throw new WorkspaceRequestError('That person is not in this workspace');
  if (member.get('role') === 'admin') await assertAnotherAdmin(workspaceId, uid);
  await membersCol(workspaceId).doc(uid).delete();

  const pointer = await pointerDoc(uid).get();
  const personal = pointer.exists ? (pointer.get('personalWorkspaceId') as string | null) : null;
  const stillInPersonal = personal && personal !== workspaceId ? (await membersCol(personal).doc(uid).get()).exists : false;
  await pointerDoc(uid).set(
    stillInPersonal
      ? { workspaceId: personal, personalWorkspaceId: null }
      : { workspaceId: null, removedFrom: workspaceId, removedAt: new Date().toISOString() }
  );
  invalidateMembership(uid);
}
