import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { sharedInvalidator } from './cacheBus';
import { col, isDuplicateKeyError, withTransaction } from './mongo';
import { AccountError, createUser, deleteUser, getUser, getUserByEmail, isEmail, revokeAllSessions } from './accounts';
import { log } from './log';
import { newWorkspacePlanId, planForWorkspace } from './plans';

// A Dubly workspace is a team: projects and the monthly minute allowance belong to it, and each member is an admin or an editor.
export type WorkspaceRole = 'admin' | 'editor';

export interface WorkspaceMember {
  uid: string;
  email: string;
  name: string;
  // A small data: URL the member chose in Settings; absent until they do.
  avatar?: string;
  role: WorkspaceRole;
  addedAt: string;
  addedBy: string;
}

export interface Membership {
  workspaceId: string;
  role: WorkspaceRole;
}

// `NO_WORKSPACE`: an admin removed them, and they stay out until invited again. `AWAITING_INVITE`: they have been invited but have not joined.
// `EMAIL_NOT_VERIFIED`: a new account gets its own workspace (and its free minutes) only once its email address is confirmed.
export type WorkspaceAccessCode = 'NO_WORKSPACE' | 'AWAITING_INVITE' | 'EMAIL_NOT_VERIFIED';

export class WorkspaceAccessError extends Error {
  constructor(
    message: string,
    public code: WorkspaceAccessCode = 'NO_WORKSPACE'
  ) {
    super(message);
  }
}
export class WorkspaceRequestError extends Error {}

const REMOVED_MESSAGE = 'Your access to Dubly was removed by the workspace admin. Ask them to invite you again if this is a mistake.';
const AWAITING_MESSAGE = 'You have not joined a workspace yet. Accept your invitation to start using Dubly.';
const UNVERIFIED_MESSAGE = 'Confirm your email address to start using Dubly. Open the link we emailed you, or send a new one.';

interface WorkspaceDoc {
  _id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  // Absent means Starter (see plans.ts); new workspaces record theirs.
  plan?: string;
  planUpdatedAt?: string;
}
type MemberDoc = WorkspaceMember & { _id: string; workspaceId: string };
// uid -> the one workspace that user belongs to. `workspaceId: null` means no access: `removedFrom` is set when an admin removed them (permanent
// until they are invited again), `awaitingInvite` for an account made from an invitation that has not been accepted yet. `createdViaInvite` marks
// a login Dubly itself created from an invitation, which is deleted along with the membership.
interface PointerDoc {
  _id: string;
  workspaceId: string | null;
  removedFrom?: string;
  removedAt?: string;
  awaitingInvite?: boolean;
  createdViaInvite?: boolean;
  claimedInviteId?: string;
}

const workspacesCol = () => col<WorkspaceDoc>('workspaces');
const membersCol = () => col<MemberDoc>('members');
const pointersCol = () => col<PointerDoc>('memberships');
const memberId = (workspaceId: string, uid: string) => `${workspaceId}:${uid}`;
// A member as the app sees it: the stored fields without the database's own keys.
const MEMBER_FIELDS = { _id: 0, workspaceId: 0 } as const;

// Every API request resolves membership (the UI polls once a second), so it is cached briefly and cleared on any change.
const CACHE_MS = 15_000;
const cache = new Map<string, { value: Membership; at: number }>();
const pendingCreates = new Map<string, Promise<Membership>>();

export const invalidateMembership = sharedInvalidator('membership', (uid) => (uid === null ? cache.clear() : void cache.delete(uid)));

export function clearMembershipCache(): void {
  cache.clear();
}

