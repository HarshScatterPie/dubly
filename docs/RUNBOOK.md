# Runbook

## Where to look
- **Logs:** in production, each line is JSON with `severity`, `message`, `event`, and the correlation IDs `requestId`, `userId`, `workspaceId`, `jobId`, `projectId` where they apply. Filter by `jsonPayload.jobId="job-…"` to follow one dub end to end, including provider retries.
- **Job records:** `jobs/{jobId}` in Firestore shows status, stage, heartbeat, `errorCode`, `errorMessage` (the internal detail, never shown to users), minutes reserved and refunded, and `providerUsage` (TTS characters, STT seconds, estimated ₹).
- **Users quote a reference:** an error shown with "(ref abcd1234)" is the first 8 characters of a `request_id`. Search logs for `requestId` starting with it.

## Log events
| `event` | When | Key fields |
|---|---|---|
| `http_request` | Every request | `method, route, status, durationMs` |
| `unplanned_error_response`, `unhandled_error` | A 5xx whose detail was hidden from the client | `route, errorMessage, stack` |
| `job_queued` / `job_started` / `job_finished` | Dub or transcription lifecycle | `type, running, waiting` / `languages, queuedMs` / `status, durationMs, completedLanguages, failedLanguages` |
| `job_failed` / `job_cancelled` / `job_superseded` | Unsuccessful ends | `type, errorCode, durationMs` |
| `language_failed` | One language of a dub failed; the others continue | `languageCode` |
| `job_cost` | End of every dub and transcription | `ttsChars, sttSeconds, estimatedInr` |
| `provider_call` / `provider_retry` / `provider_error` | Vertex and TTS calls | `provider, operation, attempts, durationMs` |
| `heavy_slot_wait` | A transcription or caption render had to wait | `inUse, waiting` |
| `records_swept` | Hourly retention sweep | `deleted` |
| `retained_shared_objects` | A deleted project referenced files outside its own folder (kept) | `paths` |

## Log-based metrics (create in Cloud Logging, then chart and alert)
| Metric | Filter | Type / labels |
|---|---|---|
| API requests & latency (p50/p95/p99) | `jsonPayload.event="http_request"` | Distribution on `jsonPayload.durationMs`; labels `route`, `status` |
| 5xx rate | `jsonPayload.event="http_request" AND jsonPayload.status>=500` | Counter |
| Job outcomes | `jsonPayload.event=("job_finished" OR "job_failed" OR "job_cancelled")` | Counter; labels `type`, `status`, `errorCode` |
| Job duration | `jsonPayload.event="job_finished"` | Distribution on `durationMs`; label `type` |
| Failures by stage/language | `jsonPayload.event="language_failed"` | Counter; label `languageCode` |
| Provider errors & latency | `jsonPayload.event=("provider_error" OR "provider_retry" OR "provider_call")` | Counter / distribution; labels `provider`, `operation` |
| Admission pressure | `jsonPayload.event=("job_queued" OR "heavy_slot_wait")` | Counter; gauge from `waiting` |
| Provider spend | `jsonPayload.event="job_cost"` | Distribution on `estimatedInr` |

**Suggested alerts:**
- 5xx rate > 2% over 10 min.
- Any `job_failed` with `errorCode="INTERRUPTED"` outside a deploy.
- `provider_error` > 5 in 10 min.
- `job_queued` sustained > 10 over 15 min (capacity).
- No `http_request` for 10 min during business hours (the service is down).

## Common incidents

**A project is stuck on "processing".**
- The job's heartbeat stops when its process dies. Within about 2.5 minutes, reconciliation marks it failed and refunds its minutes, or re-queues it if it hadn't started.
- **Check:** `jobs/{project.activeJobId}`. If `heartbeatAt` is recent, it's genuinely running, so look at its `stage`.
- **To stop it:** `POST /api/projects/:id/jobs/:jobId/cancel` as a workspace member. A running job stops at its next step.

**Dubs are waiting a long time.**
- `job_queued` events tell you whether it's per workspace (2 at once) or the server (4 at once).
- Raise `MAX_ACTIVE_DUBS` only if CPU and memory headroom allows. Each dub runs ffmpeg and possibly Python workers.

**"Dubly is busy" (503 SERVER_BUSY) on analysis.**
- Transcriptions and caption renders waited more than 10 minutes for one of 3 slots. Check `heavy_slot_wait` and host load.

**Provider outage (Vertex or TTS).**
- Calls retry with backoff. Dubs whose languages all fail end as `failed` with a full refund; partial failures bill only what rendered.
- Nothing to repair afterwards: users retry when the provider recovers.

**A customer disputes minutes.**
- Compare the workspace's `meta/usage` with its jobs (`minutesReserved`, `minutesRefunded`, `status`).
- Settlement is exactly-once, so every job was charged or refunded exactly once.

**A leaked share link.** Turn it off from the project's share dialog, or `DELETE /api/projects/:id/shares/:shareId`. Its page stops at once and any copied video URL within 2 hours.

**A compromised account.** Disable the user in Firebase Auth. Their sessions stop working within 30 seconds. Remove them from the workspace if needed.

**Disk filling up.**
- `server/tmp` is swept hourly (entries older than 6 hours) and after each job. The TTS cache is capped at 1.5 GB.
- Anything else growing is a bug: check `server/tmp/jobs/*` for directories without an active job.

**Restart or deploy.** See DEPLOYMENT.md → Releasing. Use a stop timeout of at least 40 s.

**Data loss or corruption.** See [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).

## Manual recovery helpers
- **Settle a specific job by hand** (it must no longer be running anywhere):
  `npx tsx -e "import('./server/lib/jobs.ts').then(m => m.settleInterruptedJob('job-…')).then(console.log)"`
- **Roll back the project storage split:** `npx tsx server/scripts/unsplit_projects.ts` (dry run), then `--apply`.
