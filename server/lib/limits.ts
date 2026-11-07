import { availableParallelism } from 'node:os';

// Every operational limit in one place; each can be overridden with the environment variable named next to it (documented in docs/DEPLOYMENT.md).
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const cores = availableParallelism();

// Server processes on this machine (WEB_CONCURRENCY, a number or "auto"). Rendering runs in ffmpeg and worker threads, so half the
// cores is enough to serve requests, with the rest left for that work. Development and tests stay in one process.
function processesOnThisMachine(): number {
  const configured = process.env.WEB_CONCURRENCY ?? (process.env.NODE_ENV === 'production' ? 'auto' : '1');
  return configured === 'auto' ? Math.max(1, Math.floor(cores / 2)) : Math.max(1, Math.floor(Number(configured)) || 1);
}
const processCount = processesOnThisMachine();
// Machines serving this database (INSTANCE_COUNT); together with processCount, how many processes share the traffic.
const totalProcesses = processCount * Math.max(1, Math.floor(num('INSTANCE_COUNT', 1)));

// CPU budgets are set per machine and follow its size unless overridden; each process takes its share.
const perProcess = (machineBudget: number) => Math.max(1, Math.ceil(machineBudget / processCount));

// This process's part of a ceiling the whole deployment shares, for limits checked in memory because they run on every request. Traffic
// is spread by connection, not by request, and a proxy holds few connections, so one process can see far more than its even part. Twice
// that keeps a real person clear of a false refusal; these ceilings only stop floods, so a flood getting twice as far does not matter.
export const processShare = (max: number) => Math.min(max, Math.max(1, Math.ceil((2 * max) / totalProcesses)));

export const limits = {
  processCount,
  totalProcesses,
  // Longest source video accepted, in seconds (MAX_VIDEO_MINUTES).
  maxVideoSeconds: num('MAX_VIDEO_MINUTES', 60) * 60,
  // Dubs rendering at once per workspace; further dubs wait in the queue (MAX_DUBS_PER_WORKSPACE).
  maxDubsPerWorkspace: num('MAX_DUBS_PER_WORKSPACE', 2),
  // Dubs rendering at once in this process; MAX_ACTIVE_DUBS is the machine's total, by default half its cores.
  maxActiveDubs: perProcess(num('MAX_ACTIVE_DUBS', Math.max(2, Math.floor(cores / 2)))),
  // Transcriptions and caption renders running at once in this process; more wait their turn. MAX_HEAVY_REQUESTS is the machine's total.
  maxHeavyRequests: perProcess(num('MAX_HEAVY_REQUESTS', Math.max(2, Math.floor((cores * 3) / 8)))),
  // ONNX worker threads in this process; ONNX_WORKERS is the machine's total (0 turns them off, see onnxPool.ts).
  onnxWorkers: perProcess(num('ONNX_WORKERS', Math.max(2, Math.floor(cores / 4)))),
  // Longest stretch of audio sent to the speech model in one call (STT_CHUNK_SECONDS); read the note in vertexClient.ts before raising it.
  sttChunkSeconds: num('STT_CHUNK_SECONDS', 28),
  // How long a transcription/caption request waits for a free slot before giving up, in ms (HEAVY_WAIT_SECONDS).
  heavyWaitMs: num('HEAVY_WAIT_SECONDS', 600) * 1000,
  // Storage allowance per workspace, shown on the Usage page (STORAGE_LIMIT_MB) and refused past at upload; ENFORCE_STORAGE_LIMIT=false only shows it.
  storageLimitMb: num('STORAGE_LIMIT_MB', 2048),
  enforceStorageLimit: process.env.ENFORCE_STORAGE_LIMIT !== 'false',
  // Charged voice clips (Studio voiceovers, line previews) being made at once per workspace (MAX_VOICE_CLIPS_IN_FLIGHT).
  voiceClipsInFlightPerWorkspace: num('MAX_VOICE_CLIPS_IN_FLIGHT', 2),
  // Size of one piece of a large upload (UPLOAD_CHUNK_MB); well under the 100 MB a Cloudflare front door lets through in one request.
  uploadChunkBytes: num('UPLOAD_CHUNK_MB', 32) * 1024 * 1024,
};

// The most text one language may carry per second of video: several times real speech (~15-20 characters a second), with a floor for
// short clips. Model calls are billed by text while minutes are charged by video length, so a short video cannot carry hours of text.
const MAX_TEXT_CHARS_PER_VIDEO_SECOND = 60;
const MIN_TEXT_CHARS_PER_LANGUAGE = 2000;

