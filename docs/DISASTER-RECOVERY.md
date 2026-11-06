# Dubly: backup and disaster recovery

Since 2026-11-06 every piece of Dubly's data, records and files alike, is in one MongoDB database (see [MONGODB.md](MONGODB.md)). Back that database up and you have backed up Dubly. There are no Firestore, Cloud Storage or Firebase Auth backups to look after any more; the old Firebase data was left in place, unused.

**Status: backups are not scheduled yet.** The scripts exist and are tested, but nothing runs them on a timer. Until a daily backup to another machine is running and one restore has been tried, treat Dubly as having **no tested backups**.

## What needs protecting

| Data | Where | Can it be rebuilt? | Protection |
|---|---|---|---|
| Accounts, sessions, workspaces, members, invites, projects and their lines, jobs, usage, shares, settings | MongoDB `dubly` (see the collection list in MONGODB.md) | No | Daily `deploy/mongo/backup.mjs` to another disk or machine |
| Source videos, dubbed audio and video, thumbnails, caption renders, stems | MongoDB GridFS (`media.files`, `media.chunks`) | Renders can be redone (they cost minutes and provider spend); **source uploads cannot** | The same backup: it includes GridFS |
| Scratch files, TTS cache | Server disk: `server/tmp`, `server/cache` | Yes, disposable | None needed |
| MongoDB passwords and keyfile, `server/.env` | The machine running Dubly | Can be re-issued | A copy in a password manager, never only on that machine |
| Application | Git | Yes | GitHub |

## Targets (proposed; confirm with the business)

| | Target | How it is met |
|---|---|---|
| **RPO** (data loss tolerated) | ≤ 24 hours | Daily backup, kept 7 days, on another machine |
| **RTO** (time back to service) | 2 hours | Reinstall MongoDB and Dubly (MONGODB.md, DEPLOYMENT.md), restore the latest backup |

## One-time setup

1. **Pick a backup folder that is not on the database's disk**: an external drive, a NAS, another computer's share. A OneDrive folder also works as an off-machine copy (backups are plain gzip files, not a live database), within its storage quota.
2. **Schedule the backup daily**, e.g. at 03:00:
   - Windows (Task Scheduler): program `node`, arguments `deploy\mongo\backup.mjs D:\dubly-backups --keep 7`, start in the repository folder.
   - Linux (cron): `0 3 * * * cd ~/dubly && node deploy/mongo/backup.mjs /mnt/backup/dubly --keep 7 >> ~/dubly-backup.log 2>&1`
3. **Keep a copy of the credentials** (`CREDENTIALS.txt`, the keyfile, `server/.env`) in a password manager.
4. **Try a restore** (procedure A with `--into dubly_restore_check`) and write the date below.

## Restore procedures

All restores use the `dubly_admin` connection string in `MONGODB_URI` (the app's own login can only reach `dubly`).

### A. Something was deleted or damaged by mistake (most likely incident)
1. Find when it happened, from the logs (request id, `updatedAt`).
2. Restore the last backup from before then into a scratch database: `node deploy/mongo/restore.mjs <folder>/dubly-<time> --into dubly_restore_check`.
3. Look at it in Compass. Copy back only what is affected: the project's `projects` document, its `projectSegments` (`projectId` = the id), and its `media.files` plus their `media.chunks` (`files_id`). Then drop `dubly_restore_check`.

### B. The database is lost or unusable
1. Stop Dubly. Jobs that were running are settled and refunded by reconciliation when it starts again.
2. Start a fresh mongod (MONGODB.md), run `setup-users.mjs`, and restore the latest backup into `dubly`: `node deploy/mongo/restore.mjs <folder>/dubly-<time> --drop`.
3. Start Dubly. Any job left unsettled is failed and refunded, or re-queued, within about 2 minutes (docs/RUNBOOK.md). Everyone signs in again only if their session was newer than the backup.

### C. The machine is lost
Reinstall on another machine: MongoDB (MONGODB.md), then Dubly (DEPLOYMENT.md), then procedure B. Without an off-machine backup, the data is gone; this is why the backup folder must be elsewhere.

### D. An AI provider (Vertex / Cloud TTS) is unavailable
No data is at risk:
- Transient errors are retried with backoff (`server/lib/vertexClient.ts`, `modelRouter.ts`).
- A dub whose languages all fail ends as `failed` with its minutes refunded.
- A partial failure bills only the languages that rendered.

Tell users, and retry once the provider recovers.

## Checklist

| Item | Done (date, who) |
|---|---|
| Daily backup scheduled to another disk or machine | |
| Credentials copied to a password manager | |
| A restore into `dubly_restore_check` tried and checked in Compass | |
