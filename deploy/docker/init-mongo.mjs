#!/usr/bin/env node
// Prepares the container's own MongoDB; entrypoint.sh runs it on every start, right after mongod. It makes sure that:
//   - mongod is a single-node replica set, rs0 (Dubly's job, billing and invitation logic needs transactions),
//   - two logins exist, with random passwords kept on the data volume:
//       dubly_admin  root, for restores and Compass only, never used by the app   (/data/secrets/mongo.json and admin-uri, root only)
//       dubly_app    readWrite on the app's database, the app's own login         (/data/app/dubly.env, the app's user only)
// The first start relies on MongoDB's localhost exception (no logins yet). Passwords are chosen and saved before any login is created,
// so a start interrupted half-way finishes the job the next time.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const HOST = '127.0.0.1:27017';
const DB = process.env.MONGODB_DB || 'dubly';
const SECRETS_FILE = '/data/secrets/mongo.json';
const ADMIN_URI_FILE = '/data/secrets/admin-uri';
// Fixed on purpose, not DUBLY_ENV_FILE: that may name a settings file of the operator's own, which this must never overwrite.
const APP_ENV_FILE = '/data/app/dubly.env';
const mongodPid = Number(process.env.MONGOD_PID) || 0;
const startSeconds = Number(process.env.MONGO_START_TIMEOUT_SECONDS) || 300;

const log = (severity, message) =>
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), severity, message, event: 'mongo_init' })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const password = () => randomBytes(24).toString('base64url');
const uri = (user, pass, db) => `mongodb://${user}:${encodeURIComponent(pass)}@${HOST}/${db}?authSource=admin&directConnection=true`; // trufflehog:ignore
const options = { appName: 'dubly-mongo-init', serverSelectionTimeoutMS: 2000 };

function writePrivate(file, text) {
  rmSync(`${file}.new`, { force: true });
  writeFileSync(`${file}.new`, text, { mode: 0o600 });
  renameSync(`${file}.new`, file);
}

const isAuthFailure = (err) => err?.code === 18 || err?.codeName === 'AuthenticationFailed' || /Authentication failed/i.test(String(err?.message));

function mongodAlive() {
  if (!mongodPid) return true;
  try {
    process.kill(mongodPid, 0);
    return true;
  } catch {
    return false;
  }
}

// mongod takes a few seconds to open its files, and longer after an unclean stop, while it replays its journal.
async function waitForMongod() {
  const deadline = Date.now() + startSeconds * 1000;
  for (;;) {
    if (!mongodAlive()) throw new Error('mongod stopped while starting; its own log lines above say why');
    const client = new MongoClient(`mongodb://${HOST}/?directConnection=true`, options);
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      if (Date.now() > deadline) throw new Error(`mongod did not answer within ${startSeconds} s: ${err.message}`);
      await sleep(500);
    }
  }
}

// The admin login, or null while it does not exist yet (the first start).
async function connectAdmin(secrets) {
  const client = new MongoClient(uri('dubly_admin', secrets.admin, 'admin'), options);
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch (err) {
    await client.close().catch(() => undefined);
    if (isAuthFailure(err)) return null;
    throw err;
  }
}

// Initiates the replica set if it has no configuration, then waits until this node accepts writes (a few seconds after every start).
async function ensurePrimary(client) {
  const deadline = Date.now() + 120_000;
  let initiated = false;
  for (;;) {
    const hello = await client.db('admin').command({ hello: 1 });
    if (hello.isWritablePrimary) return;
    if (!hello.setName && !initiated) {
      initiated = true;
      try {
        await client.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: HOST }] } });
        log('INFO', 'replica set rs0 initiated');
      } catch (err) {
        // Right after a restart the stored configuration may not be loaded yet; it is, and the node becomes primary by itself.
        if (err?.codeName !== 'AlreadyInitialized') throw err;
      }
    }
    if (Date.now() > deadline) throw new Error('MongoDB did not become the replica set primary within 2 minutes');
    await sleep(500);
  }
}

async function main() {
  let secrets;
  if (existsSync(SECRETS_FILE)) {
    secrets = JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
  } else {
    secrets = { admin: password(), app: password(), createdAt: new Date().toISOString() };
    writePrivate(SECRETS_FILE, `${JSON.stringify(secrets, null, 2)}\n`);
  }

  const anonymous = await waitForMongod();
  let admin = await connectAdmin(secrets);
  if (!admin) {
    await ensurePrimary(anonymous);
    try {
      await anonymous.db('admin').command({
        createUser: 'dubly_admin',
        pwd: secrets.admin,
        roles: [{ role: 'root', db: 'admin' }],
        mechanisms: ['SCRAM-SHA-256'],
      });
      log('INFO', 'created the dubly_admin login');
    } catch (err) {
      if (err?.codeName === 'Unauthorized' || err?.code === 13) {
        throw new Error(
          `This data volume already has MongoDB logins, and ${SECRETS_FILE} does not hold their passwords. ` +
            'Put back the mongo.json that belongs to this volume, or start on an empty volume.'
        );
      }
      throw err;
    }
    admin = await connectAdmin(secrets);
    if (!admin) throw new Error('the dubly_admin login was created but does not work');
  }
  await anonymous.close();

  await ensurePrimary(admin);
  // Always set, so the role follows MONGODB_DB and the password follows mongo.json, whatever happened before.
  const adminDb = admin.db('admin');
  const roles = [{ role: 'readWrite', db: DB }];
  const { users } = await adminDb.command({ usersInfo: 'dubly_app' });
  if (users.length) {
    await adminDb.command({ updateUser: 'dubly_app', pwd: secrets.app, roles });
  } else {
    await adminDb.command({ createUser: 'dubly_app', pwd: secrets.app, roles, mechanisms: ['SCRAM-SHA-256'] });
    log('INFO', 'created the dubly_app login');
  }
  await admin.close();

  writePrivate(ADMIN_URI_FILE, `${uri('dubly_admin', secrets.admin, 'admin')}\n`);
  writePrivate(
    APP_ENV_FILE,
    '# Written by deploy/docker/init-mongo.mjs on every start. Tools run with `docker compose exec` read it (DUBLY_ENV_FILE).\n' +
      `MONGODB_URI=${uri('dubly_app', secrets.app, DB)}\nMONGODB_DB=${DB}\n`
  );
  log('INFO', `MongoDB is ready (replica set rs0, database ${DB})`);
}

main().then(
  () => process.exit(0),
  (err) => {
    log('ERROR', err?.message || String(err));
    process.exit(1);
  }
);
