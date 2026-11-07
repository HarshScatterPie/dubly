import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const serverRoot = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(serverRoot, '..');
export const credentialsDir = path.join(serverRoot, 'credentials');
// Each process's scratch and cache space, by default beside the code. DUBLY_TMP_DIR and DUBLY_CACHE_DIR move them, for a checkout on a
// synced folder (nothing here should be uploaded anywhere) or a faster disk.
export const tmpDir = process.env.DUBLY_TMP_DIR || path.join(serverRoot, 'tmp');
export const cacheDir = process.env.DUBLY_CACHE_DIR || path.join(serverRoot, 'cache');
