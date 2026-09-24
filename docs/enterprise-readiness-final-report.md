# Dubly: enterprise readiness final report

- **Date:** 2026-09-24
- **Baseline:** [enterprise-readiness-audit.md](enterprise-readiness-audit.md)
- **Per-finding status:** [ENTERPRISE-READINESS.md](ENTERPRISE-READINESS.md)

## Executive summary

The audit found two critical and eleven high findings. All of them are now fixed in code and covered by automated tests, except for the parts that live outside this repository: Firebase console settings, GCP backups, and HTTPS for the production VM. CI is green on GitHub, and production now deploys `main` automatically once CI passes.

The biggest changes:
- **Team membership works by invitation.** An admin can no longer take over another user's workspace or create accounts.
- **Long-running work runs as persisted jobs.** Dubs and transcriptions survive crashes and restarts, refund exactly once, can't run twice at the same time, queue fairly, and can be cancelled.
- **Uploads are judged by their content** and processed by a current ffmpeg.
- **Projects are stored in a split layout.** Measurement showed the old layout broke at 60 minutes × 3 languages.

The server now has structured, redacted logs with correlation IDs, one error format, input validation on every write endpoint, and rate limits. There are 188 tests that run against the Firebase emulators and never touch production, plus a CI workflow and a Dockerfile.

**Verdict: READY WITH CONDITIONS** (see "Production readiness" at the end). The code is in a deployable state. The operational guarantees an enterprise customer would ask about (backups, deployed security rules, monitoring) haven't been verified, because that needs console access.

## 1. Implemented fixes

| Area | Change |
|---|---|
| Tenancy (C-1, H-2) | Invitation links: 256-bit token stored hashed, bound to the invited email, 7-day expiry, revocable, idempotent, uniform responses. No account creation and no moving or copying of anyone's data. Removed members go back to their own workspace |
| Crash safety (C-2) | Async-safe router; error middleware; `unhandledRejection`/`uncaughtException`/SIGTERM handling; graceful drain; startup and periodic reconciliation of stale jobs; scratch sweeper |
| Jobs (H-1, M-8) | `jobs` collection: status, stage, heartbeat, attempts, timestamps, error codes, results, provider cost. Start plus minute reservation in one transaction; `409`; `Idempotency-Key`; ownership-guarded writes; exactly-once settlement; cancellation; job API |
| Admission (H-4, H-8) | Rate limits per user, workspace and IP on every expensive endpoint. Dub queue: 2 per workspace, 4 per server, the rest wait. 3 heavy-work slots. 60-minute video limit. No text-to-voice length cap (product decision) |
| Transcription (P3) | Asynchronous job (`Prefer: respond-async`) with a 45-minute timeout and cancellation; the synchronous form is kept for older clients |
| Storage paths (H-6) | Structural check of cloned-voice sample paths; this repo can no longer deploy Firebase rules |
| SSRF (H-3) | Sample import by ID; hardened downloader (HTTPS allow-list, public-IP DNS check, no redirects, timeout, byte cap) |
| Media (H-7, M-9) | ffmpeg 6.1 (development) / Debian ffmpeg (image); content-based format allow-list; protocol whitelist; ffmpeg and ffprobe timeouts |
| Data model (H-9) | Measured document sizes, then a split layout with lazy, in-transaction migration, a size guard and a rollback script |
| Auth (M-1) | Revocation-aware auth (effective within 30 s) |
| Errors and logs (M-3, M-10) | Canonical `{error:{code,message,request_id}}`; generic 5xx text; JSON logs with request/job/user/workspace IDs; secret redaction; event catalogue |
| Validation (M-4, L-4) | zod schemas on all write endpoints, including enums, ranges and sizes |
| URLs and headers (M-2, M-5) | 3-hour signed URLs; hashed, revocable share links with 2-hour media URLs; security headers; strict CSP on share pages; app CSP in report-only |
| Lifecycle (M-6) | Project delete removes its whole storage folder (including caption renders) and its share links, but never paths shared with other projects; record retention sweeper |
| Usage (M-7) | Storage measured from the bucket; optional enforcement; zero-length videos refused; per-job cost recorded |
| Secrets (M-11) | `CREDENTIALS_MODE=adc` (no key files), `CREDENTIALS_DIR`, `DUBLY_ENV_FILE`; rotation documented |
| Hygiene (L-1, L-2) | Debug scripts that listed every user removed; README; package renamed `dubly@1.0.0`; high-severity npm advisories fixed |

## 2. Tests added (188, all passing)

