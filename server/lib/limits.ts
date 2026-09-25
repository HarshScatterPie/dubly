// Every operational limit in one place; each can be overridden with the environment variable named next to it (documented in docs/DEPLOYMENT.md).
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const limits = {
  // Longest source video accepted, in seconds (MAX_VIDEO_MINUTES).
  maxVideoSeconds: num('MAX_VIDEO_MINUTES', 60) * 60,
  // Dubs rendering at once per workspace; further dubs wait in the queue (MAX_DUBS_PER_WORKSPACE).
  maxDubsPerWorkspace: num('MAX_DUBS_PER_WORKSPACE', 2),
  // Dubs rendering at once on this server, across all workspaces (MAX_ACTIVE_DUBS).
  maxActiveDubs: num('MAX_ACTIVE_DUBS', 4),
  // Transcriptions and caption renders running at once on this server; more wait their turn (MAX_HEAVY_REQUESTS).
  maxHeavyRequests: num('MAX_HEAVY_REQUESTS', 3),
  // How long a transcription/caption request waits for a free slot before giving up, in ms (HEAVY_WAIT_SECONDS).
  heavyWaitMs: num('HEAVY_WAIT_SECONDS', 600) * 1000,
  // Storage allowance per workspace, shown on the Usage page (STORAGE_LIMIT_MB); refused at upload only when ENFORCE_STORAGE_LIMIT=true.
  storageLimitMb: num('STORAGE_LIMIT_MB', 2048),
  enforceStorageLimit: process.env.ENFORCE_STORAGE_LIMIT === 'true',
};

export interface RateRule {
  max: number;
  windowMs: number;
}

const HOUR = 60 * 60 * 1000;
const rule = (name: string, max: number, windowMs: number): RateRule => ({ max: num(`RATE_${name}`, max), windowMs });

// Requests allowed per window. `user` rules count one person, `workspace` rules the whole team, `ip` rules unauthenticated callers.
export const rateRules = {
  apiPerUser: rule('API_PER_MINUTE', 600, 60 * 1000),
  transcribePerUser: rule('TRANSCRIBE_PER_HOUR', 20, HOUR),
  transcribePerWorkspace: rule('TRANSCRIBE_PER_WORKSPACE_HOUR', 60, HOUR),
  translatePerUser: rule('TRANSLATE_PER_HOUR', 40, HOUR),
  translatePerWorkspace: rule('TRANSLATE_PER_WORKSPACE_HOUR', 120, HOUR),
  dubPerUser: rule('DUB_PER_HOUR', 30, HOUR),
  dubPerWorkspace: rule('DUB_PER_WORKSPACE_HOUR', 90, HOUR),
  ttsPerUser: rule('TTS_PER_HOUR', 200, HOUR),
  voiceClonePerUser: rule('VOICE_CLONE_PER_HOUR', 10, HOUR),
  exportPerUser: rule('EXPORT_PER_HOUR', 30, HOUR),
  importSamplePerUser: rule('IMPORT_SAMPLE_PER_HOUR', 20, HOUR),
  uploadPerUser: rule('UPLOAD_PER_HOUR', 30, HOUR),
  inviteAcceptPerUser: rule('INVITE_ACCEPT_PER_HOUR', 30, HOUR),
  // Invitations send email, so they are capped well below anything a real team needs.
  invitePerUser: rule('INVITE_PER_HOUR', 20, HOUR),
  invitePerWorkspace: rule('INVITE_PER_WORKSPACE_DAY', 100, 24 * HOUR),
  shareViewPerIp: rule('SHARE_VIEW_PER_MINUTE', 60, 60 * 1000),
};
