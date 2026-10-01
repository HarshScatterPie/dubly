import { Router } from '../lib/router';
import { getProviderStatus } from '../lib/modelRouter';
import { isSeparationAvailable } from '../lib/audioSeparation';
import { isFaceScanAvailable } from '../lib/faceScan';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    providers: getProviderStatus(),
    faceScanAvailable: isFaceScanAvailable(),
    separationAvailable: isSeparationAvailable(),
  });
});