| File | Tests | Covers |
|---|---|---|
| `server/routes/workspace.test.ts` | 14 | Invite existing and new users, wrong user, expired, replayed, duplicate, attacker → victim, projects stay put, no account creation, cross-tenant 404s, roles, removal |
| `server/routes/dub.test.ts` | 12 | Double click, parallel requests, same and different idempotency keys, failure + retry, partial failure billing, quota, draining, stale takeover, refund-once under concurrency, lost ownership |
| `server/routes/jobs.test.ts` | 10 | Async and sync transcription, 409 across job types, safe failure messages, cancel, timeout, crash, cross-tenant jobs, dub cancel (partial and queued refunds) |
| `server/lib/limits.test.ts` | 10 | Rate limiter, semaphore, dub queue (per-workspace, global, freeze), queued dubs end to end, requeue after restart, 429 |
| `server/lib/media.test.ts` | 22 | MP4/WebM/MKV accepted; AVI, image, truncated, silent, zero-length, playlist and concat refused with no network access; every ffmpeg step on the new binary; upload route |
| `server/lib/safeDownload.test.ts` | 42 | IP classification, URL policy, DNS rebinding, size caps, redirects, timeouts, import-sample SSRF |
| `server/routes/voices.test.ts` | 19 | Malicious sample paths (traversal, other users, workspaces, encodings); a tampered voice document is never used or deleted |
| `server/lib/validation.test.ts` | 17 | Real UI payloads accepted; wrong types, enums, ranges, sizes and malformed JSON refused |
| `server/lib/projectStorage.test.ts` | 7 | New layout, legacy read and migration, per-language edits, primary change, cascade delete, rollback script, size guard |
| `server/lib/documentSize.test.ts` | 11 | Size calculator; 30/60 min × 1/3/5/10 language measurements; split layout at maximum size |
| `server/routes/lifecycle.test.ts` | 9 | Share hashing, revocation, tenancy, legacy links; complete delete; storage measurement and enforcement; zero-duration; cost estimate; retention |
| `server/lib/auth.test.ts` | 6 | Valid, missing, malformed, expired, wrong-project, revoked, disabled and deleted sessions |
| `server/lib/reliability.test.ts` | 9 | Async errors don't crash the process, error shape, security headers, shutdown bookkeeping, temp sweeper, log redaction and correlation |

Every test runs against real Firebase **emulators**, with real ID tokens through the real HTTP stack. `server/test/setup.ts` refuses to run otherwise, and the emulator project is a `demo-` project.

## 3. Security improvements
Covered in §1 under tenancy, auth, SSRF, media, storage paths, validation, URLs, headers, errors and secrets. Full details are in [SECURITY.md](SECURITY.md).

**Remaining npm advisories:** 8 moderate in the `firebase-admin@13` chain, which needs a major upgrade. There's also 1 low in esbuild (via `tsx`): it concerns esbuild's dev server on Windows, which Dubly doesn't use, and `npm audit fix` can't clear it.

## 4. Reliability improvements
- Persisted jobs with heartbeat, reconciliation, requeue, exactly-once refunds, cancellation and timeouts.
- Graceful drain on deploy.
- No process crash on route errors.
- Admission control.
- ffmpeg timeouts.
- The Firestore document-size failure removed by the split layout.
- Per-language failure isolation kept from before.

## 5. Observability improvements
- JSON logs with `requestId`/`jobId`/`userId`/`workspaceId`/`projectId` on every line, including lines from provider and library code.
- Access log with route template, status and latency.
- Job, provider, queue and cost events.
- `X-Request-Id` on responses; users see a short reference on server errors.
- Log-based metric and alert definitions in [RUNBOOK.md](RUNBOOK.md). **The metrics themselves still have to be created in GCP.**

## 6. Deployment improvements
- `Dockerfile`: multi-stage; Debian ffmpeg; non-root; tini; health check.
- `.dockerignore`.
- `npm start`.
- GitHub Actions CI: typecheck, emulator tests, build, `npm audit --audit-level=high`, TruffleHog secret scan, Docker build and smoke check.
- `firebase.json` can't deploy rules.
- Configuration, limits, release and rollback are documented in [DEPLOYMENT.md](DEPLOYMENT.md).
- **Production VM (`dubly-app`) now deploys `main` by itself**, but only after that commit's CI run passes. Each release builds in its own folder, is health-checked, and rolls back automatically; the three newest releases are kept for instant rollback. The deployer is pull-based (a systemd timer on the VM), so GitHub holds no keys and the VM needs no inbound access. The VM also got Node 24 (Node 20 is end of life), 2 GB swap, and capacity limits sized for its 2 vCPU / 2 GB. See [DEPLOYMENT.md](DEPLOYMENT.md).

