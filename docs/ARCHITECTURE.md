# Architecture

## Overview

```
Browser (React SPA)
  │  Firebase Auth → ID token (Bearer) on every /api call; polls project/job state during long work
  ▼
Dubly server: one Node process (server/index.ts → server/app.ts)
  ├─ Request pipeline: request id + access log → security headers → CORS → JSON (2 MB)
  │                    → requireAuth (token, revocation, per-user rate) → requireWorkspace (tenant)
  │                    → route (rate limits, zod validation) → error normalizer
  ├─ Jobs: dubs and transcriptions run in-process as persisted jobs (server/lib/jobs.ts)
  │     admission: dub queue (2 per workspace, 4 per server) + heavy-work slots (3) for transcription/captions
  ├─ Firestore (Admin SDK)   workspaces, projects (+ content/transcript, languages/{code}), jobs, invites, shares …
  ├─ Cloud Storage (Admin)   workspaces/{ws}/projects/{id}/…  (media, handed out only as short-lived signed URLs)
  ├─ Vertex AI Gemini        speech-to-text, translation, line condensing
  ├─ Google Cloud TTS        synthesis (TTS cache on local disk)
  ├─ ffmpeg / ffprobe        probing, audio extraction, stitching, muxing, captions
  └─ Optional Python helpers (server/lipsync venv): CTC alignment, lip-sync, separation, local cloning
```

The whole deployment is **one process**. It keeps some state only in memory: membership, account and signed-URL caches, rate-limit counters, the dub queue and heavy-work slots. Running two instances side by side isn't supported (see "Scaling" below). This follows from the current deployment; nothing in the code prevents moving on later.

## Tenancy

A **workspace** owns projects and the monthly minute allowance. Each user belongs to exactly one workspace at a time, as `admin` or `editor`, recorded in `workspaceMembership/{uid}`.
- On a user's first request, they get a personal workspace.
- Teams form by **invitation**: an admin creates a link, and the invitee accepts it while signed in with the invited email (`server/lib/workspaces.ts`).
- Every project read and write is addressed as `workspaces/{workspaceId}/projects/{id}`. The workspace ID always comes from the server-side membership lookup, never from the client.

## Long-running work: jobs

`server/lib/jobs.ts` models every dub and transcription as a **job** document (`jobs/{jobId}`):

| Concern | How |
|---|---|
| One operation per project | `project.activeJobId`. Starting a job checks it in the same transaction that creates the job, so a double click or a second teammate gets `409` |
| Double charging | A dub's minutes are reserved in that same transaction. `Idempotency-Key` replays return the original job |
| Only the owner writes | Every progress or result write goes through `writeProjectForJob`, which checks `activeJobId` in the same transaction |
| Crash / restart | The runner updates a heartbeat every 15 s. `reconcileStaleJobs` (at startup and every 60 s) fails jobs whose heartbeat is 90 s stale and refunds their minutes, but **re-queues** dubs that hadn't started yet |
| Exactly-once refunds | `settleJob` records the outcome, refunds and releases the project in one transaction, and only once (`settled`) |
| Cancellation / timeout | `cancelRequested` is checked inside every progress write. Transcriptions also arm a timeout (45 min) |
| Graceful shutdown | SIGTERM: stop accepting work, release queued dubs, wait 25 s for running ones, then settle the rest as interrupted |

Job lifecycle: `queued → running → completed | partially_completed | failed | cancelled`. Transcriptions skip `queued`.

Dub runs go through an in-process admission queue (`server/lib/dubQueue.ts`): at most 2 per workspace and 4 per server, first come first served. Transcriptions and caption renders share 3 "heavy work" slots (`server/lib/heavyWork.ts`). A request waits up to 10 minutes for a slot, then gets `503 SERVER_BUSY`.

### Dub pipeline (per job)
Download the source → optional background separation → for each language: TTS every line (condensing lines that don't fit their slot) → stitch over the ducked background → mux → optional lip-sync → check ownership → upload the outputs → progress written after each language → settle: bill the languages that rendered and refund the rest.

### Transcription pipeline (per job)
Wait for a heavy slot → download → extract 16 kHz audio → Gemini STT in chunks → remove hallucinated filler → VAD alignment → optional CTC word timing (time-boxed) → speakers → settle, with the transcript applied atomically.

## Project storage layout
Measured: a single-document project would exceed Firestore's 1 MiB limit at 60 minutes × 3 languages. So a project is stored as one metadata document plus a `content/transcript` document and one `languages/{code}` document per language. `server/lib/projectStorage.ts` reassembles and splits them transparently, and moves old single-document projects over on their first write. Details are in [DATABASE.md](DATABASE.md).

## Module map

| Path | Responsibility |
|---|---|
| `server/index.ts` | Process lifecycle: listen, reconciliation, sweepers, signals, crash handlers |
| `server/app.ts` | Express app: middleware order, error format, security headers, route mounting |
| `server/routes/*.ts` | HTTP routes (projects, dub, jobs, share, workspace, voices, tts, usage, settings, profile, health) |
| `server/lib/jobs.ts`, `dubQueue.ts`, `heavyWork.ts`, `semaphore.ts`, `lifecycle.ts` | Jobs, admission, shutdown |
| `server/lib/projectRepo.ts`, `projectStorage.ts`, `documentSize.ts` | Project persistence and usage/quota |
| `server/lib/workspaces.ts`, `auth.ts` | Tenancy, invitations, authentication |
| `server/lib/validation.ts`, `rateLimit.ts`, `limits.ts`, `httpError.ts` | Input validation, limits, errors |
| `server/lib/ffmpeg.ts`, `mediaTools.ts`, `mediaValidation.ts`, `safeDownload.ts` | Media handling and safety |
| `server/lib/log.ts`, `costMeter.ts` | Structured logging, provider cost estimates |
| `server/lib/vertexClient.ts`, `googleTtsClient.ts`, `modelRouter.ts`, `voiceClone.ts`, `spaceClone.ts` | AI providers |
| `server/lib/storageUsage.ts`, `recordSweeper.ts`, `tmpSweeper.ts` | Usage measurement and data retention |
| `src/services/*`, `src/lib/apiClient.ts` | Frontend API layer |

## Scaling beyond one instance (not done; what it would take)
- Move rate-limit counters and the membership/account caches to a shared store, or accept per-instance limits.
- Replace the in-memory dub queue and heavy slots with Firestore leases or Cloud Tasks. Jobs already persist their state and heartbeat, so ownership would carry over.
- Give each instance an ID in the job heartbeat and reconcile only other instances' stale jobs (the heartbeat-based rule already allows this).