export async function resolveMembership(uid: string, caller: { emailVerified?: boolean } = {}): Promise<Membership> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const pointer = await pointersCol().findOne({ _id: uid });
  let membership: Membership;
  if (pointer) {
    const workspaceId = pointer.workspaceId;
    if (!workspaceId) {
      if (pointer.removedFrom) throw new WorkspaceAccessError(REMOVED_MESSAGE);
      throw new WorkspaceAccessError(AWAITING_MESSAGE, 'AWAITING_INVITE');
    }
    const member = await membersCol().findOne({ _id: memberId(workspaceId, uid) }, { projection: { role: 1 } });
    if (!member) throw new WorkspaceAccessError(REMOVED_MESSAGE);
    membership = { workspaceId, role: member.role };
  } else {
    if (caller.emailVerified === false) throw new WorkspaceAccessError(UNVERIFIED_MESSAGE, 'EMAIL_NOT_VERIFIED');
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

// The first time someone uses Dubly they get their own workspace as its admin, on the new-workspace plan (Free). Someone with an invitation
// waiting gets nothing until they accept it: a workspace of their own would be a plan they never asked for.
async function createPersonalWorkspace(uid: string): Promise<Membership> {
  const user = await getUser(uid);
  if (!user) throw new WorkspaceAccessError(REMOVED_MESSAGE);
  if ((await pendingInvitesFor(user.email)).length > 0) throw new WorkspaceAccessError(AWAITING_MESSAGE, 'AWAITING_INVITE');
  const name = user.displayName || user.email.split('@')[0] || 'Member';
  const workspaceId = `ws-${randomUUID()}`;
  const now = new Date().toISOString();

  let created: boolean;
  try {
    created = await withTransaction(async (session) => {
      if (await pointersCol().findOne({ _id: uid }, { session })) return false;
      await workspacesCol().insertOne(
        {
          _id: workspaceId,
          name: `${name}'s workspace`,
          createdAt: now,
          createdBy: uid,
          // Recorded explicitly: a workspace with no plan field is on Starter.
          plan: newWorkspacePlanId(),
          planUpdatedAt: now,
        },
        { session }
      );
      await membersCol().insertOne(
        { _id: memberId(workspaceId, uid), workspaceId, uid, email: user.email, name, role: 'admin', addedAt: now, addedBy: uid },
        { session }
      );
      await pointersCol().insertOne({ _id: uid, workspaceId }, { session });
      return true;
    });
  } catch (err) {
    // Another request created it first.
    if (!isDuplicateKeyError(err)) throw err;
    created = false;
  }
  if (!created) return resolveMembership(uid);
  log.info('workspace_created', { workspaceId, userId: uid });
  return { workspaceId, role: 'admin' };
}

const byRoleThenJoined = (a: WorkspaceMember, b: WorkspaceMember) => (a.role === b.role ? a.addedAt.localeCompare(b.addedAt) : a.role === 'admin' ? -1 : 1);

export async function getWorkspace(workspaceId: string): Promise<{ id: string; name: string; members: WorkspaceMember[] }> {
  const [ws, members] = await Promise.all([
    workspacesCol().findOne({ _id: workspaceId }, { projection: { name: 1 } }),
    membersCol().find({ workspaceId }, { projection: MEMBER_FIELDS }).toArray(),
  ]);
  return { id: workspaceId, name: ws?.name || 'Workspace', members: (members as WorkspaceMember[]).sort(byRoleThenJoined) };
}

export async function getWorkspaceName(workspaceId: string): Promise<string> {
  return (await workspacesCol().findOne({ _id: workspaceId }, { projection: { name: 1 } }))?.name || 'Workspace';
}

export async function workspaceExists(workspaceId: string): Promise<boolean> {
  return (await workspacesCol().countDocuments({ _id: workspaceId }, { limit: 1 })) > 0;
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new WorkspaceRequestError('Workspace name cannot be empty');
  await workspacesCol().updateOne({ _id: workspaceId }, { $set: { name: trimmed } });
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

// Stored under sha256(token): the raw token only ever exists in the link the admin sends, so a database read cannot be replayed as an invite.
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
type InviteDoc = StoredInvite & { _id: string };
const invitesCol = () => col<InviteDoc>('invites');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function asInvite(doc: InviteDoc | null): StoredInvite | null {
  if (!doc) return null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, ...invite } = doc;
  return invite;
}

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

// The name the person chose at sign-up or in Settings, else the first part of their email.
async function displayNameFor(uid: string): Promise<string> {
  const user = await getUser(uid);
  return user?.displayName || user?.email.split('@')[0] || 'Member';
}

// An invitation as its addressee sees it in their notifications; the secret link itself is never stored, so it is accepted by this id.
export interface MyInvite {
  id: string;
  workspaceName: string;
  role: WorkspaceRole;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
}

// Live invitations addressed to an email: pending and not past their expiry, newest first.
async function pendingInvitesFor(email: string): Promise<StoredInvite[]> {
  const docs = await invitesCol().find({ invitedEmail: email.trim().toLowerCase(), status: 'pending' }).toArray();
  const now = Date.now();
  return docs
    .map((d) => asInvite(d)!)
    .filter((inv) => new Date(inv.expiresAt).getTime() > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// The invitation a login Dubly made from a link was created for. Holding that link proved the account may join that one workspace, and nothing
// more: the inviting admin holds the same link, so it never stands in for proof of the inbox.
async function claimedInviteOf(uid: string): Promise<string | null> {
  return (await pointersCol().findOne({ _id: uid }))?.claimedInviteId ?? null;
}

// Invitations the caller may see and accept by id: everything addressed to a verified email, else only the one their login was made from.
export async function listInvitesFor(email: string | undefined, uid: string, emailVerified: boolean): Promise<MyInvite[]> {
  if (!email) return [];
  const claimed = emailVerified ? null : await claimedInviteOf(uid);
  if (!emailVerified && !claimed) return [];
  return (await pendingInvitesFor(email)).filter((inv) => emailVerified || inv.id === claimed).map((inv) => ({
    id: inv.id,
    workspaceName: inv.workspaceName,
    role: inv.role,
    invitedByName: inv.invitedByName,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
  }));
}

// Invites an email without looking anyone up, creating or moving anything; the response never reveals whether the email has a login.
export async function createInvite(
  workspaceId: string,
  actorUid: string,
  input: { email: string; role: WorkspaceRole }
): Promise<{ invite: InviteSummary; token: string; workspaceName: string }> {
  await assertPlanAllowsTeam(workspaceId);
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!isEmail(email)) throw new WorkspaceRequestError('Enter a valid email address');
  if (input.role !== 'admin' && input.role !== 'editor') throw new WorkspaceRequestError('Role must be admin or editor');

  // Checked against this workspace's own member list, which the admin can already see, so it reveals nothing about other accounts.
  if (await membersCol().findOne({ workspaceId, email }, { projection: { _id: 1 } })) throw new WorkspaceRequestError(`${email} is already in this workspace`);

  const [workspaceName, invitedByName] = await Promise.all([getWorkspaceName(workspaceId), displayNameFor(actorUid)]);
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const invite: StoredInvite = {
    id: hashToken(token),
    workspaceId,
    workspaceName,
    invitedEmail: email,
    role: input.role,
    invitedBy: actorUid,
    invitedByName,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };

  await withTransaction(async (session) => {
    // One live link per person: re-inviting (lost link, different role) revokes the previous one.
    await invitesCol().updateMany({ workspaceId, invitedEmail: email, status: 'pending' }, { $set: { status: 'revoked', revokedAt: invite.createdAt } }, { session });
    await invitesCol().insertOne({ _id: invite.id, ...invite }, { session });
  });
  return { invite: toSummary(invite), token, workspaceName: invite.workspaceName };
}

export async function listPendingInvites(workspaceId: string): Promise<InviteSummary[]> {
  const docs = await invitesCol().find({ workspaceId, status: 'pending' }).toArray();
  const now = Date.now();
  return docs
    .map((d) => asInvite(d)!)
    .filter((inv) => new Date(inv.expiresAt).getTime() > now)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toSummary);
}

export async function revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
  // One conditional write: another workspace's invite looks exactly like a missing one.
  const revoked = await invitesCol().findOneAndUpdate(
    { _id: inviteId, workspaceId, status: 'pending' },
    { $set: { status: 'revoked', revokedAt: new Date().toISOString() } }
  );
  if (!revoked) throw new WorkspaceRequestError('That invitation no longer exists');
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

function usableInvite(doc: InviteDoc | null, callerEmail: string | undefined): StoredInvite {
  const invite = asInvite(doc);
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
  const invite = usableInvite(await invitesCol().findOne({ _id: hashToken(String(token)) }), callerEmail);
  return {
    workspaceName: invite.workspaceName,
    role: invite.role,
    invitedByName: invite.invitedByName,
    expiresAt: invite.expiresAt,
    status: invite.status,
  };
}

export const INVITE_LINK_INVALID = 'This invitation link is not valid. Ask the workspace admin for a new one.';

// Whoever holds the link proves they got the email, so it is the one place an unsigned-in caller may learn anything: the address it was sent to.
async function openInviteForSignup(token: string): Promise<StoredInvite> {
  const invite = asInvite(await invitesCol().findOne({ _id: hashToken(String(token)) }));
  if (!invite || invite.status === 'revoked') throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_LINK_INVALID);
  if (invite.status === 'pending' && new Date(invite.expiresAt).getTime() <= Date.now()) {
    throw new InviteError(410, 'INVITE_EXPIRED', 'This invitation has expired. Ask the workspace admin for a new link.');
  }
  return invite;
}

