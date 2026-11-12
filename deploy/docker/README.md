# Dubly in one Docker container

One image, one container named `dubly`, started with one command. Inside it:

| | |
|---|---|
| Frontend | The built React app (`dist/`), served by the API process |
| Backend | Express API and dub workers (`server/index.ts`), on port 8787; it scales its own processes (`WEB_CONCURRENCY`, docs/DEPLOYMENT.md) |
| MongoDB 9.0.4 | Single-node replica set `rs0` on 127.0.0.1 inside the container, access control on. Nothing outside the container can reach it |
| Backups | A daily backup of the whole database (records and every video) into a host folder |

```bash
cp deploy/docker/dubly.env.example deploy/docker/dubly.env   # then fill it in
docker compose up -d --build
```

That builds the image `dubly:latest` and starts the container `dubly`. Open `http://localhost:8787` (or the `DUBLY_PORT` you set). Follow the start with `docker compose logs -f`.

## Files

| File | |
|---|---|
| `Dockerfile` | The image: frontend build, Node 24 runtime with ffmpeg and fonts, `mongod` 9.0.4 (MongoDB's Debian 13 build, pinned by hash) |
| `compose.yaml` | The container: port, volume, backup and credentials mounts, 60 s stop grace, log rotation |
| `deploy/docker/entrypoint.sh` | Starts MongoDB, then the app, then the backup schedule; stops them in order (app first, so dubs drain; then MongoDB). If the app or MongoDB dies, the container exits and Docker restarts it |
| `deploy/docker/init-mongo.mjs` | On every start: replica set initiated, `dubly_admin` and `dubly_app` logins present, app connection written |
| `deploy/docker/backup-loop.mjs` | Runs `deploy/mongo/backup.mjs` daily at `BACKUP_TIME` |
| `deploy/docker/dubly.env.example` | The settings to copy into `deploy/docker/dubly.env` (gitignored) |

## Where things live

- **`dubly-data` volume** (`/data`): `mongo/` (database and the replica-set key), `secrets/` (MongoDB passwords, root only), `app/` (the app's connection file and the voice cache). It survives `docker compose down`, rebuilds and updates. **`docker compose down -v` deletes it, and with it every account and video.**
- **`DUBLY_BACKUP_DIR`** (default `./backups`): daily backups, newest `BACKUP_KEEP` (3) kept. Put it on another disk or machine.
- **`DUBLY_CREDENTIALS_DIR`** (default `./server/credentials`), mounted read-only: `gcp-service-account.json` for Vertex AI and Cloud TTS. On Google Cloud use `CREDENTIALS_MODE=adc` instead.
- **Settings**: `deploy/docker/dubly.env`. Leave `MONGODB_URI`, `HOST` and `PORT` out; the container sets them.

The host-side choices (`DUBLY_BIND`, `DUBLY_PORT`, `DUBLY_BACKUP_DIR`, `DUBLY_CREDENTIALS_DIR`, `DUBLY_EXTRA_CA`) go in the shell or in a `.env` file next to `compose.yaml`.

## Reaching it

The port is published on **127.0.0.1** only, so only this machine sees it. There are three ways to put HTTPS in front:

- **The Worker front door** (production since 2026-11-12, no domain needed): with `FRONT_DOOR_URL=https://dubly.scatterpie.workers.dev` set, the container runs `cloudflared` itself. It opens a Cloudflare quick tunnel and tells the Worker (`deploy/local-prod/worker`) the tunnel's address through `POST /__dubly/origin`, signed with `EDGE_SHARED_SECRET`. The Worker accepts only a `*.trycloudflare.com` address that answers `/api/healthz`. Every minute the container checks the public address; when the tunnel dies, it opens a new one and re-registers within about 30 s. The Worker then takes a minute or two to follow, because KV is eventually consistent. This works on any machine with outbound internet, with no open port. Also set `WEB_ORIGIN` to the same address, `TRUST_PROXY=1` and `COOKIE_SECURE=true`. Quick tunnels have no uptime promise and cap uploads at 100 MB per request (the app uploads in 32 MB pieces).
- **A reverse proxy or tunnel on the same machine** (Caddy, nginx, a named cloudflared tunnel on your own domain): point it at `127.0.0.1:8787`, and set `WEB_ORIGIN=https://…` and `TRUST_PROXY=1`.
- **Published directly** (a cloud load balancer in front, firewall in place): `DUBLY_BIND=0.0.0.0`.

Never serve sign-ins over plain HTTP on the internet. Only one machine may register with the Worker at a time: don't also run the old PC launcher (`deploy/local-prod/run.ps1`), or the two will keep taking the address from each other.

## Everyday commands

```bash
docker compose up -d --build        # first start, and every update after `git pull`; running dubs drain first
docker compose logs -f              # app, MongoDB and backup logs (JSON lines)
docker compose ps                   # "healthy" once /api/healthz answers and MongoDB is up
docker compose restart              # restart in order
docker compose stop                 # stop; data stays
```

First account (with `ALLOW_SIGNUP=false`); it prints a link to set the password:

```bash
docker compose exec -u node dubly node --import tsx server/scripts/create_user.ts you@example.com "Your Name"
```

Other `server/scripts` run the same way. They find the database through `/data/app/dubly.env`.

## Backups and restore

Backup now, on top of the daily one:

```bash
docker compose exec -u node dubly node deploy/mongo/backup.mjs /backups --keep 3
```

Restore needs the admin login. Look at a copy first, then replace the real database:

```bash
docker compose exec dubly sh -c 'MONGODB_URI="$(cat /data/secrets/admin-uri)" node deploy/mongo/restore.mjs /backups/dubly-<time> --into dubly_restore_check'
docker compose exec dubly sh -c 'MONGODB_URI="$(cat /data/secrets/admin-uri)" node deploy/mongo/restore.mjs /backups/dubly-<time> --drop'
docker compose restart              # the app reloads its keys and caches from the restored data
```

### Moving the PC's data into the container

This was done on 2026-11-12 (8 users, 25 projects, 77 files; about 2 minutes):

1. Stop the old launcher, app and tunnel: `deploy/local-prod/stop.ps1`. The PC's MongoDB keeps running and stays untouched, as the copy to fall back to.
2. Back up the PC's database straight into `DUBLY_BACKUP_DIR`: `node deploy/mongo/backup.mjs <DUBLY_BACKUP_DIR> --keep 3` (it reads `server/.env`).
3. Restore it with `--drop` as above. Copy the paid voice cache too, so those clips aren't bought again: `docker cp %USERPROFILE%\dubly-prod\work\cache\tts dubly:/data/app/cache/`, then `docker compose exec dubly chown -R node:node /data/app/cache/tts`. Then `docker compose restart`.
4. Only then set `FRONT_DOOR_URL` in `dubly.env` and `docker compose up -d`, so the public address never shows an empty Dubly.

## Compass

Uncomment the `127.0.0.1:27018:27017` port in `compose.yaml` and set `MONGO_LISTEN_ALL=true` in `dubly.env`, then run `docker compose up -d`. Connect Compass to the URI from `docker compose exec dubly cat /data/secrets/admin-uri`, with the port changed to 27018. The port is on the host's loopback only, and access control stays on.

## Another MongoDB instead

Set `MONGODB_URI` (and `MONGODB_DB`) in `dubly.env`. The built-in MongoDB then stays off, and the daily backup reads that database. It must be a replica set (docs/MONGODB.md).

## Limits

- **x86-64 only**: the DeepFilterNet binary is built for amd64.
- **Don't set a memory limit on the container yet.** The app's memory gate reads the machine's free memory, not the container's limit, so a limit could get it killed mid-dub. MongoDB's cache is capped by `MONGO_CACHE_GB` (1 GB).
- **One MongoDB is one point of failure.** If the volume's disk dies, everything since the last backup is gone. Keep backups off the machine.
- **Networks that inspect TLS** (the office PC's Kaspersky does, for npm, Google's APIs and Gmail): set `DUBLY_EXTRA_CA` to that network's root certificate (PEM). Without it the build fails with `SELF_SIGNED_CERT_IN_CHAIN`, and so do dubs and emails. It is mounted for the build and the app, never stored in the image. A server on a normal network doesn't need it.
