# Dubly — Enterprise Readiness Audit (Phase 0)

- **Date:** 2026-09-24
- **Scope:** the working tree on `main` at `ed4172e`, **including uncommitted changes** (workspaces, sharing, team view)
- **Method:** read-only review of all server code, the frontend auth/API layer, config, rules, and git history. `tsc --noEmit` passes. No code was changed.
- **Status of findings:** findings marked **Confirmed** are proven by the code. Findings marked **Verify** depend on Firebase or GCP console settings that the repo can't show.

---

## 1. What exists today

### Architecture

```
Browser (React 19 + Vite SPA)
   │  Firebase Auth (client SDK) → ID token
   │  fetch /api/*  (Bearer token), polls GET /api/projects/:id every ~1.5s during work
   ▼
Express 4 API — ONE Node process (server/index.ts), also serves dist/ in prod
   ├─ auth:  firebase-admin verifyIdToken → requireWorkspace (Firestore membership lookup)
   ├─ Firestore (Admin SDK, bypasses rules)   workspaces/{ws}/projects, /meta/usage, /members
   │                                          workspaceMembership/{uid}, users/{uid}/voices|meta, shares/{token}
   ├─ Cloud Storage (Admin SDK)               workspaces/{ws}/projects/{id}/*, users/{uid}/voices/*
   ├─ Vertex AI Gemini (STT, translation, condense, Hinglish script)  — service-account key file
   ├─ Google Cloud TTS                                                  — service-account key file
   ├─ Local subprocesses: ffmpeg/ffprobe (2018 build), Python venv workers
   │     (CTC forced alignment, voice clone, Wav2Lip lip-sync, Demucs-style separation), ONNX VAD
   ├─ Optional: Hugging Face ZeroGPU Space for voice cloning (HF_TOKEN)
   └─ Local disk: server/tmp (job scratch), server/cache/tts (≤1.5 GB TTS cache)
```

- **No queue, worker tier, SQL database, Redis, payment provider, or CI.** The dubbing pipeline runs fire-and-forget inside the API process (`server/routes/dub.ts:128`). Transcription and translation run synchronously inside the HTTP request.
- **Tenancy model:** a *workspace* (team) owns projects and the monthly minute allowance. Each user belongs to exactly one workspace (`workspaceMembership/{uid}` pointer) and is either `admin` or `editor`. On a user's first request, a personal workspace is auto-created with that user as admin (`server/lib/workspaces.ts:41-62`).
- **Shared infrastructure:** the Firebase project `scatter-studio-live-2026` is **shared with ScatterStudio**, for Auth, Firestore (`users/{uid}` profile docs that hold `api_key`), and the Storage bucket.
- **Deployment (as documented in code comments):** a single small VM that runs the API, which also serves `dist/`. There's no Dockerfile, no `start` script (the only server script is `tsx watch`), and no IaC. `vite.config.ts` allows any Host header, which suggests the dev server has been exposed through a Cloudflare quick tunnel.

### Environment variables

| Var | Where | Secret? | Notes |
|---|---|---|---|
| `VITE_FIREBASE_*` (6) | `.env` → frontend bundle | No (public client config) | Present in `dist/` by design |
| `PORT`, `WEB_ORIGIN` | `server/.env` | No | CORS origin |
| `VERTEX_PROJECT_ID`, `VERTEX_GEMINI_LOCATION`, `GEMINI_STT_MODEL`, `GEMINI_TRANSLATE_MODEL` | `server/.env` | No | `VERTEX_LOCATION` in `server/.env` is unused (the code reads `VERTEX_GEMINI_LOCATION`) |
| `FIREBASE_STORAGE_BUCKET` | `server/.env` | No | |
| `HF_SPACE_URL`, `HF_TOKEN` | `server/.env` | **`HF_TOKEN` yes** | Server-side only |
| `WEB_PORT`, `API_PORT`, `DISABLE_HMR` | Vite | No | Dev only |
| Files: `server/credentials/gcp-service-account.json`, `firebase-service-account.json` | Disk | **Yes** | Long-lived SA keys; gitignored |

### Critical business workflows