async function accountExistsFor(email: string): Promise<boolean> {
  return (await getUserByEmail(email)) !== null;
}

// What the "set your password" screen shows before anyone is signed in; an existing account signs in as usual instead.
export async function lookupInviteForSignup(
  token: string
): Promise<{ email: string; workspaceName: string; role: WorkspaceRole; invitedByName: string; accountExists: boolean }> {
  const invite = await openInviteForSignup(token);
  const accountExists = invite.status === 'accepted' || (await accountExistsFor(invite.invitedEmail));
  if (!accountExists) await assertPlanAllowsTeam(invite.workspaceId, true);
  return {
    email: invite.invitedEmail,
    workspaceName: invite.workspaceName,
    role: invite.role,
    invitedByName: invite.invitedByName,
    accountExists,
  };
}

// Creates the login for a brand-new invitee. An email that already has an account is never touched, so a leaked link cannot reset anyone's password.
export async function createAccountForInvite(token: string, password: string): Promise<{ email: string }> {
  const invite = await openInviteForSignup(token);
  if (invite.status !== 'pending') {
    throw new InviteError(409, 'ACCOUNT_EXISTS', 'This email already has an account. Sign in with it to join.');
  }
  await assertPlanAllowsTeam(invite.workspaceId, true);
  let uid: string;
  try {
    // Not marked verified: the inviting admin also holds this link, so it does not prove who reads the inbox. A verified flag would let the
    // admin's chosen password collect any other workspace's invitation to this address (`/api/invites/mine`, `accept-by-id`).
    uid = (await createUser({ email: invite.invitedEmail, password, emailVerified: false })).uid;
  } catch (err) {
    if (err instanceof AccountError && err.code === 'EMAIL_EXISTS') {
      throw new InviteError(409, 'ACCOUNT_EXISTS', 'This email already has an account. Sign in with it to join.');
    }
    if (err instanceof AccountError) throw new WorkspaceRequestError(err.message);
    throw err;
  }
  try {
    // The login exists only to join this team: until they accept, it has no workspace (and so no plan of its own).
    await pointersCol().replaceOne(
      { _id: uid },
      { workspaceId: null, awaitingInvite: true, createdViaInvite: true, claimedInviteId: invite.id },
      { upsert: true }
    );
  } catch (err) {
    await deleteUser(uid).catch(() => undefined);
    throw err;
  }
  return { email: invite.invitedEmail };
}

