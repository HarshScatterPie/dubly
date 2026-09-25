import { Router } from '../lib/router';
import { getWorkspace } from '../lib/workspaces';
import { getSettings, getUsage, getUserProfile, listStoredProjects, toClientProject } from '../lib/projectRepo';

export const bootstrapRouter = Router();

// Everything the app needs to open, read in parallel in one request, so the loading screen ends on a ready studio instead of five round trips.
bootstrapRouter.get('/', async (req, res) => {
  const [workspace, settings, usage, stored, profile] = await Promise.all([
    getWorkspace(req.workspaceId!),
    getSettings(req.uid!),
    getUsage(req.workspaceId!),
    listStoredProjects(req.workspaceId!),
    // The profile lives in ScatterStudio's data and is optional; the app falls back to the login's own name.
    getUserProfile(req.uid!).catch(() => null),
  ]);
  res.json({
    workspace: { ...workspace, myRole: req.workspaceRole, myUid: req.uid },
    preferences: settings.preferences,
    usage,
    projects: await Promise.all(stored.map(toClientProject)),
    profile,
  });
});