1. Sign in (Firebase email/password or Google). Auto-provision a workspace.
2. Create project, then upload video (multer, ≤500 MB to disk, then GCS) or import a sample by URL.
3. Transcribe (sync request): download from GCS → ffmpeg → Gemini STT (chunked) → sanitize → VAD + CTC alignment → Firestore.
4. Translate (sync request): Gemini, up to 3 languages concurrently.
5. Dub (async, in-process): reserve minutes (transaction) → per language, TTS for each line → stitch → mux → optional lip-sync → upload → refund minutes for languages that failed.
6. Export (optional caption burn-in, cached in GCS), signed-URL download, 24 h public share link.
7. Team management: add, remove, and change roles of members; rename the workspace.
8. Voice cloning (upload a sample → STT → store) and the Text-to-Voice studio.

### Existing controls worth keeping

- Every project read and write goes through `workspaces/{workspaceId}/projects/{id}`, with the workspace resolved server-side from the token. Changing a project ID alone can't reach another tenant's project (**no plain IDOR on projects**).
- Media is stored as bucket paths. Clients only ever receive signed URLs.
- Minute quota is reserved atomically in a Firestore transaction *before* work starts, and failed languages are refunded.
- `PATCH /projects/:id` uses a field whitelist, and `languageOutputs` storage paths can't be set by clients.
- The profile endpoint whitelists fields, so ScatterStudio's `api_key` never leaves the server.
- Share tokens are 128-bit random, expire after 24 h, and the share page escapes HTML.
- Transient Vertex and TTS errors get bounded retries with backoff. A failure in one language doesn't discard the others.
- No secrets appear in git history. `.env*` and the credentials are gitignored, and `.env.example` exists.
- `tsc --noEmit` is clean.

### Not applicable (not invented)

The following phases of the hardening brief have no current counterpart. They are recorded as gaps only where they matter:

- **Payments and webhooks (Phase 14):** there is no payment provider, subscription, or webhook. `activePlan` is hard-coded to `'Starter'` and the limit is a fixed 120 min per workspace per month.
- **Queue and Redis (Phase 8):** none exist. Reliability is handled under C-2 and H-1.
- **SQL (Phase 10):** the database is Firestore. SQL constraints and migrations become document-shape and index concerns.

---

## 2. Findings

Severity legend: **CRITICAL** means exploitable now, or able to lose or corrupt customer data or money. **HIGH** means a serious risk that needs fixing before enterprise customers. **MEDIUM** means a real weakness with limited blast radius. **LOW** means hygiene.

### Summary

| ID | Area | Finding | Severity | Status |
|---|---|---|---|---|
| C-1 | AuthZ / Multi-tenancy | Any user can pull another user (and all their projects) into their own workspace | **CRITICAL** | Confirmed |
| C-2 | Reliability | Any unhandled async error crashes the process and kills every running dub. Jobs stay stuck in `processing` with minutes charged | **CRITICAL** | Confirmed |
| H-1 | Idempotency / Billing | No guard against duplicate dub runs, so double charges and clobbered outputs | HIGH | Confirmed |
| H-2 | AuthN | Any workspace admin (every new user) can create logins in the shared ScatterStudio identity and enumerate emails | HIGH | Confirmed |
| H-3 | API / SSRF | `import-sample` fetches any URL server-side, unbounded | HIGH | Confirmed |
| H-4 | Cost abuse | No rate limits. STT, translation, TTS studio, cloning and caption renders are unmetered | HIGH | Confirmed |
| H-5 | AuthN / Billing | Any account in the shared Firebase project gets a free workspace. Open sign-up would give unlimited quota | HIGH | Verify |
| H-6 | Storage / Multi-tenancy | Repo security rules let clients write their own voice docs, so the server signs URLs for arbitrary bucket paths | HIGH | Verify |
| H-7 | File security | 2018 ffmpeg build parses untrusted uploads, with no format allow-list | HIGH | Confirmed |
| H-8 | Reliability / Capacity | No limit on concurrent dubs or transcriptions on a single VM | HIGH | Confirmed |
| H-9 | Data model | Whole project (all segments, word timings, all languages) in one Firestore doc, capped at 1 MiB | HIGH | Needs measurement |
| H-10 | Testing / CI/CD | No test runner, no CI, no reproducible production start | HIGH | Confirmed |
| H-11 | Backup / DR | No evidence of Firestore PITR or exports, or bucket versioning, in a project shared with ScatterStudio | HIGH | Verify |
| M-1 | AuthN | `verifyIdToken` without revocation check | MEDIUM | Confirmed |
| M-2 | Storage | 6-day signed URLs outlive membership. Share tokens are written to logs | MEDIUM | Confirmed |
| M-3 | Errors | Raw internal error messages returned to clients, and no request IDs | MEDIUM | Confirmed |
| M-4 | API validation | No schema validation on request bodies | MEDIUM | Confirmed |
| M-5 | API security | No security headers. Dev server configured for public exposure | MEDIUM | Confirmed / Verify |
| M-6 | Data lifecycle | Orphaned files, shared storage paths across copied projects, no account or workspace deletion, no temp sweeper | MEDIUM | Confirmed |
| M-7 | Usage | Storage usage inaccurate and unenforced. Zero-duration probe means a free dub | MEDIUM | Confirmed |
| M-8 | Jobs | No job record, state machine, cancellation or error codes | MEDIUM | Confirmed |
| M-9 | Timeouts | ffmpeg and Vertex calls have no timeouts. Long synchronous HTTP requests | MEDIUM | Confirmed |
| M-10 | Logging / Observability | Unstructured console logs, no metrics, no correlation | MEDIUM | Confirmed |
| M-11 | Secrets | SA key files in a OneDrive-synced folder, long-lived keys, rotation undocumented | MEDIUM | Confirmed |
| M-12 | Scalability | Single-instance-only design (in-memory caches, in-process jobs, local disk) | MEDIUM | Confirmed |
| L-1 | Hygiene | Committed dev scripts enumerate all users | LOW | Confirmed |
| L-2 | Docs | README and package name are AI Studio boilerplate | LOW | Confirmed |
| L-3 | Maintainability | Very large UI components | LOW | Confirmed |
| L-4 | API | Settings endpoint accepts arbitrary values | LOW | Confirmed |
| L-5 | Workspaces | A removed member is locked out of Dubly permanently | LOW | Confirmed |

