# Deployment

Each server process runs everything: the API, the built frontend, jobs, and scheduled maintenance. A machine runs several of them by itself (`WEB_CONCURRENCY`), and any number of machines can share one MongoDB behind a load balancer; set `INSTANCE_COUNT` to the number of machines (see ARCHITECTURE.md → Scaling).

## Current production: the office PC

| | |
|---|---|
| Machine | The Windows PC in the office, next to its local MongoDB (MONGODB.md). The GCE VM is gone, and so is auto-deploy |
| Traffic | `https://dubly.scatterpie.workers.dev` (a Cloudflare Worker, free plan) → a Cloudflare tunnel → `127.0.0.1:8787`. Nothing on the PC listens on the network |
| Process | `deploy/local-prod/run.ps1`: starts MongoDB, the tunnel and the app (`NODE_ENV=production`, `HOST=127.0.0.1`, sign-up closed), checks every 15 s and restarts whatever stopped |
| Files | `%USERPROFILE%\dubly-prod` (logs, the tunnel's address, the Worker's shared secret); the database in `%USERPROFILE%\dubly-mongo`, never inside OneDrive |

Setup, the fixed address and backups are in [deploy/local-prod/README.md](../deploy/local-prod/README.md).

**How a change reaches production:** push to `main` → CI and the Release gate check it on GitHub (≈15–20 min; the gate waits for GitHub's CodeQL scan of the same commit). **Nothing deploys from GitHub.** Once both are green, update the PC by hand: `git pull`, `npm ci` if the lockfile changed, `npm run build`, then `stop.ps1` and `run.ps1` (or end the `node server/index.ts` process and the launcher restarts it within 15 s). Don't update the PC to a commit with a red run.

**What the Release gate checks** (`.github/workflows/release-gate.yml`; each job writes its numbers to the run's summary page):
- **Dub performance and model-call budgets** (`npm run test:perf`, `server/perf/pipeline.perf.ts`): uploads a generated two-voice video, analyses, translates, dubs, re-dubs it unchanged, adds Hinglish, dubs that and retakes one line, all through the real API with real ffmpeg, voice activity and face detection against a throwaway MongoDB; only Google's models are faked (instant, counted, with the ~10 a minute Gemini 2.5 TTS quota). It fails if a step pays for model work it already had (a re-dub with nothing changed must make **no** model call; a one-line retake at most 3 voice and 4 text calls), or exceeds its time per video minute, main-thread stall, API latency during a dub, or memory budget. `PERF_BUDGET_SCALE` scales the time budgets.
- **Production start, headers and bundle size**: the frontend's gzip size (`server/perf/bundle-budget.mjs`), then the server started the way production starts it (`server/perf/prod-smoke.mjs`): boot time, the built app and its security and cache headers (an enforced Content-Security-Policy among them), the API refusing unsigned requests, a 400-request burst, memory, and a clean stop on SIGTERM.
- **Advisories, workflows and code scanning**: no critical advisory in any dependency and no high one in what ships, valid workflows (actionlint), and no open high or critical CodeQL alert on `main` (it waits for CodeQL to finish analysing the commit). `js/missing-rate-limiting` is allowed: CodeQL only recognises third-party rate-limit packages, while every route it reports is limited by `server/lib/rateLimit.ts`, `requireAuth` and the global `express-rate-limit` cap in `server/app.ts`. Dismiss those alerts as false positives on GitHub to keep the Security tab readable.

**Still open:** the tunnel is a quick tunnel (its address changes on every restart; the Worker follows it, but uploads are capped at 100 MB per request and there is no uptime promise). A domain on Cloudflare would give a named tunnel. The PC must stay on and awake.

## Container deployment (alternative)

The same app ships as a Docker image, for hosts that run containers.

## Build

```bash
docker build -t dubly:<git-sha> .
```
- **Reproducibility:** `npm ci` from `package-lock.json`, and the base image is `node:24-trixie-slim`, which includes Debian's ffmpeg. For byte-for-byte rebuilds, pin the base image by digest (`--build-arg NODE_IMAGE=node:24-trixie-slim@sha256:…`), and tag images by git SHA.
- **Not in the image:** the optional Python engines (CTC word timing, lip-sync, background separation). They need a torch virtualenv, so without it those features report as unavailable and the app falls back as designed.
- **CI** (`.github/workflows/ci.yml`) builds the image on every push and PR, but **doesn't publish or deploy it**.

## Run

```bash
docker run -d --name dubly --restart unless-stopped -p 8787:8787 \
  --stop-timeout 40 \
  -e NODE_ENV=production -e WEB_ORIGIN=https://dubly.example.com -e TRUST_PROXY=1 \
  -e VERTEX_PROJECT_ID=… -e CREDENTIALS_MODE=adc \
  -e MONGODB_URI="$(cat /secure/dubly-mongodb-uri)" -e MONGODB_DB=dubly \
  -v dubly-cache:/app/server/cache \
  dubly:<git-sha>
```
- **Database:** the container reaches MongoDB on the host (or a MongoDB container on the same Docker network); it stays bound to localhost or that private network, never a public port. See MONGODB.md.
- **Credentials:** prefer `CREDENTIALS_MODE=adc` with the host's Google service account (a GCE VM or Cloud Run) (permissions are listed in SECURITY.md). If key files are unavoidable, mount them read-only: `-v /secure/dubly-credentials:/app/server/credentials:ro`. Never bake them into the image.
- **Secret settings** such as `GEMINI_API_KEY` and `SMTP_PASS` come from the platform's secret manager as environment variables, or from a mounted env file with `DUBLY_ENV_FILE`.
- **Stop timeout:** `--stop-timeout` must be longer than `SHUTDOWN_GRACE_MS` (25 s). Docker's default of 10 s would kill the drain before it finishes.
- **Health checks:** `GET /api/healthz` answers 200 as long as the process serves requests; the image's `HEALTHCHECK` uses it.
- **Behind a proxy:** set `TRUST_PROXY` to the number of proxy hops, so per-IP limits see real client addresses and HSTS is sent.

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
| `WEB_CONCURRENCY` | `auto` in production (half the cores), else 1 | Server processes on this machine, sharing its port |
| `INSTANCE_COUNT` | 1 | Machines serving this database. Only divides the in-memory flood ceilings between processes; everything else is shared through MongoDB |
| `MAX_ACTIVE_DUBS` | half the cores, at least 2 | Dubs rendering at once on this machine, split between its processes |
| `MAX_HEAVY_REQUESTS` / `HEAVY_WAIT_SECONDS` | 3/8 of the cores, at least 2 / 600 | Concurrent transcriptions and caption renders / how long one waits before `503` |
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
2. Build `dubly:<sha>` and push it to your registry.
3. On the host: pull, then `docker stop dubly` (it drains), then `docker run … dubly:<sha>`. Queued dubs survive the restart. Dubs that were rendering and don't finish within the grace period are marked failed and refunded, and users see "interrupted by a server restart".
4. Smoke test: `/api/healthz`, then sign in and open a project.

## Rollback
- **App:** run the previous image tag (step 3 with the old SHA). Nothing in the data needs undoing, with one exception:
- **MongoDB move (2026-11-06):** images from before it use Firebase and cannot read MongoDB at all; there is no rolling back past it, only forward.
- **Invitations:** older images still offer the old "add member" flow. Don't roll back past the invitation change unless you accept reopening finding C-1.

## First production rollout checklist
- [ ] MongoDB as a replica set, localhost only, access control on, `dubly_app` login ([MONGODB.md](MONGODB.md)).
- [ ] `ALLOW_SIGNUP` set as intended; SMTP configured so confirmation and reset emails go out.
- [ ] HTTPS in front, then `COOKIE_SECURE=true`.
- [ ] Runtime service account with the permissions in SECURITY.md; `CREDENTIALS_MODE=adc`.
- [ ] Backups per [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).
- [ ] Log-based metrics and alerts per [RUNBOOK.md](RUNBOOK.md).
