import type { Response } from 'express';
import { Router } from '../lib/router';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { requireAdmin } from '../lib/auth';
import {
  acceptInvite,
  changeRole,
  createInvite,
  getWorkspace,
  InviteError,
  listPendingInvites,
  previewInvite,
  removeMember,
  revokeInvite,
  renameWorkspace,
  WorkspaceRequestError,
  type WorkspaceRole,
} from '../lib/workspaces';
import { schemas, validateBody } from '../lib/validation';
import { getGlossary, saveGlossary } from '../lib/glossaryStore';
import { emailInvite } from '../lib/inviteEmail';

export const workspaceRouter = Router();

function sendError(res: Response, err: unknown): void {
  if (err instanceof WorkspaceRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof InviteError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  throw err;
}

// Every member can see who is in the team and their own role; only admins can change anything.
workspaceRouter.get('/', async (req, res) => {
  try {
    const workspace = await getWorkspace(req.workspaceId!);
    res.json({ ...workspace, myRole: req.workspaceRole, myUid: req.uid });
  } catch (err) {
    sendError(res, err);
  }
});

workspaceRouter.patch('/', requireAdmin, validateBody(schemas.renameWorkspace), async (req, res) => {
  try {
    await renameWorkspace(req.workspaceId!, String(req.body?.name ?? ''));
    res.json({ ...(await getWorkspace(req.workspaceId!)), myRole: req.workspaceRole, myUid: req.uid });
  } catch (err) {
    sendError(res, err);
  }
});

// Adding someone is an invitation they accept themselves; no login is created and nobody is moved without their consent.
workspaceRouter.post('/members', requireAdmin, (_req, res) => {
  res.status(410).json({ error: 'Members are now added by invitation. Reload Dubly to get the new Team screen.', code: 'USE_INVITES' });
});

workspaceRouter.get('/invites', requireAdmin, async (req, res) => {
  res.json({ invites: await listPendingInvites(req.workspaceId!) });
});

const inviteLimit = rateLimit('invite', [
  ['user', rateRules.invitePerUser],
  ['workspace', rateRules.invitePerWorkspace],
]);

workspaceRouter.post('/invites', requireAdmin, inviteLimit, validateBody(schemas.invite), async (req, res) => {
  try {
    const { invite, token, workspaceName } = await createInvite(req.workspaceId!, req.uid!, {
      email: String(req.body?.email ?? ''),
      role: req.body?.role as WorkspaceRole,
    });
    // The link is returned either way, so a failed or unconfigured email never loses the invitation.
    const emailed = await emailInvite(invite, workspaceName, token);
    res.status(201).json({ invite, token, emailed });
  } catch (err) {
    sendError(res, err);
  }
});

workspaceRouter.delete('/invites/:inviteId', requireAdmin, async (req, res) => {
  try {
    await revokeInvite(req.workspaceId!, req.params.inviteId);
    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
});

workspaceRouter.patch('/members/:uid', requireAdmin, validateBody(schemas.changeRole), async (req, res) => {
  try {
    await changeRole(req.workspaceId!, req.params.uid, req.body?.role as WorkspaceRole);
    res.json(await getWorkspace(req.workspaceId!));
  } catch (err) {
    sendError(res, err);
  }
});

workspaceRouter.delete('/members/:uid', requireAdmin, async (req, res) => {
  try {
    await removeMember(req.workspaceId!, req.params.uid);
    res.status(204).send();
  } catch (err) {
    sendError(res, err);
  }
});

// The glossary steers every member's translations, so everyone can read it and admins maintain it.
workspaceRouter.get('/glossary', async (req, res) => {
  res.json({ entries: await getGlossary(req.workspaceId!), canEdit: req.workspaceRole === 'admin' });
});

workspaceRouter.put('/glossary', requireAdmin, validateBody(schemas.glossary), async (req, res) => {
  const entries = await saveGlossary(req.workspaceId!, req.body.entries, req.uid!);
  res.json({ entries, canEdit: true });
});

// Mounted behind requireAuth only: the invite is matched to the caller's signed-in email, whatever workspace they are in now.
export const invitesRouter = Router();
// Guessing invitation tokens is hopeless (256 bits), but there is no reason to let anyone try quickly.
invitesRouter.use(rateLimit('invite-accept', [['user', rateRules.inviteAcceptPerUser]]));

invitesRouter.post('/preview', validateBody(schemas.inviteToken), async (req, res) => {
  try {
    res.json(await previewInvite(String(req.body?.token ?? ''), req.email));
  } catch (err) {
    sendError(res, err);
  }
});

invitesRouter.post('/accept', validateBody(schemas.inviteToken), async (req, res) => {
  try {
    const membership = await acceptInvite(String(req.body?.token ?? ''), req.uid!, req.email);
    res.json(membership);
  } catch (err) {
    sendError(res, err);
  }
});
