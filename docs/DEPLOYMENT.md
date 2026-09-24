# Deployment

One container runs everything: the API, the built frontend, jobs, and scheduled maintenance. Run **exactly one instance** (see ARCHITECTURE.md → Scaling).

## Build

```bash
docker build -t dubly:<git-sha> \
  --build-arg VITE_FIREBASE_API_KEY=… --build-arg VITE_FIREBASE_AUTH_DOMAIN=… \
  --build-arg VITE_FIREBASE_PROJECT_ID=… --build-arg VITE_FIREBASE_STORAGE_BUCKET=… \
  --build-arg VITE_FIREBASE_MESSAGING_SENDER_ID=… --build-arg VITE_FIREBASE_APP_ID=… .
```
- **Reproducibility:** `npm ci` from `package-lock.json`, and the base image is `node:24-trixie-slim`, which includes Debian's ffmpeg. For byte-for-byte rebuilds, pin the base image by digest (`--build-arg NODE_IMAGE=node:24-trixie-slim@sha256:…`), and tag images by git SHA.
- **Not in the image:** the optional Python engines (CTC word timing, lip-sync, background separation, local voice cloning). They need a torch virtualenv, so without it those features report as unavailable and the app falls back as designed. Voice cloning can still run through `HF_SPACE_URL`.
- **CI** (`.github/workflows/ci.yml`) builds the image on every push and PR, but **doesn't publish or deploy it**. Promotion to production is manual (below).

## Run

```bash
docker run -d --name dubly --restart unless-stopped -p 8787:8787 \
  --stop-timeout 40 \
  -e NODE_ENV=production -e WEB_ORIGIN=https://dubly.example.com -e TRUST_PROXY=1 \
  -e VERTEX_PROJECT_ID=… -e FIREBASE_STORAGE_BUCKET=… \
  -e CREDENTIALS_MODE=adc -e FIREBASE_PROJECT_ID=scatter-studio-live-2026 \
  -v dubly-cache:/app/server/cache \
  dubly:<git-sha>
```
- **Credentials:** prefer `CREDENTIALS_MODE=adc` with the VM or Cloud Run service account (permissions are listed in SECURITY.md). If key files are unavoidable, mount them read-only: `-v /secure/dubly-credentials:/app/server/credentials:ro`. Never bake them into the image.
- **Secret settings** such as `HF_TOKEN` come from the platform's secret manager as environment variables, or from a mounted env file with `DUBLY_ENV_FILE`.
- **Stop timeout:** `--stop-timeout` must be longer than `SHUTDOWN_GRACE_MS` (25 s). Docker's default of 10 s would kill the drain before it finishes.
- **Health checks:** `GET /api/healthz` answers 200 as long as the process serves requests; the image's `HEALTHCHECK` uses it.
- **Behind a proxy:** set `TRUST_PROXY` to the number of proxy hops, so per-IP limits see real client addresses and HSTS is sent.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8787 | Listen port |
| `WEB_ORIGIN` | http://localhost:3000 | The only CORS origin allowed |
| `VERTEX_PROJECT_ID`, `VERTEX_GEMINI_LOCATION`, `GEMINI_STT_MODEL`, `GEMINI_TRANSLATE_MODEL` | —, global, gemini-3.5-flash-lite ×2 | AI providers |
| `FIREBASE_STORAGE_BUCKET` | — | Media bucket |
| `CREDENTIALS_MODE` / `FIREBASE_PROJECT_ID` | keyfile / — | `adc` = no key files |
| `CREDENTIALS_DIR`, `DUBLY_ENV_FILE` | server/credentials, server/.env | Secret locations |
| `HF_SPACE_URL`, `HF_TOKEN` | — | Optional GPU voice cloning |
| `NODE_ENV`, `LOG_FORMAT` | —, json when production | Logging format |
| `TRUST_PROXY` | unset | Proxy hops |
| `SHUTDOWN_GRACE_MS` | 25000 | Drain window on SIGTERM |
| `FFMPEG_PATH`, `FFPROBE_PATH` | npm builds (image: /usr/bin/…) | Media binaries |
| `FFMPEG_QUICK_TIMEOUT_MINUTES`, `FFMPEG_RENDER_TIMEOUT_MINUTES` | 5, 120 | ffmpeg kill timeouts |
| `TRANSCRIBE_TIMEOUT_MINUTES` | 45 | Transcription job timeout |

### Limits
| Variable | Default | Meaning |
|---|---|---|
| `MAX_VIDEO_MINUTES` | 60 | Longest source video accepted |
| `MAX_DUBS_PER_WORKSPACE` | 2 | Dubs rendering at once per workspace; more are queued |
| `MAX_ACTIVE_DUBS` | 4 | Dubs rendering at once on the server |
| `MAX_HEAVY_REQUESTS` / `HEAVY_WAIT_SECONDS` | 3 / 600 | Concurrent transcriptions and caption renders / how long one waits before `503` |
| `STORAGE_LIMIT_MB` / `ENFORCE_STORAGE_LIMIT` | 2048 / false | Allowance shown on the Usage page / refuse uploads past it |
| `RATE_API_PER_MINUTE` | 600 | Any authenticated request, per user |
| `RATE_TRANSCRIBE_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 20 / 60 | |
| `RATE_TRANSLATE_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 40 / 120 | |
| `RATE_DUB_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 30 / 90 | Dub starts |
| `RATE_TTS_PER_HOUR` | 200 | Text-to-voice generations (no text length limit) |
| `RATE_VOICE_CLONE_PER_HOUR` | 10 | |
| `RATE_EXPORT_PER_HOUR` | 30 | Export and captioned-render requests |
| `RATE_IMPORT_SAMPLE_PER_HOUR` / `RATE_UPLOAD_PER_HOUR` | 20 / 30 | |
| `RATE_INVITE_ACCEPT_PER_HOUR` | 30 | Invite preview and accept |
| `RATE_SHARE_VIEW_PER_MINUTE` | 60 | Public share page, per IP |

The monthly minute allowance is 120 minutes per workspace, set in `server/lib/projectRepo.ts`.

## Releasing
1. Merge to `main` with CI green: typecheck, tests, build, audit, secret scan, image build.
2. Build `dubly:<sha>` and push it to your registry.
3. On the host: pull, then `docker stop dubly` (it drains), then `docker run … dubly:<sha>`. Queued dubs survive the restart. Dubs that were rendering and don't finish within the grace period are marked failed and refunded, and users see "interrupted by a server restart".
4. Smoke test: `/api/healthz`, then sign in and open a project.

## Rollback
- **App:** run the previous image tag (step 3 with the old SHA). Nothing in the data needs undoing, with one exception:
- **Project storage split** (introduced with this hardening): images from **before** the split can't read split projects. Either roll forward, or run `npx tsx server/scripts/unsplit_projects.ts --apply` with production credentials **before** starting an older image. It lists any project too large to rejoin.
- **Invitations:** older images still offer the old "add member" flow. Don't roll back past the invitation change unless you accept reopening finding C-1.

## First production rollout checklist
- [ ] Firebase console: self sign-up disabled.
- [ ] Deployed Firestore/Storage rules reviewed ([FIREBASE-RULES.md](FIREBASE-RULES.md)).
- [ ] Runtime service account with the permissions in SECURITY.md; `CREDENTIALS_MODE=adc`.
- [ ] Backups per [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).
- [ ] Log-based metrics and alerts per [RUNBOOK.md](RUNBOOK.md).
- [ ] Firebase web API key restricted to the app's origins.
