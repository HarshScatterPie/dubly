import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { credentialsDir as defaultCredentialsDir } from './paths';

// Where key files are read from. On a developer machine point CREDENTIALS_DIR outside any synced folder (OneDrive, Dropbox).
export const credentialsDir = process.env.CREDENTIALS_DIR ? path.resolve(process.env.CREDENTIALS_DIR) : defaultCredentialsDir;

// CREDENTIALS_MODE=adc uses the machine's service account and no key files (production); key files stay the local default.
export const useAdc = process.env.CREDENTIALS_MODE === 'adc';

export function loadServiceAccount(filename: string): Record<string, unknown> {
  const filePath = path.join(credentialsDir, filename);
  if (!existsSync(filePath)) {
    throw new Error(`Missing credential file ${filename} in the credentials directory. Place the service account JSON there, or set CREDENTIALS_MODE=adc (see docs/SECURITY.md).`);
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export const gcpServiceAccountPath = path.join(credentialsDir, 'gcp-service-account.json');
export const firebaseServiceAccountPath = path.join(credentialsDir, 'firebase-service-account.json');

export function hasCredentialFile(filename: string): boolean {
  return existsSync(path.join(credentialsDir, filename));
}

// Whether Google APIs (Vertex, Cloud TTS) can be called: via ADC, or via the GCP key file.
export function hasGoogleCredentials(): boolean {
  return useAdc || hasCredentialFile('gcp-service-account.json');
}
