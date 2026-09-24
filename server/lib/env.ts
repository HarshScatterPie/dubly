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
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  // Needed only with CREDENTIALS_MODE=adc, where it cannot be read from a key file.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3000',
  // Optional voice-cloning worker on a Hugging Face ZeroGPU Space. Set both and
  // cloning runs there instead of on this machine's CPU.
  hfSpaceUrl: process.env.HF_SPACE_URL || '',
  hfToken: process.env.HF_TOKEN || '',
};