// Joins the caller to the invite's workspace from the link they were sent; accepting twice is a no-op.
export async function acceptInvite(token: string, uid: string, callerEmail: string | undefined): Promise<Membership> {
  return acceptInviteById(hashToken(String(token)), uid, callerEmail);
}

// Whether the caller may accept this invitation by id, without its link: a verified email, or the invitation their login was made from.
export async function mayAcceptById(inviteId: string, uid: string, emailVerified: boolean): Promise<boolean> {
  return emailVerified || (await claimedInviteOf(uid)) === inviteId;
}

// The same, from the invitation's id as listed in the person's notifications. Without the secret link this rests on the signed-in
// email alone, so the route only offers it where `mayAcceptById` allows.
export async function acceptInviteById(inviteId: string, uid: string, callerEmail: string | undefined): Promise<Membership> {
  const name = await displayNameFor(uid);
  // Whether the caller's current workspace is a shared team is a policy check read up front, keeping the transaction small.
  const before = await pointersCol().findOne({ _id: uid });
  const beforeWorkspace = before?.workspaceId ?? null;
  const inSharedTeam = beforeWorkspace
    ? (await membersCol().find({ workspaceId: beforeWorkspace }, { projection: { uid: 1 } }).limit(2).toArray()).some((m) => m.uid !== uid)
    : false;
  const result = await withTransaction(async (session: ClientSession): Promise<Membership> => {
    const invite = usableInvite(await invitesCol().findOne({ _id: inviteId }, { session }), callerEmail);
    if (invite.status === 'accepted') {
      // Opening a used link again only confirms a membership they still have; once an admin removes them, it is spent for good.
      const member = invite.acceptedBy === uid ? await membersCol().findOne({ _id: memberId(invite.workspaceId, uid) }, { session }) : null;
      if (member) return { workspaceId: invite.workspaceId, role: member.role };
      throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_NOT_FOUND);
    }
    if (new Date(invite.expiresAt).getTime() <= Date.now()) {
      throw new InviteError(410, 'INVITE_EXPIRED', 'This invitation has expired. Ask the workspace admin for a new link.');
    }
    // A link made before the workspace moved to a plan without teammates must not let anyone in.
    await assertPlanAllowsTeam(invite.workspaceId, true);

    const pointer = await pointersCol().findOne({ _id: uid }, { session });
    const current = pointer?.workspaceId ?? null;
    const target = await workspacesCol().findOne({ _id: invite.workspaceId }, { session, projection: { _id: 1 } });
    if (!target) throw new InviteError(404, 'INVITE_NOT_FOUND', INVITE_NOT_FOUND);
    const alreadyMember = await membersCol().findOne({ _id: memberId(invite.workspaceId, uid) }, { session });

    // Their workspace changed since the check above (another tab accepted something): make them retry against the new state.
    if (current !== beforeWorkspace) {
      throw new InviteError(409, 'MEMBERSHIP_CHANGED', 'Your workspace just changed. Open the invitation link again.');
    }
    if (current && current !== invite.workspaceId && inSharedTeam) {
      throw new InviteError(409, 'IN_OTHER_TEAM', 'You are already part of another team workspace. Ask its admin to remove you first, then open this link again.');
    }

    const now = new Date().toISOString();
    if (!alreadyMember) {
      await membersCol().insertOne(
        {
          _id: memberId(invite.workspaceId, uid),
          workspaceId: invite.workspaceId,
          uid,
          email: invite.invitedEmail,
          name,
          role: invite.role,
          addedAt: now,
          addedBy: invite.invitedBy,
        },
        { session }
      );
    }
    // A fresh pointer drops `awaitingInvite`/`removedFrom`; the mark on a login Dubly created is kept, so removing them later deletes it.
    await pointersCol().replaceOne(
      { _id: uid },
      { workspaceId: invite.workspaceId, ...(pointer?.createdViaInvite === true ? { createdViaInvite: true } : {}) },
      { upsert: true, session }
    );
    await invitesCol().updateOne({ _id: inviteId }, { $set: { status: 'accepted', acceptedAt: now, acceptedBy: uid } }, { session });
    return { workspaceId: invite.workspaceId, role: alreadyMember ? alreadyMember.role : invite.role };
  });
  invalidateMembership(uid);
  return result;
}

