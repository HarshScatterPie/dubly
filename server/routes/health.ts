import { Router } from '../lib/router';
import { getProviderStatus } from '../lib/modelRouter';
import { isLipSyncAvailable } from '../lib/lipSync';
import { isSeparationAvailable } from '../lib/audioSeparation';
import { isFaceScanAvailable } from '../lib/faceScan';
import { isCtcAlignAvailable } from '../lib/ctcAlign';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    providers: getProviderStatus(),
    lipSyncAvailable: isLipSyncAvailable(),
    faceScanAvailable: isFaceScanAvailable(),
    separationAvailable: isSeparationAvailable(),
    forcedAlignAvailable: isCtcAlignAvailable(),
  });
});
