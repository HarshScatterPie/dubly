# Deployment

Each server process runs everything: the API, the built frontend, jobs, and scheduled maintenance. A machine runs several of them by itself (`WEB_CONCURRENCY`), and any number of machines can share one MongoDB behind a load balancer; set `INSTANCE_COUNT` to the number of machines (see ARCHITECTURE.md → Scaling).

## Current production: the Docker container on the office PC

| | |
|---|---|
| Machine | The Windows PC in the office, running Docker Desktop. The GCE VM is gone, and so is auto-deploy |
| Container | `dubly` (`compose.yaml`, [deploy/docker/README.md](../deploy/docker/README.md)): the app and its own MongoDB 9.0.4, `restart: unless-stopped`. Settings in `deploy/docker/dubly.env`, data in the `dubly_dubly-data` volume, daily backups at 03:00 into `%USERPROFILE%\dubly-prod\docker-backups` |
| Traffic | `https://dubly.scatterpie.workers.dev` (a Cloudflare Worker, free plan) → a Cloudflare quick tunnel that the container opens and registers itself (`FRONT_DOOR_URL`) → the app. The container's port is published on `127.0.0.1:8787` only |
| Since | 2026-11-12: the data moved over from the PC's own MongoDB (`%USERPROFILE%\dubly-mongo`), which still holds the copy from the moment of the move. The old launcher (`deploy/local-prod/run.ps1`) is retired; starting it again would take the Worker's address away from the container |
| This network | The office antivirus (Kaspersky) inspects TLS: `DUBLY_EXTRA_CA` in the root `.env` names its root certificate, for the build and for the app's calls to Google and Gmail |