async function assertAnotherAdmin(workspaceId: string, uid: string): Promise<void> {
  const admins = await membersCol().find({ workspaceId, role: 'admin' }, { projection: { uid: 1 } }).toArray();
  if (!admins.some((m) => m.uid !== uid)) {
    throw new WorkspaceRequestError('A workspace needs at least one admin. Make someone else an admin first.');
  }
}

export async function changeRole(workspaceId: string, uid: string, role: WorkspaceRole): Promise<void> {
  if (role !== 'admin' && role !== 'editor') throw new WorkspaceRequestError('Role must be admin or editor');
  const member = await membersCol().findOne({ _id: memberId(workspaceId, uid) });
  if (!member) throw new WorkspaceRequestError('That person is not in this workspace');
  if (member.role === 'admin' && role === 'editor') await assertAnotherAdmin(workspaceId, uid);
  await membersCol().updateOne({ _id: memberId(workspaceId, uid) }, { $set: { role } });
  invalidateMembership(uid);
}

// Takes a person out of Dubly for good, at once. The membership and a "removed" mark go in one transaction, so from that moment every request
// they make is refused, even with a session that is still valid; every session is then deleted, so they are signed out everywhere. Nothing
// lets them back in on their own: only an admin inviting them again does. A login that Dubly itself created from an invitation is deleted
// outright; one the person made themselves is kept, only locked out of this workspace.
export async function removeMember(workspaceId: string, uid: string, actorUid: string): Promise<{ loginDeleted: boolean }> {
  if (uid === actorUid) throw new WorkspaceRequestError('You cannot remove yourself. Ask another admin to remove you.');
  const member = await membersCol().findOne({ _id: memberId(workspaceId, uid) });
  if (!member) throw new WorkspaceRequestError('That person is not in this workspace');
  if (member.role === 'admin') await assertAnotherAdmin(workspaceId, uid);

  const pointer = await pointersCol().findOne({ _id: uid });
  const createdViaInvite = pointer?.createdViaInvite === true;
  await withTransaction(async (session) => {
    await membersCol().deleteOne({ _id: memberId(workspaceId, uid) }, { session });
    await pointersCol().replaceOne(
      { _id: uid },
      { workspaceId: null, removedFrom: workspaceId, removedAt: new Date().toISOString(), ...(createdViaInvite ? { createdViaInvite: true } : {}) },
      { upsert: true, session }
    );
  });
  invalidateMembership(uid);

  // The lock-out above already holds if either of these fails, so a failure is logged for follow-up rather than undoing the removal.
  let loginDeleted = false;
  try {
    if (createdViaInvite) {
      await deleteUser(uid);
      loginDeleted = true;
    } else {
      await revokeAllSessions(uid);
    }
  } catch (err) {
    log.error('member_session_revoke_failed', err, { userId: uid, workspaceId });
  }
  return { loginDeleted };
}

// Keeps a member's entry on the team screen in step with the name and picture they chose in Settings.
export async function updateMemberProfile(workspaceId: string, uid: string, patch: { name?: string; avatar?: string | null }): Promise<void> {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.avatar !== undefined) {
    if (patch.avatar) $set.avatar = patch.avatar;
    else $unset.avatar = '';
  }
  if (!Object.keys($set).length && !Object.keys($unset).length) return;
  // Removed a moment ago: there is no entry left to update, and nothing happens.
  await membersCol().updateOne(
    { _id: memberId(workspaceId, uid) },
    { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) }
  );
}
