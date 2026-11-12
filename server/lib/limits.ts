import { availableParallelism } from 'node:os';

// Every operational limit in one place; each can be overridden with the environment variable named next to it (documented in docs/DEPLOYMENT.md).
const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const cores = availableParallelism();

/**
 * Server processes on this machine. WEB_CONCURRENCY as a number fixes how many; "auto", the default in production, has the supervisor
 * (primary.ts) start MIN_PROCESSES and add one at a time, up to MAX_PROCESSES, while the ones running are busy and memory allows, then
 * retire idle ones again. Rendering runs in ffmpeg and worker threads, outside these processes. Development and tests stay in one.
 */
function processRange(): { min: number; max: number } {
  const configured = process.env.WEB_CONCURRENCY ?? (process.env.NODE_ENV === 'production' ? 'auto' : '1');
  if (configured !== 'auto') {
    const fixed = Math.max(1, Math.floor(Number(configured)) || 1);
    return { min: fixed, max: fixed };
  }
  const max = Math.max(1, Math.floor(num('MAX_PROCESSES', Math.max(1, cores - 1))));
  return { min: Math.min(max, Math.max(1, Math.floor(num('MIN_PROCESSES', Math.min(2, max))))), max };
}
const range = processRange();
// The processes on this machine when this one started: the supervisor passes it to each process it starts (DUBLY_PROCESS_COUNT).
const processCount = Math.max(1, Math.floor(num('DUBLY_PROCESS_COUNT', range.min)));

export const limits = {
  minProcesses: range.min,
  maxProcesses: range.max,
  processCount,
  // Processes serving this database on every machine and container. A first guess (INSTANCE_COUNT machines like this one) until the
  // instance heartbeats (instances.ts) count the live ones, so it stays right however they are started or scaled.
  totalProcesses: processCount * Math.max(1, Math.floor(num('INSTANCE_COUNT', 1))),
  // Free memory this machine keeps: new dubs, transcriptions and caption renders wait while it has less (MIN_FREE_MEMORY_MB), and no
  // process is added unless this much plus one process's worth (PROCESS_MEMORY_MB) is free.
  minFreeMemoryMb: num('MIN_FREE_MEMORY_MB', 1024),
  processMemoryMb: num('PROCESS_MEMORY_MB', 300),
  // How long a call waits for its AI model's turn (aiPacing.ts) before giving up: in a background job (AI_QUEUE_MAX_WAIT_MINUTES), and
  // while someone waits on the screen, e.g. a voice preview (AI_INTERACTIVE_WAIT_SECONDS).
  aiQueueMaxWaitMs: num('AI_QUEUE_MAX_WAIT_MINUTES', 30) * 60_000,
  aiInteractiveWaitMs: num('AI_INTERACTIVE_WAIT_SECONDS', 45) * 1000,
  // How long a model stays paused, for every process, after the provider says it is out of quota (AI_QUOTA_PAUSE_SECONDS).
  aiQuotaPauseMs: num('AI_QUOTA_PAUSE_SECONDS', 60) * 1000,
  // Longest source video accepted, in seconds (MAX_VIDEO_MINUTES).
  maxVideoSeconds: num('MAX_VIDEO_MINUTES', 60) * 60,
  // The one size boundary for source video, whether uploaded or fetched as a sample.
  maxSourceVideoBytes: 500 * 1024 * 1024,
  // Dubs rendering at once per workspace; further dubs wait in the queue (MAX_DUBS_PER_WORKSPACE).
  maxDubsPerWorkspace: num('MAX_DUBS_PER_WORKSPACE', 2),
  // Dubs rendering at once on this machine (MAX_ACTIVE_DUBS), by default half its cores, however many processes share them: the
  // supervisor hands out the slots (machineSlots.ts), so the total holds exactly as processes come and go.
  maxActiveDubs: num('MAX_ACTIVE_DUBS', Math.max(2, Math.floor(cores / 2))),
  // Transcriptions and caption renders running at once on this machine (MAX_HEAVY_REQUESTS); more wait their turn. Shared the same way.
  maxHeavyRequests: num('MAX_HEAVY_REQUESTS', Math.max(2, Math.floor((cores * 3) / 8))),
  // ONNX worker threads in this process, its share of ONNX_WORKERS for the machine (0 turns them off, see onnxPool.ts). They start on
  // demand and stop when idle, so a share worked out when the process starts is close enough while the count changes.
  onnxWorkers: Math.max(1, Math.ceil(num('ONNX_WORKERS', Math.max(2, Math.floor(cores / 4))) / processCount)),
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

// This process's part of a ceiling the whole deployment shares, for limits checked in memory because they run on every request. Traffic
// is spread by connection, not by request, and a proxy holds few connections, so one process can see far more than its even part. Twice
// that keeps a real person clear of a false refusal; these ceilings only stop floods, so a flood getting twice as far does not matter.
// Worked out on each call, since the number of live processes changes as they scale.
export const processShare = (max: number) => Math.min(max, Math.max(1, Math.ceil((2 * max) / Math.max(1, limits.totalProcesses))));

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
  // Wrong passwords for one email from one address: a stranger guessing at someone's account locks out only themselves.
  loginFailuresPerEmailAndIp: rule('LOGIN_FAILURES_PER_EMAIL_IP_15_MINUTES', 10, 15 * 60 * 1000),
  // Wrong passwords for one email from everywhere, against many addresses guessing together. Past it, only a browser that has signed
  // in to the account before may still try its password (devices.isKnownDevice), so the owner keeps that and the emailed link.
  loginFailuresPerEmail: rule('LOGIN_FAILURES_PER_EMAIL_HOUR', 100, HOUR),
  // Password changes by a signed-in person.
  passwordChangePerUser: rule('PASSWORD_CHANGE_PER_15_MINUTES', 10, 15 * 60 * 1000),
  // New accounts, per caller address.
  signupPerIp: rule('SIGNUP_PER_HOUR', 10, HOUR),
  // Sign-in links, password-reset and confirmation emails sent on request, per caller address and per email address. The per-address
  // ceiling leaves room for a whole office behind one public address asking in the same hour.
  authEmailPerIp: rule('AUTH_EMAIL_PER_HOUR', 40, HOUR),
  authEmailPerAddress: rule('AUTH_EMAIL_PER_ADDRESS_HOUR', 5, HOUR),
  // Using an emailed link (confirming an email, resetting a password, opening a sign-in link), per caller address. The links carry
  // 256-bit tokens nobody can guess, so this only stops floods, and is high enough for an office behind one address.
  authTokenPerIp: rule('AUTH_TOKEN_PER_HOUR', 60, HOUR),
  // The app's page itself (index.html for every client-side route), per caller address; far above what any person loads.
  pagePerIp: hotRule('PAGE_PER_MINUTE', 300, 60 * 1000),
  // Every request of any kind, per caller address: a ceiling far above a busy person (progress polls, video seeks), against floods.
  allPerIp: hotRule('ALL_PER_IP_MINUTE', 3000, 60 * 1000),
  // Quota-increase requests email the team, so a few a day per person is plenty.
  quotaRequestPerUser: rule('QUOTA_REQUEST_PER_DAY', 5, 24 * HOUR),
};
