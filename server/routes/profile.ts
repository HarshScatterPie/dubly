import { Router } from '../lib/router';
import { getUserProfile, setUserProfile } from '../lib/projectRepo';
import { updateMemberProfile } from '../lib/workspaces';
import { revokeAllSessions } from '../lib/accounts';
import { clearSessionCookie, requireWorkspace } from '../lib/auth';
import { schemas, validateBody } from '../lib/validation';
import { log } from '../lib/log';

export const profileRouter = Router();

/**
 * The name and picture shown across Dubly, chosen at sign-up or in Settings and kept on the account (projectRepo.setUserProfile).
 */
profileRouter.get('/', async (req, res) => {
  const profile = await getUserProfile(req.uid!);
  res.json(profile);
});

// The first bytes of a real JPEG, PNG or WebP: the declared type in the data URL is only a claim.
function isRealImage(dataUrl: string): boolean {
  const head = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 33), 'base64');
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const png = head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  return jpeg || png || webp;
}

// Changes the caller's display name and/or picture (`avatar: null` removes it). Needs a workspace: the team screen shows the same name and picture.
profileRouter.patch('/', requireWorkspace, validateBody(schemas.profile), async (req, res) => {
  const { name, avatar } = req.body as { name?: string; avatar?: string | null };
  if (avatar && !isRealImage(avatar)) {
    res.status(400).json({ error: 'That file is not a valid JPEG, PNG or WebP image.', code: 'INVALID_IMAGE' });
    return;
  }
  const profile = await setUserProfile(req.uid!, { name, avatar });
  await updateMemberProfile(req.workspaceId!, req.uid!, { name, avatar });
  res.json(profile);
});

// Ends every session of this account, on every device, this one included; each request checks its session, so it applies at once.
profileRouter.post('/sign-out-everywhere', async (req, res) => {
  const ended = await revokeAllSessions(req.uid!);
  clearSessionCookie(req, res);
  log.info('sessions_revoked', { userId: req.uid, sessions: ended });
  res.status(204).send();
});