---

### C-1 — Workspace takeover via "add member" · CRITICAL

- **Current implementation:** Every user becomes `admin` of an auto-created personal workspace. `POST /api/workspace/members` (admin-only) calls `addMember`. If the target email already has a login and is the only member of their workspace, the code **copies all of the target's projects into the caller's workspace**, deletes the target's membership, and re-points the target at the caller's workspace. The target isn't asked or notified (`server/lib/workspaces.ts:113-160`).
- **Risk:** Any signed-in user can type a victim's email and gain full access to that victim's videos, transcripts, translations, and dubbed outputs. The victim is silently moved into the attacker's workspace as an editor. This is cross-tenant data exfiltration with one API call.
- **Affected files:** `server/lib/workspaces.ts`, `server/routes/workspace.ts`, `src/components/TeamView.tsx`
- **Recommended solution:** Replace direct add with an **invitation** that the invitee must accept while signed in as that email. Only on acceptance do they leave their old workspace. Never move or copy an existing user's projects on someone else's request. Moving personal projects should be an explicit, invitee-initiated option. Optionally restrict invites to allowed email domains.
- **Migration required?** No schema migration. Adds an `invites` collection. Existing memberships are unaffected.
- **Complexity:** M
- **Dependencies:** a product decision on the invite UX (accept screen versus email link). Pairs with H-2.

### C-2 — Process crash kills in-flight jobs; no recovery · CRITICAL

- **Current implementation:** Express 4 doesn't catch rejected promises from `async` handlers. Most handlers `await` Firestore or Storage without `try/catch` (for example `GET /api/projects`, `PATCH /:id`, `DELETE /:id`, `POST /:id/share`, `GET /api/share/:token`, and the pre-202 part of `/dub`). The server runs on Node 24, where an unhandled rejection **terminates the process**. There is no `unhandledRejection` handler. The dub pipeline lives only in that process's memory (`dub.ts:128`). Nothing on startup finds interrupted jobs. **Evidence:** `server/tmp/jobs/proj-609728a3-…-dub/` still holds a `source.mp4` from a render whose `finally` cleanup never ran.
- **Risk:** One transient Firestore error on any request, or a deploy or restart, kills every running dub and transcription at once. Those projects stay `status: 'processing'` forever, their reserved minutes are **never refunded**, and scratch files pile up on disk.
- **Affected files:** `server/index.ts`, `server/routes/*.ts`, `server/routes/dub.ts`, `server/lib/projectRepo.ts`
- **Recommended solution:**
  1. Wrap async route handlers so rejections reach the error middleware.
  2. Add `unhandledRejection` and `uncaughtException` logging, plus graceful `SIGTERM` handling that stops accepting new jobs and marks running ones as interrupted.
  3. Persist a small **job record** per dub (see M-8) with a heartbeat.
  4. On startup, mark jobs whose heartbeat is stale as `failed` with code `INTERRUPTED`, refund their reserved minutes exactly once, and clean their scratch directory.
  5. Add a periodic temp sweeper.