export function maxTextCharsFor(videoSeconds: number): number {
  return Math.max(MIN_TEXT_CHARS_PER_LANGUAGE, Math.ceil(videoSeconds * MAX_TEXT_CHARS_PER_VIDEO_SECOND));
}

export interface RateRule {
  max: number;
  windowMs: number;
  // Checked on (nearly) every request, so it is counted in memory, each process taking its share, rather than in the database.
  hot?: boolean;
}

const HOUR = 60 * 60 * 1000;
const rule = (name: string, max: number, windowMs: number): RateRule => ({ max: num(`RATE_${name}`, max), windowMs });
const hotRule = (name: string, max: number, windowMs: number): RateRule => ({ ...rule(name, max, windowMs), hot: true });

// Requests allowed per window. `user` rules count one person, `workspace` rules the whole team, `ip` rules unauthenticated callers.
export const rateRules = {
  apiPerUser: hotRule('API_PER_MINUTE', 600, 60 * 1000),
  transcribePerUser: rule('TRANSCRIBE_PER_HOUR', 20, HOUR),
  transcribePerWorkspace: rule('TRANSCRIBE_PER_WORKSPACE_HOUR', 60, HOUR),
  translatePerUser: rule('TRANSLATE_PER_HOUR', 40, HOUR),
  translatePerWorkspace: rule('TRANSLATE_PER_WORKSPACE_HOUR', 120, HOUR),
  dubPerUser: rule('DUB_PER_HOUR', 30, HOUR),
  dubPerWorkspace: rule('DUB_PER_WORKSPACE_HOUR', 90, HOUR),
  ttsPerUser: rule('TTS_PER_HOUR', 200, HOUR),
  exportPerUser: rule('EXPORT_PER_HOUR', 30, HOUR),
  importSamplePerUser: rule('IMPORT_SAMPLE_PER_HOUR', 20, HOUR),
  uploadPerUser: rule('UPLOAD_PER_HOUR', 30, HOUR),
  inviteAcceptPerUser: rule('INVITE_ACCEPT_PER_HOUR', 30, HOUR),
  // Invitations send email, so they are capped well below anything a real team needs.
  invitePerUser: rule('INVITE_PER_HOUR', 20, HOUR),
  invitePerWorkspace: rule('INVITE_PER_WORKSPACE_DAY', 100, 24 * HOUR),
  // Unauthenticated: looking up a link and creating its account, per caller address.
  inviteSignupPerIp: rule('INVITE_SIGNUP_PER_HOUR', 40, HOUR),
  shareViewPerIp: rule('SHARE_VIEW_PER_MINUTE', 60, 60 * 1000),
  // Signed media URLs (players issue many range requests while seeking), per caller address.
  mediaPerIp: hotRule('MEDIA_PER_MINUTE', 1200, 60 * 1000),
  // Sign-in attempts, per caller address and per email, so neither a single machine nor a botnet can guess one password for long.
  loginPerIp: rule('LOGIN_PER_15_MINUTES', 30, 15 * 60 * 1000),
  // Only wrong passwords count, and per email from one address, so a stranger guessing at someone's account can lock out only
  // themselves, never its owner. The second ceiling stops many addresses together guessing one account.
  loginFailuresPerEmailAndIp: rule('LOGIN_FAILURES_PER_EMAIL_IP_15_MINUTES', 10, 15 * 60 * 1000),
  loginFailuresPerEmail: rule('LOGIN_FAILURES_PER_EMAIL_HOUR', 100, HOUR),
  // Password changes by a signed-in person.
  passwordChangePerUser: rule('PASSWORD_CHANGE_PER_15_MINUTES', 10, 15 * 60 * 1000),
  // New accounts, password-reset and verification emails, per caller address and per email address.
  signupPerIp: rule('SIGNUP_PER_HOUR', 10, HOUR),
  authEmailPerIp: rule('AUTH_EMAIL_PER_HOUR', 20, HOUR),
  authEmailPerAddress: rule('AUTH_EMAIL_PER_ADDRESS_HOUR', 5, HOUR),
  // The app's page itself (index.html for every client-side route), per caller address; far above what any person loads.
  pagePerIp: hotRule('PAGE_PER_MINUTE', 300, 60 * 1000),
  // Every request of any kind, per caller address: a ceiling far above a busy person (progress polls, video seeks), against floods.
  allPerIp: hotRule('ALL_PER_IP_MINUTE', 3000, 60 * 1000),
  // Quota-increase requests email the team, so a few a day per person is plenty.
  quotaRequestPerUser: rule('QUOTA_REQUEST_PER_DAY', 5, 24 * HOUR),
};
