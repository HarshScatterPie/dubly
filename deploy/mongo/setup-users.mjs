#!/usr/bin/env node
// One-time setup of a fresh mongod that was started with access control on (see deploy/mongo/mongod.conf.example):
//   1. initiates the single-node replica set (Dubly needs transactions),
//   2. creates three least-privilege users with random passwords:
//        dubly_admin  root, for Compass and operations only, never used by the app
//        dubly_app    readWrite on the `dubly` database, the app's own login
//        dubly_test   readWrite + dbAdmin on `dubly_test`, for `npm test`
//   3. writes the passwords and connection strings to the file named on the command line (keep it out of git and OneDrive).
//
// It relies on MongoDB's localhost exception, which only exists while there are no users, so run it on the database machine
// itself, right after the first start:  node deploy/mongo/setup-users.mjs <credentials-file> [host:port]
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const [, , outFile, hostPort = '127.0.0.1:27017'] = process.argv;
if (!outFile) {
  console.error('usage: node deploy/mongo/setup-users.mjs <credentials-file> [host:port]');
  process.exit(2);
}
if (existsSync(outFile)) {
  console.error(`${outFile} already exists; refusing to overwrite credentials.`);
  process.exit(2);
}

const password = () => randomBytes(24).toString('base64url');
const client = new MongoClient(`mongodb://${hostPort}/?directConnection=true`, { serverSelectionTimeoutMS: 10_000 });
await client.connect();
const admin = client.db('admin');

const hello = await admin.command({ hello: 1 });
if (!hello.setName) {
  try {
    await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: hostPort }] } });
    console.log('replica set rs0 initiated');
  } catch (err) {
    if (err.codeName !== 'AlreadyInitialized') throw err;
  }
}
for (let i = 0; i < 60; i++) {
  const state = await admin.command({ hello: 1 });
  if (state.isWritablePrimary) break;
  await new Promise((r) => setTimeout(r, 1000));
}

const creds = { dubly_admin: password(), dubly_app: password(), dubly_test: password() };
await admin.command({ createUser: 'dubly_admin', pwd: creds.dubly_admin, roles: [{ role: 'root', db: 'admin' }], mechanisms: ['SCRAM-SHA-256'] });
// From here on the localhost exception is gone; the rest is done as the administrator.
await client.close();

const adminClient = new MongoClient(`mongodb://dubly_admin:${encodeURIComponent(creds.dubly_admin)}@${hostPort}/?authSource=admin&directConnection=true`); // trufflehog:ignore
await adminClient.connect();
const adminDb = adminClient.db('admin');
await adminDb.command({ createUser: 'dubly_app', pwd: creds.dubly_app, roles: [{ role: 'readWrite', db: 'dubly' }], mechanisms: ['SCRAM-SHA-256'] });
await adminDb.command({
  createUser: 'dubly_test',
  pwd: creds.dubly_test,
  roles: [
    { role: 'readWrite', db: 'dubly_test' },
    { role: 'dbAdmin', db: 'dubly_test' },
  ],
  mechanisms: ['SCRAM-SHA-256'],
});
await adminClient.close();

const uri = (user, db) => `mongodb://${user}:${encodeURIComponent(creds[user])}@${hostPort}/${db}?authSource=admin&directConnection=true`; // trufflehog:ignore
const text = `# Dubly MongoDB credentials, created ${new Date().toISOString()}. Keep this file private.

# Compass / operations (root):
${uri('dubly_admin', 'admin')}

# server/.env (or DUBLY_ENV_FILE) for the app:
MONGODB_URI=${uri('dubly_app', 'dubly')}
MONGODB_DB=dubly

# For npm test:
MONGODB_TEST_URI=${uri('dubly_test', 'dubly_test')}
`;
writeFileSync(outFile, text, { mode: 0o600 });
console.log(`users dubly_admin, dubly_app and dubly_test created; credentials written to ${outFile}`);