- **Migration required?** No. New `jobs` fields or collection are additive. Projects already stuck in `processing` are fixed by the same startup reconciliation.
- **Complexity:** M
- **Dependencies:** M-8 (job record), H-1 (single-run guard shares the same record)

### H-1 — Duplicate dub submissions · HIGH

- **Current implementation:** `POST /:id/dub` never checks whether the project is already processing. A double-click, a retry, or two teammates each start a separate pipeline. Each run reserves minutes, both write the same `dubbed_{lang}.mp4` paths, and both race on `languageOutputs`.
- **Risk:** Double minute charges, corrupted or interleaved outputs and progress, and doubled provider spend.
- **Affected files:** `server/routes/dub.ts`
- **Recommended solution:** In one Firestore transaction, check that the project isn't `processing` (or that its job heartbeat is stale), set it to `processing` with a new `jobId`, and reserve minutes. Return `409` if a run is active. Accept an optional `Idempotency-Key` header and return the existing job for a repeated key. Have the pipeline write only if its `jobId` is still current.
- **Migration required?** No
- **Complexity:** S–M
- **Dependencies:** M-8

### H-2 — Admins create logins in the shared ScatterStudio identity; email enumeration · HIGH

- **Current implementation:** `addMember` calls `authAdmin.createUser({ email, password })` for unknown emails, in the Firebase project **shared with ScatterStudio**. Because every new Dubly user is an admin (C-1), anyone can create logins with passwords they choose for any email address. The error messages ("already belongs to another team workspace", "already in this workspace") reveal whether an email has an account.
- **Risk:** Accounts get created in the company identity system for addresses the creator doesn't own, which enables impersonation and phishing. It also exposes a user-enumeration oracle.
- **Affected files:** `server/lib/workspaces.ts:120-129`
- **Recommended solution:** Stop creating passworded accounts. With invites (C-1), a new person signs in with Google or an emailed sign-in link, or uses Firebase's password-reset flow to set their own password. Make the error messages uniform.
- **Migration required?** No
- **Complexity:** S (folded into C-1)
- **Dependencies:** C-1

### H-3 — SSRF and unbounded download in `import-sample` · HIGH

