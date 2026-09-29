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
};
