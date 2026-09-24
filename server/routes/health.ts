import { Router } from '../lib/router';
import { getProviderStatus } from '../lib/modelRouter';
import { isLipSyncAvailable } from '../lib/lipSync';
import { isSeparationAvailable } from '../lib/audioSeparation';
import { installedCloneEngines, isVoiceCloneAvailable } from '../lib/voiceClone';
import { isCtcAlignAvailable } from '../lib/ctcAlign';
import { isSpaceCloneConfigured } from '../lib/spaceClone';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    providers: getProviderStatus(),
    lipSyncAvailable: isLipSyncAvailable(),
    separationAvailable: isSeparationAvailable(),
    voiceCloneAvailable: isVoiceCloneAvailable() || isSpaceCloneConfigured(),
    voiceCloneOnGpuSpace: isSpaceCloneConfigured(),
    voiceCloneEngines: installedCloneEngines(),
    forcedAlignAvailable: isCtcAlignAvailable(),
  });
});
