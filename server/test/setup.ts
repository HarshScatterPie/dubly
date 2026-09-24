// Refuses to run outside the emulators, so no test can ever touch the shared production Firebase project.
const required = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Tests must run under the Firebase emulators (npm test). Missing: ${missing.join(', ')}`);
}
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-dubly';
if (!process.env.GCLOUD_PROJECT.startsWith('demo-')) {
  throw new Error('Tests require a demo- project id');
}