## 7. Remaining risks
0. **Production runs on plain HTTP** (nginx on port 80, the VM's IP address). Sign-in tokens and all API traffic cross the network unencrypted. This is the most urgent remaining item; it needs a domain name plus a TLS certificate (`certbot --nginx`).
1. **Unverified console state.** Self sign-up disabled? Which Firestore/Storage rules are deployed? Backups exist? If the deployed rules allow `users/{uid}/**` writes, users can still write their own voice documents. The server now ignores bad ones, but clients could also upload directly to the bucket.
2. **No load test.** Capacity numbers (4 concurrent dubs, 3 heavy slots) are conservative guesses, not measurements.
3. **The UI changes haven't been browser-tested.** That covers the new Team invite screen, the join dialog, share "turn off", async analysis, and the error-message format. They pass the typecheck and build, and the APIs behind them are tested.
4. **Single instance.** In-memory caches, limits and the queue mean one container only.
5. **Rollback past the storage split** requires running the unsplit script first.
6. **Polling cost.** The UI's 1.5 s project polling now reads 2 + (number of languages) documents per poll.
7. **The app CSP is report-only**, so it doesn't yet block injected scripts.
8. **Secrets in OneDrive.** `server/.env` and the key files on the development machine are still in a OneDrive-synced folder.

## 8. Items requiring GCP / Firebase console access
- [ ] Confirm **self sign-up is disabled** (Authentication → Settings).
- [ ] Review the **deployed Firestore and Storage rules** against [FIREBASE-RULES.md](FIREBASE-RULES.md), with the ScatterStudio owner.
- [ ] Enable **Firestore PITR**, schedule **exports** to a separate-region bucket, confirm **bucket soft delete**, run a **restore test** ([DISASTER-RECOVERY.md](DISASTER-RECOVERY.md)).
- [ ] Create the **runtime service account** (permissions in SECURITY.md) and switch production to `CREDENTIALS_MODE=adc`; delete the long-lived keys.
- [ ] Create the **log-based metrics and alerts** ([RUNBOOK.md](RUNBOOK.md)).
- [ ] Restrict the **Firebase web API key** to the app's origins.
- [x] Run CI on GitHub and confirm the Docker image builds: **done, green**.
- [ ] Point a domain at the VM (34.100.230.64) and enable HTTPS.

## 9. Items requiring product decisions
- Automatic expiry of old projects and media, account deletion, and workspace deletion. Nothing is deleted automatically today.
- Whether to **enforce** the 2 GB storage allowance (`ENFORCE_STORAGE_LIMIT`). It's measured and shown now, but not enforced.
- Whether to add **Cancel** buttons to the UI (the API supports cancelling dubs and analyses).
- Plan limits: the 120 min/month allowance, and whether the rate-limit defaults suit real usage.
- Behaviour changes to confirm:
  - Silent videos (no audio track) are refused at upload; they previously failed later, at analysis.
  - Removed members go back to their own workspace instead of being locked out.
  - Cancelled and failed re-dubs mark the project `failed`, as failures did before.

## 10. Intentionally deferred
- Horizontal scaling (M-12).
- The `firebase-admin@14` upgrade.
- Per-request deadlines on Vertex/TTS calls.
- A lightweight polling endpoint.
- The Python engines in the Docker image.
- Refactoring large UI components (L-3).
- Removing the stale `bun.lock`.
- Load testing (needs staging).
- Browser E2E test.

## 11. Verification commands and results (final run, 2026-09-24, Windows 11, Node 24.16, Java 17)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` (`firebase emulators:exec … "vitest run"`) | **13 files, 188 tests passed**, exit 0 |
| `npm run build` | built, exit 0 |
| `npm audit --omit=dev --audit-level=high` | exit 0: 0 high/critical (8 moderate + 1 low, see §3) |
| Secret scan (pattern scan of the 125 files a commit would include, plus a check that no `.env`/credentials/`tmp`/`dist` paths are included) | none found. One real, public Firebase web key had been copied into a test fixture; it was replaced with a fake |
| Server boot under the emulators (`tsx server/index.ts`) | listening, reconciliation scheduled, `/api/healthz` 200, unauthenticated `/api/projects` 401 |
| Live check of the built-in samples against the new downloader | both allowed, and the flower sample downloaded at its full 1,128,375 bytes |
| GitHub Actions CI | `ae03c0f` and later: **green** (typecheck, tests, build, audit, secret scan, **Docker build**). It first caught a real Linux-only ffmpeg bug, which was fixed |
| Production VM | Deployed by hand (`ae03c0f`), then `f78aaef` **auto-deployed** after CI passed; public `/api/healthz` 200, unauthenticated `/api/projects` 401, security headers present, JSON logs, no startup errors |

## Production readiness: **READY WITH CONDITIONS**

The code changes are complete and verified by tests. Before telling enterprise customers that Dubly is production-grade, these conditions must be met:

1. ~~CI passes on GitHub, including the Docker build.~~ **Done.**
1a. **HTTPS in front of production** (new: production currently serves plain HTTP).
2. The console items in §8 are done, especially backups with a successful restore test, and the deployed rules are reviewed.
3. Someone clicks through the changed UI flows (§7.3) once in a browser.
4. A load test runs against staging, to replace the guessed capacity limits with measured ones.

Until 1–3 are done, treat this as ready for the current users, not as proven enterprise-grade.
