#!/usr/bin/env node
// Starts the developer's local mongod in the background if nothing is listening on 127.0.0.1:27017 yet (`npm run db:start`,
// and automatically before `npm run dev`). It looks for ~/dubly-mongo/bin/mongod(.exe) with ~/dubly-mongo/mongod.cfg, or the
// paths in DUBLY_MONGOD and DUBLY_MONGOD_CONFIG. On a server, run mongod as a system service instead (docs/MONGODB.md).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 27017;
const base = path.join(homedir(), 'dubly-mongo');
const mongod = process.env.DUBLY_MONGOD || path.join(base, 'bin', process.platform === 'win32' ? 'mongod.exe' : 'mongod');
const config = process.env.DUBLY_MONGOD_CONFIG || path.join(base, 'mongod.cfg');

const listening = () =>
  new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port: PORT });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });

if (await listening()) {
  console.log(`[db] MongoDB is already running on ${HOST}:${PORT}`);
  process.exit(0);
}
if (!existsSync(mongod) || !existsSync(config)) {
  console.warn(`[db] No MongoDB on ${HOST}:${PORT}, and no local install at ${mongod} with ${config}. See docs/MONGODB.md to set one up.`);
  process.exit(0);
}

const child = spawn(mongod, ['--config', config], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
for (let i = 0; i < 40; i++) {
  if (await listening()) {
    console.log(`[db] started MongoDB (pid ${child.pid}) with ${config}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`[db] mongod did not start within 20 s; see the log path in ${config}`);
process.exit(1);
