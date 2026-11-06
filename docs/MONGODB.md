# MongoDB

Dubly keeps everything in one MongoDB database: accounts and sessions, workspaces, projects, jobs, shares, and every stored file (GridFS). Nothing else holds application data. The AI providers (Gemini, Cloud TTS) are the only outside services, and they receive media only while a job runs.

## What MongoDB must be

- **A replica set.** A single node is fine, but it must be started with `replSetName` and initiated once. Starting a job, charging minutes, accepting an invitation and settling a job are multi-document transactions, and MongoDB only has those on replica sets. The server refuses to start on a standalone `mongod` and says how to fix it.
- **Access control on.** The app logs in as `dubly_app`, which can only read and write the `dubly` database. Compass and maintenance use `dubly_admin`. Tests use `dubly_test`, limited to `dubly_test`.
- **Listening on 127.0.0.1 only.** Nothing outside the machine can reach the database. From another computer, use an SSH tunnel.
- **Data outside OneDrive or any other synced folder.** Sync tools rewrite files while mongod has them open, and that corrupts WiredTiger.

## Local setup (Windows, no admin rights)

This is the setup on the development PC (2026-11-06):

| What | Where |
|---|---|
| Server binary (MongoDB Community 9.0.4) | `%USERPROFILE%\dubly-mongo\bin\mongod.exe` |
| Config | `%USERPROFILE%\dubly-mongo\mongod.cfg` (localhost, replica set `rs0`, auth on, 1 GB cache) |
| Data | `%USERPROFILE%\dubly-mongo\data\db` |
| Log | `%USERPROFILE%\dubly-mongo\log\mongod.log` |
| Replica-set key | `%USERPROFILE%\dubly-mongo\keyfile` |
| Passwords and connection strings | `%USERPROFILE%\dubly-mongo\CREDENTIALS.txt` |

To set it up on another PC:

