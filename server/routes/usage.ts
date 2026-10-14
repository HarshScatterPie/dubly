import { Router } from '../lib/router';
import { getUsage } from '../lib/projectRepo';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { schemas, validateBody } from '../lib/validation';
import { getWorkspace } from '../lib/workspaces';
import { submitQuotaRequest } from '../lib/quotaRequests';

export const usageRouter = Router();

usageRouter.get('/', async (req, res) => {
  const usage = await getUsage(req.workspaceId!);
  res.json(usage);
});

// "Request Quota Increase" on the Usage page: recorded for ScatterPie and emailed to the team; any member may ask.
usageRouter.post('/quota-request', rateLimit('quota-request', [['user', rateRules.quotaRequestPerUser]]), validateBody(schemas.quotaRequest), async (req, res) => {
  const [usage, workspace] = await Promise.all([getUsage(req.workspaceId!), getWorkspace(req.workspaceId!)]);
  const result = await submitQuotaRequest(
    req.body,
    { workspaceId: req.workspaceId!, workspaceName: workspace.name, uid: req.uid!, email: req.email || '' },
    usage
  );
  res.status(201).json(result);
});
