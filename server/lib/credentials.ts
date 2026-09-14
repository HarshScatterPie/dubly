import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { credentialsDir } from './paths';

export function loadServiceAccount(filename: string): Record<string, unknown> {
  const filePath = path.join(credentialsDir, filename);
  if (!existsSync(filePath)) {
    throw new Error(
      `Missing credential file: ${filePath}. Place the downloaded service account JSON there (see README/plan).`
    );
  }
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export const gcpServiceAccountPath = path.join(credentialsDir, 'gcp-service-account.json');
export const firebaseServiceAccountPath = path.join(credentialsDir, 'firebase-service-account.json');

export function hasCredentialFile(filename: string): boolean {
  return existsSync(path.join(credentialsDir, filename));
}