1. Download the MongoDB Community Server ZIP for Windows from mongodb.com, check its SHA-256, and copy `bin\mongod.exe` to `%USERPROFILE%\dubly-mongo\bin\`.
2. Create a keyfile (any 756 random bytes, base64) and a `mongod.cfg` like [`deploy/mongo/mongod.conf.example`](../deploy/mongo/mongod.conf.example), with Windows paths.
3. Start it: `npm run db:start` (or `mongod --config %USERPROFILE%\dubly-mongo\mongod.cfg`).
4. Once, right after the first start: `node deploy/mongo/setup-users.mjs %USERPROFILE%\dubly-mongo\CREDENTIALS.txt`. It initiates the replica set and creates the three users with random passwords.
5. Copy `MONGODB_URI`, `MONGODB_DB` and `MONGODB_TEST_URI` from `CREDENTIALS.txt` into `server/.env`.

`npm run dev` starts the local mongod by itself if it is not already running (`predev` runs `deploy/mongo/start-local.mjs`).

### Looking at the data in Compass

Open Compass, choose **New connection**, and paste the `dubly_admin` connection string from `CREDENTIALS.txt` (the line under "Compass / operations"; it points at `127.0.0.1:27017` with `authSource=admin&directConnection=true`). The app's data is in the `dubly` database. Files are in `media.files` (one document per file; `filename` is the storage path) and `media.chunks` (their bytes).

Never edit `sessions`, `authTokens` or `users.passwordHash` by hand. To give someone a new password, send a reset link: `npm run user:create -- person@example.com` prints one for an existing account too.

## Server setup (Linux)

1. Install MongoDB Community from MongoDB's own signed apt repository (see mongodb.com, "Install on Ubuntu/Debian"); it runs as the `mongod` systemd service.
2. Create the keyfile: `openssl rand -base64 756 | sudo tee /etc/mongod.key >/dev/null && sudo chown mongodb:mongodb /etc/mongod.key && sudo chmod 400 /etc/mongod.key`.
3. Use [`deploy/mongo/mongod.conf.example`](../deploy/mongo/mongod.conf.example) as `/etc/mongod.conf`. On a 4 GB machine keep `cacheSizeGB` at 1, or MongoDB takes half the memory from the dubbing work.
4. `sudo systemctl enable --now mongod`, then once: `node deploy/mongo/setup-users.mjs ~/dubly-shared/mongo-credentials.txt`.
5. Put `MONGODB_URI` and `MONGODB_DB` in `~/dubly-shared/server.env`. Keep the credentials file `chmod 600`, outside the release folders.
6. Keep port 27017 closed in the firewall. It only listens on 127.0.0.1 anyway.

To use Compass against the server, open an SSH tunnel (`ssh -L 27018:127.0.0.1:27017 server`) and connect Compass to `127.0.0.1:27018` with the `dubly_admin` login.

## Collections

| Collection | `_id` | Contents |
|---|---|---|
| `users` | `u-<uuid>` | `email` (unique, lower case), `emailVerified`, `passwordHash` (scrypt), `passwordChangedAt`, `disabled`, `displayName`, `avatar` |
| `sessions` | SHA-256 of the session token | `uid`, `createdAt`, `lastSeenAt`, `expiresAt` (TTL), `absoluteExpiresAt`, `userAgent`, `ip` |
| `authTokens` | SHA-256 of the emailed token | `uid`, `purpose` (`verify-email` or `reset-password`), `email`, `expiresAt` (TTL) |
| `userSettings` | uid | Provider choices and `preferences` |
| `workspaces` | `ws-<uuid>` | `name`, `createdAt`, `createdBy`, `plan`, `planUpdatedAt` |
| `members` | `<workspaceId>:<uid>` | `workspaceId`, `uid`, `email`, `name`, `avatar`, `role`, `addedAt`, `addedBy` |
| `memberships` | uid | `workspaceId` (null = no access), `removedFrom`, `awaitingInvite`, `createdViaInvite`, `claimedInviteId` |
| `plans` | `free`, `starter`, `enterprise` | Seeded from the built-in plans on first read; edits here win within a minute |
| `usage` | workspaceId | The minute ledger: `minutesDubbed`, `usagePeriod`, `voiceSecondsCarry`, lifetime counters |
| `glossaries` | workspaceId | `entries`, `updatedAt`, `updatedBy` |
| `projects` | `proj-<uuid>` | Project metadata, always with its `workspaceId`; storage **paths**, never URLs |
| `projectSegments` | `<projectId>:transcript`, `<projectId>:lang:<code>` | `segments` of the transcript or one language |
| `jobs` | `job-<uuid>` | Dub and transcription jobs (see `server/lib/jobs.ts`) |
| `jobIdempotency` | SHA-256 of workspace, project and key | `jobId`, `createdAt` |
| `invites` | SHA-256 of the invitation token | The invitation |
| `shares` | SHA-256 of the share token | The share link |
| `quotaRequests` | `qr-<uuid>` | "Request quota increase" forms |
| `system` | `mediaUrlKey` | The key that signs media URLs (unless `MEDIA_URL_SECRET` is set) |
| `media.files`, `media.chunks` | GridFS | Every stored file; `filename` is its storage path `workspaces/<ws>/projects/<id>/...`, `metadata` holds `contentType`, `sha256`, `workspaceId` |

Every project query includes the caller's `workspaceId`, which always comes from the server-side membership, so a project id from another workspace finds nothing. Indexes are created at startup (`server/lib/mongo.ts`, `server/lib/mediaStore.ts`).

## Files and playback

- Uploads go to a temporary file first, are checked by content (ffprobe), and are then streamed into GridFS in 1 MiB chunks with their SHA-256. A new version of a path is written completely before older versions are removed, so a reader never sees half a file.
- Jobs copy what they need from GridFS to a local scratch folder, because ffmpeg only ever reads local files (a crafted upload must not make it fetch URLs). Downloads are checked against the stored SHA-256.
- Players get signed URLs to `/api/media/...`: an HMAC over the path and an expiry (3 hours; share pages at most 2 hours), served with HTTP Range so videos seek and start playing at once. The URL is the permission, which is what lets `<video>` and share pages work without a session.

## Backups

GridFS puts the videos in the database, so the database backup is the whole backup.

- Back up: `node deploy/mongo/backup.mjs <folder> --keep 7`. It reads every collection from one snapshot, writes `mongodump --gzip` layout, finishes under a temporary name, and keeps the newest 7. Schedule it daily (Task Scheduler on Windows, a systemd timer or cron on Linux).
- **Keep backups on another disk or machine.** A backup on the same disk as the database is lost with it.
- Restore: `node deploy/mongo/restore.mjs <folder>/dubly-<time> --into dubly_restore_check` with the `dubly_admin` URI in `MONGODB_URI`. Check the copy in Compass, then restore into `dubly` with `--drop`. MongoDB's own `mongorestore --gzip --dir <folder>/dubly-<time>` reads the same files.
- Try a restore now and then. A backup that has never been restored is a guess.

## Reliability, honestly

A single mongod on one machine is one point of failure: if that disk dies, everything since the last off-machine backup is gone. That is the trade made for zero running cost. Ways to reduce it, cheapest first: daily backups to another machine (no cost); disk snapshots of the server (small storage cost); a second replica-set member on another machine (doubles the database's hardware).
