import dotenv from 'dotenv';
import path from 'node:path';
import { serverRoot } from './paths';

dotenv.config({ path: path.join(serverRoot, '.env') });

export const env = {
  port: Number(process.env.PORT) || 8787,
  vertexProjectId: process.env.VERTEX_PROJECT_ID || '',
  vertexLocation: process.env.VERTEX_LOCATION || 'us-central1',
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:3000',
  // Optional voice-cloning worker on a Hugging Face ZeroGPU Space. Set both and
  // cloning runs there instead of on this machine's CPU.
  hfSpaceUrl: process.env.HF_SPACE_URL || '',
  hfToken: process.env.HF_TOKEN || '',
};
