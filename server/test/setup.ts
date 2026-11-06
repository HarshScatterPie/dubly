import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { afterAll } from 'vitest';

// Tests run against a real MongoDB replica set, in a database of their own that is emptied between tests. The connection comes from
// MONGODB_TEST_URI (the environment, else server/.env), and the database name must end in `_test`, so no test can ever touch real data.
const fromFile = (() => {
  try {
    return dotenv.parse(readFileSync(fileURLToPath(new URL('../.env', import.meta.url)))).MONGODB_TEST_URI;
  } catch {
    return undefined;
  }
})();
const testUri = process.env.MONGODB_TEST_URI || fromFile;
if (!testUri) {
  throw new Error('Tests need a MongoDB replica set: set MONGODB_TEST_URI (see docs/MONGODB.md), e.g. mongodb://127.0.0.1:27017/dubly_test?directConnection=true');
}
const dbName = process.env.MONGODB_TEST_DB || new URL(testUri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '') || 'dubly_test';
if (!dbName.endsWith('_test')) throw new Error(`Refusing to run tests against "${dbName}": the test database name must end in _test`);
process.env.MONGODB_URI = testUri;
process.env.MONGODB_DB = dbName;
process.env.NODE_ENV = 'test';

// Set before server/.env is read (dotenv never overrides a variable that exists), so no test can send real email through a developer's SMTP.
for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) process.env[name] = '';
// Tests see the Gemini 3.8 voice engines, whatever the developer's server/.env says; the other settings are tested by switching env.ttsEngine.
process.env.TTS_ENGINE = 'gemini';
// New workspaces start on Starter here, which most tests' minute arithmetic assumes; the Free plan is tested by switching env.newWorkspacePlan.
process.env.NEW_WORKSPACE_PLAN = 'starter';
process.env.QUOTA_REQUEST_TO = '';
process.env.ALLOW_SIGNUP = 'true';
process.env.MEDIA_URL_SECRET = 'test-media-url-secret';
// The global per-address ceiling is tested on its own; the rest of the suite sends every request from 127.0.0.1.
process.env.RATE_ALL_PER_IP_MINUTE = process.env.RATE_ALL_PER_IP_MINUTE || '1000000';

const { connectMongo, closeMongo } = await import('../lib/mongo');
const { ensureMediaIndexes } = await import('../lib/mediaStore');
await connectMongo();
await ensureMediaIndexes();
afterAll(async () => {
  await closeMongo();
});
