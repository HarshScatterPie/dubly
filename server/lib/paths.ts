import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const serverRoot = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(serverRoot, '..');
export const credentialsDir = path.join(serverRoot, 'credentials');
export const tmpDir = path.join(serverRoot, 'tmp');
export const lipsyncDir = path.join(serverRoot, 'lipsync');
export const cacheDir = path.join(serverRoot, 'cache');
