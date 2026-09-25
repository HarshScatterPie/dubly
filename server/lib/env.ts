import dotenv from 'dotenv';
import path from 'node:path';
import { serverRoot } from './paths';

// DUBLY_ENV_FILE lets the secrets file live outside the repository (and outside any synced folder).
dotenv.config({ path: process.env.DUBLY_ENV_FILE ? path.resolve(process.env.DUBLY_ENV_FILE) : path.join(serverRoot, '.env') });

export const env = {
  port: Number(process.env.PORT) || 8787,
  vertexProjectId: process.env.VERTEX_PROJECT_ID || '',
  // Gemini 3.x is only served from the `global` endpoint; regional ones like us-central1 404.
  vertexGeminiLocation: process.env.VERTEX_GEMINI_LOCATION || 'global',
  geminiSttModel: process.env.GEMINI_STT_MODEL || 'gemini-3.5-flash-lite',
  geminiTranslateModel: process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-flash-lite',
  // `gemini` voices lines with emotion and delivery direction; `chirp` is the plain Chirp3-HD voice it falls back to.
  ttsEngine: (process.env.TTS_ENGINE === 'chirp' ? 'chirp' : 'gemini') as 'gemini' | 'chirp',
  // The standard (GA) Gemini-TTS model every expressive line uses.
  geminiTtsModel: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-tts',
  // Tried first for users who turned on premium voices, at about twice the voice cost. Verified on Cloud TTS (2026-09-24): performs [laughing] and [sigh]; 3.8 is not served there yet.
  geminiTtsPremiumModel: process.env.GEMINI_TTS_PREMIUM_MODEL || 'gemini-3.1-flash-tts-preview',
  // Listens to rendered lines next to the originals for the AI review (dubDirector.ts).
  geminiReviewModel: process.env.GEMINI_REVIEW_MODEL || 'gemini-3.5-flash-lite',
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  // Needed only with CREDENTIALS_MODE=adc, where it cannot be read from a key file.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3000',
  // Outgoing mail (invitations). Empty SMTP_HOST or MAIL_FROM turns email off and invitations are shared by link only.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',
  // Optional voice-cloning worker on a Hugging Face ZeroGPU Space. Set both and
  // cloning runs there instead of on this machine's CPU.
  hfSpaceUrl: process.env.HF_SPACE_URL || '',
  hfToken: process.env.HF_TOKEN || '',
};
