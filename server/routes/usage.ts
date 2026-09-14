import { Router } from 'express';
import { getUsage } from '../lib/projectRepo';

export const usageRouter = Router();

usageRouter.get('/', async (req, res) => {
  const usage = await getUsage(req.uid!);
  res.json(usage);
});
