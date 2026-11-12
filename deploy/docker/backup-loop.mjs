#!/usr/bin/env node
// Daily database backup inside the container; entrypoint.sh starts it when BACKUP_DIR is set (compose.yaml mounts a host folder there).
// Every day at BACKUP_TIME (HH:MM in the container's TZ, 03:00 by default) it runs deploy/mongo/backup.mjs into BACKUP_DIR, which keeps
// the newest BACKUP_KEEP backups (3 by default). The database holds every video too, so this is the whole backup. The folder should live
// on another disk or machine: a backup next to the database is lost with it.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.BACKUP_DIR;
const keep = Number(process.env.BACKUP_KEEP) || 3;
const time = process.env.BACKUP_TIME || '03:00';
const backupScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mongo', 'backup.mjs');

const log = (severity, message, fields = {}) =>
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), severity, message, event: 'backup', ...fields })}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
if (!dir || !match) {
  log('ERROR', `backups are off: BACKUP_DIR must be set and BACKUP_TIME must look like 03:00 (got "${time}")`);
  process.exit(0);
}
const [hour, minute] = [Number(match[1]), Number(match[2])];

function nextRun(now = new Date()) {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

let child = null;
process.on('SIGTERM', () => {
  // A backup is written under a temporary name and renamed only when whole, so stopping half-way leaves no backup that looks complete.
  child?.kill('SIGTERM');
  process.exit(0);
});

function runBackup() {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [backupScript, dir, '--keep', String(keep)], { stdio: 'inherit' });
    child.once('error', (err) => resolve(err.message));
    child.once('exit', (code, signal) => resolve(code === 0 ? 0 : (signal ?? code)));
  }).finally(() => {
    child = null;
  });
}

for (;;) {
  const at = nextRun();
  log('INFO', `next database backup at ${at.toString()} into ${dir} (keeping ${keep})`);
  // Short steps against the wall clock, so a host that slept through the hour still backs up when it wakes.
  while (Date.now() < at.getTime()) await sleep(Math.min(60_000, at.getTime() - Date.now()));
  try {
    await access(dir, constants.W_OK);
  } catch {
    log('ERROR', `backup skipped: ${dir} is not writable by this user (uid ${process.getuid?.()}); give it that owner on the host`);
    continue;
  }
  const started = Date.now();
  const result = await runBackup();
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result === 0) log('INFO', `database backup finished in ${seconds} s`, { seconds });
  else log('ERROR', `database backup failed (${result}) after ${seconds} s; the next one is tomorrow`, { seconds });
}
