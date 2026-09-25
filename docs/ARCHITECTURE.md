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

Each line is voiced by Gemini-TTS with a style prompt: the project's emotion plus the line's `delivery`, which transcription hears in the original. The standard model is `GEMINI_TTS_MODEL` (GA `gemini-2.5-flash-tts`). Users who turn on **premium voices** get `GEMINI_TTS_PREMIUM_MODEL` (`gemini-3.1-flash-tts-preview`, about twice the voice cost) first, with the standard model as its fallback. Chirp3-HD comes last. A model that is out of quota, refuses a language or has been withdrawn is skipped for a while. A take made with the premium model is never served from cache to a user without it. Bengali is sent to Gemini voices as `bn-BD`, because they refuse `bn-IN`. The workspace glossary swaps in pronunciations for the spoken text only.

What makes a line sound performed rather than read:
- **Performance tags.** Transcription marks laughs and sighs it hears (`TranscriptSegment.performance`), and translation keeps them in place and may not invent any (`src/lib/performanceTags.ts`). Gemini-TTS performs `[laughing]`, `[sigh]`, `[whispering]`, `[short pause]` and the other allowed tags; editors can insert them too. Chirp3-HD, cloned voices, captions and SRT/VTT get the plain words.
- **Speakers.** Transcription also hears each speaker's gender and age (`project.speakerProfiles`). Translation uses them for gendered grammar and a consistent formal or informal "you". Casting gives each speaker a distinct voice of their own gender (`speakerProfiles.ts`), and the studio seeds each language's voice from the main speaker's gender.
- **Paid extras** are Settings toggles, **off by default**, because each adds to the provider bill: `aiReview`, `premiumVoices` and `paceRetakes`. The user who starts a dub decides for that dub.
- **Pace first** (preference `paceRetakes`). A take that overruns its room, or is far shorter than the original line, is re-voiced once with a pace direction (`speechStyle.paceRequest`), before condensing the text or time-stretching the audio.
- **AI review** (preference `aiReview`). `dubDirector.ts` sends each take with its original line to `GEMINI_REVIEW_MODEL` in batches of 8. The reviewer flags garbled speech, missing words, mispronunciation, the wrong language or the wrong emotion. A rejected Gemini or cloned take is re-recorded once with the reviewer's direction and kept only if the reviewer accepts it. Otherwise the line gets the `director` review flag and `directorNote`. A failed review batch never fails the dub.
- **Levels.** Each line is set relative to the others as the original speaker spoke it: whispers stay low and shouts stay loud (`levelMatch.ts`, ±4 dB). The finished track is then levelled to the original's EBU R128 loudness, with two-pass `loudnorm` bounded to −24…−12 LUFS. After rendering, every line records a `renderKey` (a fingerprint of its text, delivery, voice and voice settings) and its review flags. A **retake** is an ordinary dub job for one language whose reserved minutes cover only the lines whose fingerprint no longer matches; the TTS cache makes the unchanged lines free to re-voice.

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
| `server/lib/speechStyle.ts`, `glossary.ts`, `glossaryStore.ts`, `lineReview.ts`, `retake.ts` | Voice direction and pace, workspace glossary, line review flags, line fingerprints and retake pricing |
| `server/lib/dubDirector.ts`, `levelMatch.ts`, `speakerProfiles.ts`, `src/lib/performanceTags.ts` | AI review and retakes, per-line levels, speaker profiles and casting, performance tags |
| `server/lib/storageUsage.ts`, `recordSweeper.ts`, `tmpSweeper.ts` | Usage measurement and data retention |
| `src/services/*`, `src/lib/apiClient.ts` | Frontend API layer |

## Scaling beyond one instance (not done; what it would take)
- Move rate-limit counters and the membership/account caches to a shared store, or accept per-instance limits.
- Replace the in-memory dub queue and heavy slots with Firestore leases or Cloud Tasks. Jobs already persist their state and heartbeat, so ownership would carry over.
- Give each instance an ID in the job heartbeat and reconcile only other instances' stale jobs (the heartbeat-based rule already allows this).
