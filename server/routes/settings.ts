import { Router } from 'express';
import { getSettings, setSettings } from '../lib/projectRepo';

export const settingsRouter = Router();

settingsRouter.get('/', async (req, res) => {
  const settings = await getSettings(req.uid!);
  res.json(settings);
});

settingsRouter.put('/', async (req, res) => {
  const { sttProvider, translateProvider, ttsProvider } = req.body || {};
  const settings = await setSettings(req.uid!, { sttProvider, translateProvider, ttsProvider });
  res.json(settings);
});
