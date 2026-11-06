#!/usr/bin/env node
// Backs up the whole Dubly database (every record and every GridFS file) from one consistent point in time, in the same layout
// `mongodump --gzip` writes, so either `node deploy/mongo/restore.mjs` or MongoDB's own `mongorestore --gzip` can restore it.
//
//   node deploy/mongo/backup.mjs <backup-folder> [--keep 7]
//
// Reads MONGODB_URI / MONGODB_DB from the environment, else from server/.env (or DUBLY_ENV_FILE). A backup is written under a
// temporary name and renamed only once complete and checked, so a folder named dubly-<time> is always whole. The newest --keep
// backups are kept, older ones removed. Put the folder on another disk or machine: a backup next to the database dies with it.
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { BSON, MongoClient } from 'mongodb';

const { EJSON } = BSON;

const args = process.argv.slice(2);
const outRoot = args.find((a) => !a.startsWith('--'));
const keepAt = args.indexOf('--keep');
const keep = keepAt >= 0 ? Number(args[keepAt + 1]) : 7;
if (!outRoot || !Number.isInteger(keep) || keep < 1) {
  console.error('usage: node deploy/mongo/backup.mjs <backup-folder> [--keep 7]');
  process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = process.env.DUBLY_ENV_FILE ? path.resolve(process.env.DUBLY_ENV_FILE) : path.join(repo, 'server', '.env');
const fileEnv = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
const uri = process.env.MONGODB_URI || fileEnv.MONGODB_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';
const dbName = process.env.MONGODB_DB || fileEnv.MONGODB_DB || 'dubly';

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const finalDir = path.join(path.resolve(outRoot), `dubly-${stamp}`);
const workDir = `${finalDir}.partial`;

const client = new MongoClient(uri, { appName: 'dubly-backup', serverSelectionTimeoutMS: 10_000 });
await client.connect();
const db = client.db(dbName);
// A snapshot session reads every collection as of the same moment, so a project and its files match even while the app writes.
const session = client.startSession({ snapshot: true });
const summary = {};
try {
  await mkdir(path.join(workDir, dbName), { recursive: true });
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray()).filter((c) => c.type === 'collection' && !c.name.startsWith('system.'));
  for (const info of collections) {
    const name = info.name;
    const file = path.join(workDir, dbName, `${name}.bson.gz`);
    let count = 0;
    const cursor = db.collection(name).find({}, { session, raw: true, batchSize: 200 });
    // raw: true hands over each document's BSON bytes untouched; concatenated, they are exactly a mongodump .bson file.
    const docs = Readable.from(
      (async function* () {
        for await (const doc of cursor) {
          count++;
          yield doc;
        }
      })()
    );
    await pipeline(docs, createGzip(), createWriteStream(file));
    // Index definitions are not data and cannot be read inside a snapshot; they are read as they are now.
    const indexes = await db.collection(name).listIndexes().toArray();
    const metadata = { options: info.options ?? {}, indexes, uuid: '', collectionName: name, type: 'collection' };
    await writeFile(path.join(workDir, dbName, `${name}.metadata.json.gz`), gzipSync(EJSON.stringify(metadata, { relaxed: false })));
    summary[name] = count;
  }
  await writeFile(path.join(workDir, 'backup.json'), JSON.stringify({ database: dbName, createdAt: new Date().toISOString(), counts: summary }, null, 2));
  await rename(workDir, finalDir);
} catch (err) {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  if (err?.codeName === 'SnapshotTooOld') {
    console.error('The backup took longer than MongoDB keeps snapshot history (5 minutes by default). Raise minSnapshotHistoryWindowInSeconds, or use mongodump --oplog.');
  }
  throw err;
} finally {
  await session.endSession();
  await client.close();
}

// Rotation: only folders this script made, newest first; anything else in the folder is left alone.
const existing = (await readdir(path.resolve(outRoot))).filter((n) => /^dubly-\d{8}-\d{6}$/.test(n)).sort().reverse();
for (const old of existing.slice(keep)) await rm(path.join(path.resolve(outRoot), old), { recursive: true, force: true });

const total = Object.values(summary).reduce((a, b) => a + b, 0);
console.log(`backup ${finalDir}: ${Object.keys(summary).length} collections, ${total} documents (${summary['media.files'] ?? 0} files); kept the newest ${keep}`);
