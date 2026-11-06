import dotenv from 'dotenv';
import path from 'node:path';
import { serverRoot } from './paths';

// DUBLY_ENV_FILE lets the secrets file live outside the repository (and outside any synced folder).
dotenv.config({ path: process.env.DUBLY_ENV_FILE ? path.resolve(process.env.DUBLY_ENV_FILE) : path.join(serverRoot, '.env') });

export const env = {
  port: Number(process.env.PORT) || 8787,
  // Address to listen on; empty means every interface. Behind a proxy on the same machine set 127.0.0.1, so nobody can reach the app
  // around the proxy (and forge the X-Forwarded-For that per-IP limits trust).
  host: process.env.HOST || '',
  // Plan a newly created workspace starts on (free, starter or enterprise); existing workspaces keep theirs.
  newWorkspacePlan: process.env.NEW_WORKSPACE_PLAN || 'free',
  // Where quota-increase requests from the Usage page are emailed; empty means the SMTP account itself. They are stored in MongoDB either way.
  quotaRequestTo: process.env.QUOTA_REQUEST_TO || '',
  vertexProjectId: process.env.VERTEX_PROJECT_ID || '',
  // Gemini 3.x is only served from the `global` endpoint; regional ones like us-central1 404.
  vertexGeminiLocation: process.env.VERTEX_GEMINI_LOCATION || 'global',
  geminiSttModel: process.env.GEMINI_STT_MODEL || 'gemini-3.5-flash-lite',
  geminiTranslateModel: process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash-lite',
  // `cloud` (the default for now): Gemini 2.5 Flash and Chirp 3 HD voices, both on Google Cloud TTS, with no Gemini API key.
  // `chirp`: Chirp 3 HD voices only. `gemini`: the plan-tiered Gemini 3.8 voices, which need a paid GEMINI_API_KEY.
  ttsEngine: (process.env.TTS_ENGINE === 'gemini' || process.env.TTS_ENGINE === 'chirp' ? process.env.TTS_ENGINE : 'cloud') as 'cloud' | 'gemini' | 'chirp',
  // The model behind the Gemini 2.5 Flash voices, served by Cloud TTS on the service account.
  geminiTtsCloudModel: process.env.GEMINI_TTS_CLOUD_MODEL || 'gemini-2.5-flash-tts',
  // The models behind the Gemini 3.8 Flash-Lite and Gemini 3.8 Flash voices, served by the Gemini API's Interactions endpoint.
  geminiTtsLiteModel: process.env.GEMINI_TTS_LITE_MODEL || 'gemini-3.8-flash-lite-tts',
  geminiTtsFlashModel: process.env.GEMINI_TTS_FLASH_MODEL || 'gemini-3.8-flash-tts',
  // With a key, Gemini 3.8 voices go to the Gemini Developer API (where 3.8 TTS is documented); without one, to Vertex AI on the service account.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Tried first for users who turned on premium voices. Verified on Cloud TTS (2026-09-24): performs [laughing] and [sigh]; 3.8 is not served there yet.
  geminiTtsPremiumModel: process.env.GEMINI_TTS_PREMIUM_MODEL || 'gemini-3.1-flash-tts-preview',
  // Listens to rendered lines next to the originals for the AI review (dubDirector.ts).
  geminiReviewModel: process.env.GEMINI_REVIEW_MODEL || 'gemini-3.5-flash-lite',
  // The one database that holds every record and every stored file (GridFS). It must be a replica set (one node is fine), see docs/MONGODB.md.
  mongodbUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/?directConnection=true',
  mongodbDb: process.env.MONGODB_DB || 'dubly',
  // Where people open Dubly; links in emails (invitations, password resets, email checks) point here.
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3000',
  // Session cookies carry the Secure flag on HTTPS requests; set COOKIE_SECURE=true to require it everywhere (behind TLS), false never.
  cookieSecure: (process.env.COOKIE_SECURE === 'true' ? 'always' : process.env.COOKIE_SECURE === 'false' ? 'never' : 'auto') as 'always' | 'never' | 'auto',
  // Self sign-up from the login screen. Off: accounts come only from invitations and server/scripts/create_user.ts.
  allowSignup: process.env.ALLOW_SIGNUP !== 'false',
  // Outgoing mail (invitations, password resets, email checks). Empty SMTP_HOST or MAIL_FROM turns email off: invitations are shared by
  // link, and outside production the reset and verification links are printed to the server log instead.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',
};
