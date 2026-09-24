import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const serverRoot = path.resolve(__dirname, '..');
export const repoRoot = path.resolve(serverRoot, '..');
export const credentialsDir = path.join(serverRoot, 'credentials');
export const tmpDir = path.join(serverRoot, 'tmp');
export const lipsyncDir = path.join(serverRoot, 'lipsync');
export const cacheDir = path.join(serverRoot, 'cache');

// The optional engines' venv lays out differently on Windows (Scripts/, Lib/) and POSIX (bin/, lib/pythonX.Y/).
const venvDir = path.join(lipsyncDir, 'venv');
const isWindows = process.platform === 'win32';
export const venvPython = isWindows ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');

// POSIX venvs name site-packages after the interpreter version, so it is found rather than assumed.
export function venvSitePackages(): string {
  if (isWindows) return path.join(venvDir, 'Lib', 'site-packages');
  const libDir = path.join(venvDir, 'lib');
  const pythonDir = existsSync(libDir) ? readdirSync(libDir).find((name) => /^python3/.test(name)) : undefined;
  return path.join(libDir, pythonDir ?? 'python3', 'site-packages');
}
