import { Router } from '../lib/router';
import { getUserProfile } from '../lib/projectRepo';
import { authAdmin } from '../lib/firebaseAdmin';
import { clearAccountStateCache } from '../lib/auth';
import { log } from '../lib/log';

export const profileRouter = Router();

/**
 * Read-only: this doc is provisioned by ScatterStudio's own onboarding, not Dubly, so
 * there is no corresponding PUT/PATCH here — editing it belongs wherever it was created.
 */
profileRouter.get('/', async (req, res) => {
  const profile = await getUserProfile(req.uid!);
  res.json(profile);
});

// Ends every session of this account, on every device, this one included; the cached account state is dropped so it applies at once here.
profileRouter.post('/sign-out-everywhere', async (req, res) => {
  await authAdmin.revokeRefreshTokens(req.uid!);
  clearAccountStateCache(req.uid!);
  log.info('sessions_revoked', { userId: req.uid });
  res.status(204).send();
});
