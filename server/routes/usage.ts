import { Router } from '../lib/router';
import { getUsage } from '../lib/projectRepo';

export const usageRouter = Router();

usageRouter.get('/', async (req, res) => {
  const usage = await getUsage(req.workspaceId!);
  res.json(usage);
});
