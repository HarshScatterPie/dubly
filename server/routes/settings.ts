import { Router } from '../lib/router';
import { getSettings, setSettings } from '../lib/projectRepo';
import { schemas, validateBody } from '../lib/validation';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res) => {
  const settings = await getSettings(req.uid!);
  res.json(settings);
});

settingsRouter.put('/', validateBody(schemas.settings), async (req, res) => {
  const { sttProvider, translateProvider, ttsProvider } = req.body || {};
  const settings = await setSettings(req.uid!, { sttProvider, translateProvider, ttsProvider });
  res.json(settings);
});