**How a change reaches production:** push to `main` → CI and the Release gate check it on GitHub (≈15–20 min; the gate waits for GitHub's CodeQL scan of the same commit). **Nothing deploys from GitHub.** Once both are green, update the PC by hand: `git pull`, then `docker compose up -d --build`. The old container drains running dubs before the new one starts on the same data. Don't update the PC to a commit with a red run.

**What the Release gate checks** (`.github/workflows/release-gate.yml`; each job writes its numbers to the run's summary page):
- **Dub performance and model-call budgets** (`npm run test:perf`, `server/perf/pipeline.perf.ts`): uploads a generated two-voice video, analyses, translates, dubs, re-dubs it unchanged, adds Hinglish, dubs that and retakes one line, all through the real API with real ffmpeg, voice activity and face detection against a throwaway MongoDB; only Google's models are faked (instant, counted, with the ~10 a minute Gemini 2.5 TTS quota). It fails if a step pays for model work it already had (a re-dub with nothing changed must make **no** model call; a one-line retake at most 3 voice and 4 text calls), or exceeds its time per video minute, main-thread stall, API latency during a dub, or memory budget. `PERF_BUDGET_SCALE` scales the time budgets.
- **Production start, headers and bundle size**: the frontend's gzip size (`server/perf/bundle-budget.mjs`), then the server started the way production starts it (`server/perf/prod-smoke.mjs`): boot time, the built app and its security and cache headers (an enforced Content-Security-Policy among them), the API refusing unsigned requests, a 400-request burst, memory, and a clean stop on SIGTERM.
- **Advisories, workflows and code scanning**: no critical advisory in any dependency and no high one in what ships, valid workflows (actionlint), and no open high or critical CodeQL alert on `main` (it waits for CodeQL to finish analysing the commit). `js/missing-rate-limiting` is allowed: CodeQL only recognises third-party rate-limit packages, while every route it reports is limited by `server/lib/rateLimit.ts`, `requireAuth` and the global `express-rate-limit` cap in `server/app.ts`. Dismiss those alerts as false positives on GitHub to keep the Security tab readable.

**Still open:** the tunnel is a quick tunnel. Its address changes whenever it is replaced (the container re-registers it, and the Worker follows within a minute or two), uploads are capped at 100 MB per request, and there is no uptime promise. A domain on Cloudflare would allow a named tunnel. The PC must stay on and awake, with Docker Desktop starting at sign-in.

## Container deployment (one container)

The whole of Dubly also ships as one Docker image and one container, `dubly`: the built frontend, the API and dub workers, **and its own MongoDB** 9.0.4 (a single-node replica set on the container's loopback, access control on, logins created on first start). A daily backup of the database goes to a host folder. Setup, data migration from the PC, backups, restore and Compass are in [deploy/docker/README.md](../deploy/docker/README.md).

```bash
cp deploy/docker/dubly.env.example deploy/docker/dubly.env   # settings: WEB_ORIGIN, VERTEX_PROJECT_ID, SMTP_*...
docker compose up -d --build                                 # builds dubly:latest and starts the container dubly
```

- **Data:** the `dubly-data` volume (`/data`) holds the database, its logins and the voice cache. `docker compose down -v` deletes it. Backups go to `DUBLY_BACKUP_DIR` (default `./backups`); keep it on another disk or machine.
- **Network:** published on `127.0.0.1:${DUBLY_PORT:-8787}`, so a proxy or tunnel on the same machine gives it HTTPS (`TRUST_PROXY=1`, `WEB_ORIGIN=https://...`). `DUBLY_BIND=0.0.0.0` publishes on every interface. MongoDB is never published.
- **Credentials:** `gcp-service-account.json` comes from `DUBLY_CREDENTIALS_DIR`, mounted read-only, or use `CREDENTIALS_MODE=adc` on Google Cloud. Secrets stay in `dubly.env`, never in the image.
- **Another database:** set `MONGODB_URI` in `dubly.env`, and the built-in MongoDB stays off.
- **Stop timeout:** compose allows 60 s (`docker run --stop-timeout 60`): the app drains for `SHUTDOWN_GRACE_MS` (25 s), then MongoDB shuts down cleanly. Docker's default of 10 s would cut that short.
- **Health checks:** `GET /api/healthz` answers 200 while the process serves and MongoDB answers; the image's `HEALTHCHECK` uses it (90 s start period for a first start).
- **Reproducibility:** `npm ci` from `package-lock.json`; base `node:24-trixie-slim` (Debian's ffmpeg); `mongod` and DeepFilterNet are downloaded pinned by SHA-256. For byte-for-byte rebuilds, pin the base image by digest (`--build-arg NODE_IMAGE=node:24-trixie-slim@sha256:...`) and tag images by git SHA.
- **Not in the image:** the optional Python engines (CTC word timing, lip-sync, background separation by torch). Those features report as unavailable, and the app falls back as designed.
- **CI** (`.github/workflows/ci.yml`) builds the image on every push and PR, and starts it once with its own MongoDB, but **doesn't publish or deploy it**.
- **amd64 only**, and no container memory limit yet (the memory gate reads the machine's free memory).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 8787 | Listen port |
| `NEW_WORKSPACE_PLAN` | free | Plan a newly created workspace starts on (`free`, `starter`, `enterprise`); existing workspaces keep theirs |
| `QUOTA_REQUEST_TO` | the SMTP account (`SMTP_USER`) | Where "Request Quota Increase" forms are emailed; they are also stored in `dublyQuotaRequests` |
| `HOST` | every interface | Listen address. Behind a proxy or tunnel on the same machine set `127.0.0.1`, so nobody can reach the app around it and forge the `X-Forwarded-For` that per-IP limits trust |
| `WEB_ORIGIN` | http://localhost:3000 | The only CORS origin allowed |
| `VERTEX_PROJECT_ID`, `VERTEX_GEMINI_LOCATION`, `GEMINI_STT_MODEL`, `GEMINI_TRANSLATE_MODEL` | —, global, gemini-3.5-flash-lite ×2 | AI providers |
| `TTS_ENGINE` | cloud | `cloud` offers Gemini 2.5 Flash voices (every plan) and Chirp 3 HD voices (Enterprise), both through Google Cloud TTS with no Gemini API key. Chirp 3 HD also voices any line Gemini cannot, and premium voices are off. Santali cannot be dubbed. **Raise the Vertex AI quota** for `gemini-2.5-flash-tts` in the `global` region (about 10 requests a minute by default, measured 2026-09-29), or most lines of a dub fall back to Chirp 3 HD. `chirp` offers only Chirp 3 HD voices; re-takes are off too, and Odia and Santali cannot be dubbed. `gemini` voices each line on its voice's own engine (Gemini 3.8 Flash-Lite, Gemini 3.8 Flash or Chirp 3 HD, as the workspace's plan allows) and needs a paid `GEMINI_API_KEY` |
| `GEMINI_TTS_CLOUD_MODEL` | gemini-2.5-flash-tts | The model behind the Gemini 2.5 Flash voices, on Cloud TTS. Dialects Cloud TTS refuses for Gemini voices (Bhojpuri, Awadhi…) are read under their related language (Hindi); Urdu goes as ur-PK and Arabic as ar-EG |
| `GEMINI_TTS_LITE_MODEL`, `GEMINI_TTS_FLASH_MODEL` | gemini-3.8-flash-lite-tts, gemini-3.8-flash-tts | The models behind the Gemini voices, called through the Gemini API (Cloud TTS does not serve 3.8 yet) |
| `GEMINI_API_KEY` | — | **Needed for Gemini voices.** Sends Gemini 3.8 voices to the Gemini Developer API's Interactions endpoint (verified 2026-09-29: Flash-Lite and Flash, Hindi, Bhojpuri, Odia, Santali). Use a key on a billed project: a free-tier key runs out after about a dozen lines and its content may be used by Google. Unset, they go to Vertex AI (`VERTEX_PROJECT_ID`, service account) through `generateContent`, but on 2026-09-29 Vertex listed both 3.8 TTS models without serving them (Interactions: "Unsupported model interaction"; generateContent: 404 in global, us, us-central1, us-east5, europe-west4, asia-south1, asia-southeast1). Whenever Gemini cannot voice a line, Chirp 3 HD voices it in the same persona, so dubs still complete |
| `GEMINI_TTS_PREMIUM_MODEL` | gemini-3.1-flash-tts-preview | Tried first on Gemini voices, only for users who turn on **Premium voices** (Settings → Paid extras). Served by Cloud TTS (verified 2026-09-24) |
| `GEMINI_REVIEW_MODEL` | gemini-3.5-flash-lite | Listens to every dubbed take next to the original, for users who turn on **AI review** (Settings → Paid extras) |
| `MONGODB_URI`, `MONGODB_DB` | localhost / dubly | **Required.** The database (a replica set) holding all records and files; the `dubly_app` login (MONGODB.md) |
| `ALLOW_SIGNUP` | true | Self sign-up on the login screen; `false` = invitations and `server/scripts/create_user.ts` only |
| `COOKIE_SECURE` | auto | auto marks the session cookie Secure on HTTPS requests and whenever `WEB_ORIGIN` is https; `true` always, `false` never |
| `MEDIA_URL_SECRET` | random, kept in the database | Key for signed media URLs |
| `CREDENTIALS_MODE` | keyfile | `adc` = no key files (Google AI only) |
| `CREDENTIALS_DIR`, `DUBLY_ENV_FILE` | server/credentials, server/.env | Secret locations |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | —, 587, —, —, — | Emails invitations, sign-up confirmations and password resets. Any SMTP account works. Port 465 uses TLS, and 587 uses STARTTLS. `MAIL_FROM` is the sender, e.g. `Dubly <no-reply@scatterpie.io>`. With `SMTP_HOST` or `MAIL_FROM` empty, invitations are shared by link only, and outside production confirmation and reset links are printed to the server log. Invite links use `WEB_ORIGIN`, so it must be the address people open Dubly at |
| `NODE_ENV`, `LOG_FORMAT` | —, json when production | Logging format |
| `TRUST_PROXY` | unset | Proxy hops |
| `SHUTDOWN_GRACE_MS` | 25000 | Drain window on SIGTERM |
| `DUBLY_TMP_DIR`, `DUBLY_CACHE_DIR` | server/tmp, server/cache | Scratch files and the voice cache. Keep both off synced folders: scratch files are users' videos |
| `STT_CHUNK_SECONDS` | 28 | Longest stretch of audio sent to the speech model in one call. Bigger chunks lose speaker labels; see the note in `vertexClient.ts` first |
| `UPLOAD_CHUNK_MB` | 32 | Size of each piece of a large upload; stay well under what the front door takes in one request (100 MB on Cloudflare) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | npm builds (image: /usr/bin/…) | Media binaries |
| `FFMPEG_QUICK_TIMEOUT_MINUTES`, `FFMPEG_RENDER_TIMEOUT_MINUTES` | 5, 120 | ffmpeg kill timeouts |
| `TRANSCRIBE_TIMEOUT_MINUTES` | 45 | Transcription job timeout |

### Limits
| Variable | Default | Meaning |
|---|---|---|
| `MAX_VIDEO_MINUTES` | 60 | Longest source video accepted |
| `MAX_DUBS_PER_WORKSPACE` | 2 | Dubs rendering at once per workspace; more are queued |
| `WEB_CONCURRENCY` | `auto` in production, else 1 | Server processes on this machine, sharing its port. A number fixes it; `auto` scales between `MIN_PROCESSES` and `MAX_PROCESSES` with the load |
| `MIN_PROCESSES` / `MAX_PROCESSES` | 2 / cores − 1 | With `auto`: processes always running / the most it adds. One is added at a time while the event loops are busy (on average 60% or more, or one answering 200 ms late) and memory allows; an idle one is retired after three quiet minutes or when memory runs short. A retired process finishes its work first |
| `INSTANCE_COUNT` | 1 | Only a first guess: every process heartbeats in `instances`, and the live count (all machines and containers) divides the in-memory flood ceilings |
| `MAX_ACTIVE_DUBS` | half the cores, at least 2 | Dubs rendering at once on this machine, however many processes it runs (the supervisor hands out the slots) |
| `MAX_HEAVY_REQUESTS` / `HEAVY_WAIT_SECONDS` | 3/8 of the cores, at least 2 / 600 | Concurrent transcriptions and caption renders on this machine / how long one waits before `503` |
| `MIN_FREE_MEMORY_MB` / `PROCESS_MEMORY_MB` | 1024 / 300 | New dubs, transcriptions and caption renders wait while less memory than this is free (a quarter of it when nothing runs, so work still goes one at a time); a process is added only with this plus one process's worth free |
| `AI_MODEL_RPM` | `gemini-2.5-flash-tts=10` | Requests a minute each AI model may get, as `model=rpm,model=rpm`; calls past it wait their turn, in order, across every process and machine. Unlisted models are not paced, only paused when the provider says it is out of quota. Empty: pace none |
| `AI_QUEUE_MAX_WAIT_MINUTES` / `AI_INTERACTIVE_WAIT_SECONDS` | 30 / 45 | How long a call waits for its model's turn in a background job / while someone waits on the screen (voice previews: then Chirp 3 HD, or `503 VOICES_BUSY`) |
| `AI_QUOTA_PAUSE_SECONDS` | 60 | How long a model is paused for everyone after the provider answers "out of quota" |
| `TTS_ON_QUOTA` | `wait` | A Gemini voice at its quota: `wait` holds the line for the model's turn (slower, same voice, cheaper), and only past the wait allowed does Chirp 3 HD voice it; `chirp` hands it to Chirp 3 HD at once |
| `ONNX_WORKERS` | a quarter of the cores, at least 2 | Worker threads for the face scan and voice-activity detection, started on demand. `0` runs them on the main thread, which freezes the API while they work |
| `STORAGE_LIMIT_MB` / `ENFORCE_STORAGE_LIMIT` | 2048 / true | Allowance per workspace, shown on the Usage page / refuse uploads past it (`false` only shows it) |
| `RATE_API_PER_MINUTE` | 600 | Any authenticated request, per user |
| `RATE_TRANSCRIBE_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 20 / 60 | |
| `RATE_TRANSLATE_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 40 / 120 | |
| `RATE_DUB_PER_HOUR` / `_PER_WORKSPACE_HOUR` | 30 / 90 | Dub starts |
| `RATE_TTS_PER_HOUR` | 200 | Text-to-voice generations and previews. A clip is at most 5,000 bytes of text (Google's limit per request, about 1,600 letters of an Indian script); charged clips use plan minutes |
| `MAX_VOICE_CLIPS_IN_FLIGHT` | 2 | Charged voice clips (Studio voiceovers, line previews) being made at once per workspace; more get `429 VOICE_BUSY` |
| `RATE_EXPORT_PER_HOUR` | 30 | Export and captioned-render requests |
| `RATE_IMPORT_SAMPLE_PER_HOUR` / `RATE_UPLOAD_PER_HOUR` | 20 / 30 | |
| `RATE_INVITE_ACCEPT_PER_HOUR` | 30 | Invite preview and accept |
| `RATE_INVITE_PER_HOUR` / `RATE_INVITE_PER_WORKSPACE_DAY` | 20 / 100 | Invitations created (each may send an email), per admin and per workspace |
| `RATE_SHARE_VIEW_PER_MINUTE` | 60 | Public share page, per IP (its logo has a separate bucket of the same size) |
| `RATE_PAGE_PER_MINUTE` | 300 | The app page (`index.html` for every client-side route), per IP |
| `RATE_LOGIN_PER_15_MINUTES` | 30 | Sign-in attempts, per IP |
| `RATE_LOGIN_FAILURES_PER_EMAIL_IP_15_MINUTES` / `RATE_LOGIN_FAILURES_PER_EMAIL_HOUR` | 10 / 100 | Wrong passwords for one email, from one IP / from everywhere. Past the second, only a browser that has signed in to the account before may try a password |
| `RATE_AUTH_EMAIL_PER_HOUR` / `RATE_AUTH_EMAIL_PER_ADDRESS_HOUR` | 40 / 5 | Sign-in links, reset and confirmation emails, per IP / per email |
| `RATE_AUTH_TOKEN_PER_HOUR` | 60 | Using an emailed link (confirm email, reset, sign-in link), per IP |
| `RATE_SIGNUP_PER_HOUR` | 10 | New accounts, per IP |

The monthly minute allowance is 120 minutes per workspace, set in `server/lib/projectRepo.ts`.

## Releasing
1. Merge to `main` with CI green (typecheck, tests, build, audit, secret scan, image build) and the Release gate green (see above).
2. On the container host: `git pull`, then `docker compose up -d --build`. The new image is built while the old container still serves; then the old one drains and stops, and the new one starts on the same `dubly-data` volume. Queued dubs survive the restart. Dubs that were rendering and don't finish within the grace period are marked failed and refunded, and users see "interrupted by a server restart".
3. Smoke test: `docker compose ps` shows `healthy`, then sign in and open a project.

## Rollback
- **App:** `git checkout <previous sha>` (one that has `compose.yaml`; older images don't contain MongoDB), then `docker compose up -d --build`. Nothing in the data needs undoing, with one exception:
- **MongoDB move (2026-11-06):** images from before it use Firebase and cannot read MongoDB at all; there is no rolling back past it, only forward.
- **Invitations:** older images still offer the old "add member" flow. Don't roll back past the invitation change unless you accept reopening finding C-1.

## First production rollout checklist
- [ ] MongoDB as a replica set, localhost only, access control on, `dubly_app` login ([MONGODB.md](MONGODB.md)).
- [ ] `ALLOW_SIGNUP` set as intended; SMTP configured so confirmation and reset emails go out.
- [ ] HTTPS in front, then `COOKIE_SECURE=true`.
- [ ] Runtime service account with the permissions in SECURITY.md; `CREDENTIALS_MODE=adc`.
- [ ] Backups per [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).
- [ ] Log-based metrics and alerts per [RUNBOOK.md](RUNBOOK.md).