- **Current implementation:** `POST /api/projects/:id/import-sample` takes `sourceUrl` from the body and `fetch`es it server-side with no scheme, host, or size check (`server/routes/projects.ts:584`, `server/lib/ffmpeg.ts:38`). The resulting file bypasses the 500 MB upload limit.
- **Risk:** Server-side requests to internal addresses (the VM's metadata endpoint, localhost services, the LAN). The response is stored and served back to the caller as their "video". The disk can also be filled.
- **Affected files:** `server/routes/projects.ts`, `server/lib/ffmpeg.ts`
- **Recommended solution:** Serve samples by **ID from a server-side allow-list** instead of taking a URL. If URLs must stay, allow only `https`, pin to known hosts, block private and link-local IP ranges after DNS resolution, enforce a byte cap while streaming, and set a timeout.
- **Migration required?** No. Check the frontend caller in `StepUpload.tsx`.
- **Complexity:** S
- **Dependencies:** none

### H-4 — No rate limiting; expensive operations are unmetered · HIGH

- **Current implementation:** Only the dub step consumes quota. `transcribe` (Gemini audio tokens), `translate`, `POST /api/tts/generate` (**no text length cap**, and the body limit is 2 MB), voice-sample transcription, and caption burn-in (full re-encode) can all be called repeatedly without limit. There is no per-user or per-IP rate limiting anywhere.
- **Risk:** Unbounded Vertex and TTS spend from a single account. CPU exhaustion on the single VM, which feeds into H-8.
- **Affected files:** `server/index.ts`, `server/routes/projects.ts`, `server/routes/tts.ts`, `server/routes/voices.ts`, `server/routes/dub.ts`
- **Recommended solution:** Per-uid rate limits (in memory is enough while single-instance; see M-12). A hard text cap on TTS generate (for example 5,000 chars). Cap transcription at a maximum video duration. Either count STT and TTS-studio use against a workspace allowance or cap them daily. Record provider usage per workspace (the cost meter already computes it and only logs it).
- **Migration required?** No
- **Complexity:** M
- **Dependencies:** a product decision on limits

### H-5 — Auto-provisioned free workspace for any account in the shared project · HIGH (Verify)

- **Current implementation:** Any valid Firebase ID token from the shared project gets a workspace with 120 min/month (`resolveMembership` → `createPersonalWorkspace`). Email verification isn't checked. If the project's Email/Password provider allows public sign-up (the Firebase default), anyone can use the public API key in the bundle to create unlimited accounts through the Identity Toolkit REST API.
- **Risk:** Unlimited free quota, so unbounded provider cost. Every ScatterStudio user also becomes a Dubly user by default.
- **Affected files:** `server/lib/workspaces.ts:41-62`, `server/lib/auth.ts`
- **Recommended solution:** **Verify** in the Firebase console whether sign-up is open (and whether an identity-platform blocking function exists). Gate workspace auto-provisioning: require `email_verified`, an allowed domain or allow-list, or an invite. Consider App Check.
- **Migration required?** No
- **Complexity:** S
- **Dependencies:** console access; a product decision on who may use Dubly

### H-6 — Client-writable rules plus unchecked `sampleStoragePath` · HIGH (Verify)

- **Current implementation:** `firestore.rules` and `storage.rules` in this repo let a signed-in user read and write **everything** under `users/{uid}/**` directly from the browser, including `users/{uid}/voices/*` and the ScatterStudio profile doc `users/{uid}` itself. The server trusts `voice.sampleStoragePath` from those docs: `GET /api/voices` mints a signed URL for it, and the dub pipeline downloads it.
- **Risk (if these rules are deployed):** A user writes a voice doc whose `sampleStoragePath` points at another workspace's `source.mp4`, then gets a signed URL for it through the API. That's a cross-tenant file read, though it requires knowing the UUID path. Users could also upload unlimited data straight to the bucket, and overwrite their own ScatterStudio profile, including `role` and `api_key`. Separately, running `firebase deploy` from this repo would **overwrite ScatterStudio's rules**.
- **Affected files:** `firestore.rules`, `storage.rules`, `firebase.json`, `server/lib/customVoices.ts`, `server/routes/voices.ts`
- **Recommended solution:** **Verify** the deployed rules. Change Dubly's rules to deny all client access to Dubly data (the backend uses the Admin SDK anyway), and coordinate ownership of the rules with ScatterStudio. Server-side, reject any `sampleStoragePath` that doesn't start with `users/{uid}/voices/`.
- **Migration required?** No
- **Complexity:** S
- **Dependencies:** coordination with the ScatterStudio owners

### H-7 — Outdated ffmpeg parsing untrusted media · HIGH

- **Current implementation:** `@ffmpeg-installer/ffmpeg` ships ffmpeg build `20181217`. Uploads are accepted when **either** the client MIME type or the extension looks like video (both are client-controlled). ffprobe then probes the file by content with no format allow-list. The stored `contentType` is always `video/mp4`.
- **Risk:** An 8-year-old demuxer and decoder stack with many known CVEs, fed attacker-controlled files. Playlist-style inputs (HLS or concat) can make ffmpeg read other local files or URLs into the output.
- **Affected files:** `package.json`, `server/lib/ffmpeg.ts`, `server/routes/projects.ts`, `server/routes/voices.ts`
- **Recommended solution:** Use a current ffmpeg (a system package or a maintained static build). After probing, require `format_name` to be in an allow-list (`mov,mp4,m4a,3gp,…`, `matroska,webm`), and reject anything with non-file protocols. Pass `-protocol_whitelist file` explicitly. Check magic bytes before probing. Run ffmpeg with CPU and time limits (see M-9).
- **Migration required?** No
- **Complexity:** S–M
- **Dependencies:** deployment image (H-10)

### H-8 — No admission control on CPU-heavy work · HIGH

- **Current implementation:** Each dub or transcription spawns ffmpeg and possibly Python and torch workers, with no global limit on how many run at once. Transcription runs inside the request.
- **Risk:** A few concurrent users can saturate the single VM, causing timeouts, out-of-memory kills (which trigger C-2), and every user's work slowing down.
- **Affected files:** `server/routes/dub.ts`, `server/routes/projects.ts`
- **Recommended solution:** An in-process semaphore for dubs and transcriptions (the `mapWithConcurrency` pattern already exists), with a visible "queued" state and a per-workspace concurrency limit. Moving to a real queue isn't justified until more than one instance is needed (M-12).
- **Migration required?** No
- **Complexity:** S–M
- **Dependencies:** M-8

### H-9 — Firestore 1 MiB document limit on projects · HIGH (needs measurement)

- **Current implementation:** A project doc holds `transcriptSegments` (with per-word timings), `localizedSegments`, and every language's `localizedSegments` inside `languageOutputs`.
- **Risk:** Long videos combined with several languages will exceed 1 MiB, and every later write, progress updates included, fails. The dub then fails partway through.
- **Affected files:** `server/lib/projectRepo.ts`, `server/routes/projects.ts`, `server/routes/dub.ts`
- **Recommended solution:** First **measure** document size against a real 30–60 min, five-language project. If it's close, move segments into sub-documents (`projects/{id}/languages/{code}`), with a read-time fallback to the old shape so existing projects keep working.
- **Migration required?** Yes, if split: a lazy migrate-on-write plus a backfill script. Both are backward compatible.
- **Complexity:** M–L
- **Dependencies:** measurement

### H-10 — No tests, no CI, no reproducible deploy · HIGH

- **Current implementation:** No test runner. The only test-like files are two scripts (`server/scripts/test_*.{ts,py}`). There's no `.github/`, no Dockerfile, and no production `start` script (the server runs via `tsx watch`). `lint` is just `tsc`.
- **Risk:** Regressions to authorization, quota, or the pipeline reach production unnoticed, and deploys can't be reproduced or rolled back.
- **Recommended solution:** Add Vitest with unit tests for workspace authorization, quota reservation and refunds, and job transitions, plus integration tests against the Firebase emulator (including cross-tenant tests). Add a GitHub Actions workflow running typecheck, tests, and build, then `npm audit` and a secret scan. Add a `start` script (`tsx server/index.ts` or a compiled build) and a Dockerfile with a pinned ffmpeg. Tag releases so rollback is possible.
- **Migration required?** No
- **Complexity:** M
- **Dependencies:** none

### H-11 — Backup and disaster recovery unknown · HIGH (Verify)

- **Current implementation:** Nothing in the repo configures Firestore point-in-time recovery or scheduled exports, GCS object versioning, or lifecycle rules. The project is shared with ScatterStudio.
- **Risk:** An accidental delete (including C-1-style moves, or an admin deleting a project) can't be recovered. There are no RPO or RTO targets.
- **Recommended solution:** **Verify** the console settings. Enable Firestore PITR plus a scheduled export to a separate bucket. Enable soft delete or versioning on the media bucket with a retention window. Document the restore procedure and **actually run a test restore** into a scratch project.
- **Migration required?** No
- **Complexity:** S (config) plus S (runbook)
- **Dependencies:** GCP access

### M-1 — Revoked or disabled sessions stay valid up to 1 h · MEDIUM

`verifyIdToken(token)` is called without `checkRevoked`, so a disabled user or revoked session works until the token expires. The membership cache adds up to 15 s after removal. **Fix:** `verifyIdToken(token, true)` (one extra lookup; cache it briefly per uid). Also check `email_verified` (H-5). Files: `server/lib/auth.ts`. Complexity: S.

### M-2 — Signed URLs outlive access; share tokens logged · MEDIUM

Project media URLs are signed for **6 days** (`firebaseAdmin.ts:34`), so a removed member or a leaked URL keeps working. Shares can't be revoked. The request logger prints `originalUrl`, which includes `/api/share/<token>`. **Fix:** shorten URL validity to 1–2 h (the cache window is already 55 min), add `DELETE` for shares, and redact tokens in logs. Files: `server/lib/firebaseAdmin.ts`, `server/routes/share.ts`, `server/index.ts`. Complexity: S.

### M-3 — Internal error text returned to clients · MEDIUM

Handlers return `(err as Error).message` directly: Vertex, GCS, ffmpeg, and Firebase messages, including local paths and provider details. There's no error code or request ID. **Fix:** a central error middleware that returns `{ error: { code, message, request_id } }` and keeps the existing `error` string field so the frontend (`apiClient.ts`) keeps working. Log the details server-side only. Complexity: S–M.

### M-4 — No request schema validation · MEDIUM

Bodies are used as-is. `localizedSegments` and `transcriptSegments` accept arbitrary JSON (which feeds H-9 and makes the caption renderer read unexpected shapes). `voiceSpeed`, `voicePitch`, and the voice maps aren't type-checked. **Fix:** add zod schemas at the route boundary for the write endpoints, with length and array-size caps. Complexity: M.

### M-5 — No security headers; dev server exposure · MEDIUM

There's no `helmet`, CSP, HSTS, or `X-Content-Type-Options`. `vite.config.ts` binds `0.0.0.0` with `allowedHosts: true` for tunnels. **Verify** that production never serves through the Vite dev server. **Fix:** `helmet` (with a CSP that allows GCS media and Firebase auth), and document that production is `npm run build` plus the API only. Complexity: S.

### M-6 — Data lifecycle gaps · MEDIUM

- Project delete doesn't remove `dubbed_captioned_{lang}.mp4`, so those files are orphaned.
- `addMember` and `createPersonalWorkspace` **copy** project docs, so two docs point to the same storage paths. Deleting one breaks the other, and the old copies are never cleaned up. Legacy `users/{uid}/projects` copies are also never removed.
- There's no account or workspace deletion, no retention policy for source uploads, and no sweeper for `server/tmp`. Crash leftovers are already present.

**Fix:** a complete delete (list the prefix `workspaces/{ws}/projects/{id}/`), stop copying docs (C-1), add a tmp sweeper on startup and on an interval, and document retention. Complexity: M.

### M-7 — Usage accounting inaccuracies · MEDIUM

`storageUsedMb` adds the *source* file size once per rendered language and never decreases on delete. `storageLimitMb` isn't enforced. If ffprobe returns duration `0`, the dub reserves 0 minutes. Provider cost is computed (`costMeter`) but only logged. **Fix:** compute storage from the bucket prefix (periodically), reject zero or unknown-duration videos, and persist per-job provider usage. Complexity: S–M.

### M-8 — No explicit job model · MEDIUM

Status lives in project fields (`status`, `progressPercent`, `currentProcessingMessage`). There's no job ID, attempt count, started/finished timestamps, error code, or cancellation. **Fix:** add a `jobs` subcollection record per dub/transcribe with `status` (`queued|running|completed|partially_completed|failed|cancelled`), `stage`, `progress`, `heartbeatAt`, `startedAt`, `finishedAt`, `errorCode`, `minutesReserved`, `minutesRefunded`, and `languages`. Keep mirroring to the existing project fields so the UI doesn't change. Cancellation is a flag the pipeline checks between lines. Complexity: M.

### M-9 — Missing timeouts; long synchronous requests · MEDIUM

ffmpeg and ffprobe calls have no timeout, so one malformed file can hang forever. Vertex calls retry but don't set a per-request deadline. Transcription is a multi-minute synchronous HTTP request that keeps running after the client disconnects. **Fix:** kill ffmpeg after a timeout scaled to duration, set request deadlines on the Vertex and TTS clients, and, as a later step, make transcription asynchronous like dubbing (the client already polls). Complexity: M.

### M-10 — Logging and observability · MEDIUM

Logs are free-text `console.log`, with no request or job ID, user or workspace, stage durations, or error codes. There are no metrics or alerting. `/api/healthz` is unauthenticated and minimal (fine for a liveness check). **Fix:** a small JSON logger (pino) with a request-ID middleware, and job and stage logs carrying `jobId`, `workspaceId`, `stage`, `durationMs`, `errorCode`. Send to Cloud Logging, then build log-based metrics for 5xx rate, job failures by stage, and provider errors. Avoid a metrics stack until there's more than one instance. Complexity: M.

### M-11 — Secrets handling · MEDIUM

Secrets aren't committed (verified in history). However: long-lived service-account **key files** live in `server/credentials/`, and the repo sits in a **OneDrive-synced folder**, so `server/.env` (`HF_TOKEN`) and both SA keys sync to Microsoft cloud storage. Rotation isn't documented. The client Firebase API key in the bundle is expected and not a secret. **Fix:** move the working copy out of OneDrive, or exclude those paths from sync. In production, use the VM's attached service account (ADC) instead of key files. Document rotation. Complexity: S.

### M-12 — Single-instance-only design · MEDIUM

Membership cache, signed-URL cache, workspace-creation dedupe, in-flight pipelines, and scratch files are all process-local. Running two instances would break job ownership and cache invalidation. This is an acceptable **documented constraint** for now. Revisit (Cloud Tasks or a Firestore-backed lease) only when load requires it. Complexity: n/a (document).

### L-1 to L-5

- **L-1:** `server/_check_voice.ts` and `server/_try_voice.ts` are committed and list every `users` doc. Delete them or move them to a gitignored scratch directory.
- **L-2:** `README.md` is the AI Studio template (it mentions `GEMINI_API_KEY`, which no longer exists), and `package.json` is named `react-example`.
- **L-3:** `DubbingStudio.tsx` (988 lines) and `ProjectWorkspace.tsx` (827) mix orchestration, polling and UI. Refactor opportunistically, not as a project.
- **L-4:** `PUT /api/settings` stores any value for `sttProvider`, `translateProvider`, `ttsProvider`. Validate against the enum.
- **L-5:** `removeMember` sets the pointer to `workspaceId: null`, so that person can never use Dubly again unless re-invited. Decide whether they should get a fresh personal workspace instead.

---

## 3. Prioritized backlog

| # | Item | Findings | Severity | Size | Needs from you |
|---|---|---|---|---|---|
| **P0-1** | Replace direct add with accept-to-join invites; stop creating passworded logins; uniform errors | C-1, H-2 | CRITICAL | M | Invite UX decision |
| **P0-2** | Async error wrapper + process handlers + graceful shutdown | C-2 | CRITICAL | S | — |
| **P0-3** | Job record + single-run guard (409) + startup reconciliation (fail stale jobs, refund once, clean tmp) | C-2, H-1, M-8 | CRITICAL | M | — |
| **P0-4** | Validate `sampleStoragePath` prefix server-side; lock down repo rules | H-6 | HIGH | S | Check deployed rules |
| **P0-5** | Remove SSRF: sample import by server-side allow-list | H-3 | HIGH | S | — |
| **P1-1** | Gate auto-provisioning (verified email / domain / invite); check revocation | H-5, M-1 | HIGH | S | Who may use Dubly |
| **P1-2** | Rate limits + TTS text cap + max video duration + concurrency semaphore | H-4, H-8 | HIGH | M | Limit values |
| **P1-3** | Current ffmpeg + format allow-list + ffmpeg timeouts | H-7, M-9 | HIGH | S–M | — |
| **P1-4** | Test harness (Vitest + Firebase emulator): cross-tenant, quota, job tests | H-10 | HIGH | M | — |
| **P1-5** | CI (typecheck, test, build, audit, secret scan) + `start` script + Dockerfile | H-10 | HIGH | M | Target host |
| **P1-6** | Backups: PITR, exports, bucket soft delete, tested restore, DR doc | H-11 | HIGH | S | GCP console access |
| **P1-7** | Measure project doc size; split segments if needed | H-9 | HIGH | M–L | — |
| **P2-1** | Structured errors with codes + request IDs | M-3 | MEDIUM | S–M | — |
| **P2-2** | Structured JSON logging + job/stage fields | M-10 | MEDIUM | M | — |
| **P2-3** | zod validation on write endpoints | M-4, L-4 | MEDIUM | M | — |
| **P2-4** | Shorter signed URLs, revocable shares, token redaction, helmet | M-2, M-5 | MEDIUM | S | — |
| **P2-5** | Complete deletes, tmp sweeper, retention policy | M-6 | MEDIUM | M | Retention period |
| **P2-6** | Accurate storage usage, persist provider cost per job | M-7 | MEDIUM | S–M | — |
| **P2-7** | Move secrets out of OneDrive; ADC in prod; rotation doc | M-11 | MEDIUM | S | — |
| **P3** | Async transcription, docs set (ARCHITECTURE/SECURITY/RUNBOOK/…), L-1–L-5, component refactors | M-9, M-12, L-* | MEDIUM/LOW | M | — |

**Deliberately out of scope until there's a concrete need:** Redis or a queue broker, microservices, Kubernetes, Terraform, and a separate metrics stack. A payment or billing system would be a product feature, not hardening.
