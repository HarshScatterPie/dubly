import { Router } from '../lib/router';
import { getUserProfile } from '../lib/projectRepo';

export const profileRouter = Router();

/**
 * Read-only: this doc is provisioned by ScatterStudio's own onboarding, not Dubly, so
 * there is no corresponding PUT/PATCH here — editing it belongs wherever it was created.
 */
profileRouter.get('/', async (req, res) => {
  const profile = await getUserProfile(req.uid!);
  res.json(profile);
});
