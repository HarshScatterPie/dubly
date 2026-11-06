#!/usr/bin/env node
// Restores a backup made by deploy/mongo/backup.mjs (or `mongodump --gzip`) into a database:
//
//   node deploy/mongo/restore.mjs <backup-folder>/dubly-<time> [--into <database>] [--drop]
//
// Refuses to write into a database that already has data unless --drop is given (which empties each restored collection first).
// Restore into a scratch database first (--into dubly_restore_check) and look at it in Compass before touching the real one.
// Connection: MONGODB_URI from the environment, else server/.env; the user needs write access to the target database.
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createGunzip, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { BSON, MongoClient } from 'mongodb';

const { EJSON } = BSON;

const args = process.argv.slice(2);
const source = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--into');
const intoAt = args.indexOf('--into');
const drop = args.includes('--drop');
if (!source || !existsSync(path.join(source, 'backup.json')) && !existsSync(source)) {
  console.error('usage: node deploy/mongo/restore.mjs <backup-folder>/dubly-<time> [--into <database>] [--drop]');
  process.exit(2);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envFile = process.env.DUBLY_ENV_FILE ? path.resolve(process.env.DUBLY_ENV_FILE) : path.join(repo, 'server', '.env');
const fileEnv = existsSync(envFile) ? dotenv.parse(readFileSync(envFile)) : {};
const uri = process.env.MONGODB_URI || fileEnv.MONGODB_URI || 'mongodb://127.0.0.1:27017/?directConnection=true';

const dbDirs = (await readdir(source, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
if (dbDirs.length !== 1) throw new Error(`Expected one database folder in ${source}, found ${dbDirs.join(', ') || 'none'}`);
const sourceDb = dbDirs[0];
const target = intoAt >= 0 ? args[intoAt + 1] : sourceDb;
const dir = path.join(source, sourceDb);

const client = new MongoClient(uri, { appName: 'dubly-restore' });
await client.connect();
const db = client.db(target);
try {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.bson.gz'));
  if (!drop) {
    for (const f of files) {
      const name = f.replace(/\.bson\.gz$/, '');
      if (await db.collection(name).estimatedDocumentCount()) throw new Error(`${target}.${name} already has data; use --drop to replace it, or --into another database`);
    }
  }
  for (const f of files) {
    const name = f.replace(/\.bson\.gz$/, '');
    const collection = db.collection(name);
    if (drop) await collection.deleteMany({});
    // The file is a run of BSON documents, each starting with its own little-endian length.
    let pending = Buffer.alloc(0);
    let batch = [];
    let count = 0;
    const flush = async () => {
      if (batch.length) await collection.insertMany(batch, { ordered: true, bypassDocumentValidation: true });
      count += batch.length;
      batch = [];
    };
    for await (const chunk of createReadStream(path.join(dir, f)).pipe(createGunzip())) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const size = pending.readInt32LE(0);
        if (pending.length < size) break;
        batch.push(BSON.deserialize(pending.subarray(0, size), { promoteBuffers: false }));
        pending = pending.subarray(size);
        if (batch.length >= 500) await flush();
      }
    }
    if (pending.length) throw new Error(`${f} ends with ${pending.length} stray bytes; the backup is damaged`);
    await flush();
    const metaFile = path.join(dir, `${name}.metadata.json.gz`);
    if (existsSync(metaFile)) {
      const { indexes = [] } = EJSON.parse(gunzipSync(readFileSync(metaFile)).toString('utf8'));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const specs = indexes.filter((i) => i.name !== '_id_').map(({ v, ns, ...spec }) => spec);
      if (specs.length) await collection.createIndexes(specs);
    }
    console.log(`restored ${target}.${name}: ${count} documents`);
  }
} finally {
  await client.close();
}
