# Dubly

AI video dubbing studio by ScatterPie. Upload a video (up to 60 minutes). Dubly transcribes it, translates it into up to 10 of 45 languages (every major Indian language and dialect among them), voices every line with Google's Gemini and Chirp 3 HD voices, and renders the dubbed video. Teams share projects and a monthly minute allowance through workspaces.

- **Frontend:** React 19 + Vite + Tailwind, in `src/`
- **Backend:** Express 4 on Node 24 (run with `tsx`), in `server/`. The same process also serves the built frontend.
- **Data:** MongoDB only: accounts and sessions, every record, and every stored file (GridFS). See [MONGODB](docs/MONGODB.md)
- **AI:** Vertex AI Gemini 3.5 Flash-Lite (speech-to-text, translation, review), and Google Cloud TTS voices (Gemini 2.5 Flash and Chirp 3 HD) by default. Gemini 3.8 Flash-Lite and Flash TTS (Gemini API) take over with `TTS_ENGINE=gemini` and a paid key.
- **Media:** ffmpeg (the OS package in Docker, the `ffmpeg-static` npm build locally)

## Local development

Requirements: Node 24+, a MongoDB replica set (local setup in [docs/MONGODB.md](docs/MONGODB.md)), and the Google service account for the AI models.

```bash
npm ci
# server/.env: MONGODB_URI, MONGODB_DB, MONGODB_TEST_URI, VERTEX_PROJECT_ID, SMTP_* ... (see .env.example)
# server/credentials/: gcp-service-account.json (Vertex AI + Cloud TTS only)
#   (or set CREDENTIALS_DIR to a folder outside OneDrive; see docs/SECURITY.md)
npm run dev                     # Vite on :3000, API on :8787 (Vite proxies /api)
```

> **Local development uses whatever database `MONGODB_URI` points at.** Automated tests never touch it: they run in a database whose name must end in `_test`, emptied between tests.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # Vitest against MongoDB (MONGODB_TEST_URI, a *_test database); no real data
npm run build       # production frontend bundle into dist/
```

CI runs all of these, plus a dependency audit, a secret scan, and a Docker build that starts the container, restarts it and stops it (`.github/workflows/ci.yml`).

## Run with Docker (one command)

Everything runs in **one container, `dubly`**: the web app, the API and dub workers, its own MongoDB 9.0.4, a daily database backup, and optionally its own tunnel behind the public address. All you need is Docker (Docker Desktop on Windows or macOS) on an x86-64 machine.

```bash
git clone <this repository> && cd dubly
cp deploy/docker/dubly.env.example deploy/docker/dubly.env   # settings: WEB_ORIGIN, VERTEX_PROJECT_ID, SMTP_*, ... (once)
docker compose up -d --build                                 # the one command: builds dubly:latest and starts the container
```

Open http://localhost:8787. On the first start, MongoDB is set up with its own logins inside the container, which takes a few seconds. Create the first account (it prints a link to set the password):

```bash
docker compose exec -u node dubly node --import tsx server/scripts/create_user.ts you@example.com "Your Name"
```

| | |
|---|---|
| Update after `git pull` | `docker compose up -d --build` (the old container drains running dubs first; data stays) |
| Logs / status | `docker compose logs -f` / `docker compose ps` (shows `healthy`) |
| Stop / start | `docker compose stop` / `docker compose start` |
| Data | The `dubly_dubly-data` volume (database, its logins, voice cache). **`docker compose down -v` deletes it all** |
| Backups | Daily at 03:00 into `DUBLY_BACKUP_DIR` (default `./backups`) |
| AI key | `gcp-service-account.json` in `DUBLY_CREDENTIALS_DIR` (default `./server/credentials`), mounted read-only |
| Public HTTPS address | Set `FRONT_DOOR_URL` (the Cloudflare Worker) in `dubly.env`: the container opens its own tunnel behind it |

The port is published on `127.0.0.1:8787` only. Host-side choices (`DUBLY_PORT`, `DUBLY_BIND`, `DUBLY_BACKUP_DIR`, `DUBLY_CREDENTIALS_DIR`, and `DUBLY_EXTRA_CA` on a network that inspects TLS) go in a `.env` file next to `compose.yaml`.

Without Compose, the same container comes from plain Docker (the backup and credentials mounts are left out here):

```bash
docker build -t dubly:latest . && docker run -d --name dubly --restart unless-stopped --stop-timeout 60 \
  -p 127.0.0.1:8787:8787 -v dubly-data:/data --env-file deploy/docker/dubly.env dubly:latest
```

Everything else (moving data in, restore, Compass, another MongoDB, limits) is in [deploy/docker/README.md](deploy/docker/README.md).

## Production

Production is that container, on the office PC, behind `https://dubly.scatterpie.workers.dev` (since 2026-11-12). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, request and job flow, module map |
| [API](docs/API.md) | Every endpoint, error format, limits |
| [DATABASE](docs/DATABASE.md) | Project layout, transactions, indexes, retention |
| [MONGODB](docs/MONGODB.md) | MongoDB setup, users, Compass, collections, files, backups |
| [SECURITY](docs/SECURITY.md) | Auth, tenancy, uploads, secrets and rotation, privacy |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Image, configuration, limits, rollback |
| [RUNBOOK](docs/RUNBOOK.md) | Operating Dubly and handling incidents; log events and metrics |
| [DISASTER-RECOVERY](docs/DISASTER-RECOVERY.md) | Backups, restore procedures, RPO/RTO |
| [AI-LABELLING](docs/AI-LABELLING.md) | Watermarks and AI metadata in dubbed videos, and the rule behind them |
| [ENTERPRISE-READINESS](docs/ENTERPRISE-READINESS.md) | Status of every audit finding |
