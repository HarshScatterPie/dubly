# Enterprise readiness: status by finding

Tracks every finding of [enterprise-readiness-audit.md](enterprise-readiness-audit.md).

**Legend:** ✅ fixed and covered by tests · 🟡 fixed in code, but something outside the repo is still needed · 🔧 needs GCP/Firebase console work · ⏸ deferred (reason given).

| ID | Finding | Status | What was done / what remains |
|---|---|---|---|
| C-1 | Workspace takeover via "add member" | ✅ | Invitation links: a hashed 256-bit token plus a matching signed-in email, 7-day expiry, revocable, idempotent. Nobody moved or copied. 14 tests |
| C-2 | Crash kills in-flight jobs | ✅ | Async-safe router, error middleware, crash and signal handlers, graceful drain, persisted jobs with heartbeat, startup and periodic reconciliation, exactly-once refunds, temp sweeper |
| H-1 | Duplicate dub runs | ✅ | Job, ownership and reservation in one transaction; `409`; `Idempotency-Key`; guarded writes |
| H-2 | Admin creates logins, email enumeration | ✅ | No account creation; uniform responses |
| H-3 | SSRF in sample import | ✅ | Sample ID allow-list; HTTPS host allow-list, public-IP DNS check, no redirects, timeout, byte cap |
| H-4 | No rate limits / unmetered operations | ✅ | Per-user, per-workspace and per-IP limits on every expensive endpoint. No TTS text cap (product decision) |
| H-5 | Open sign-up / free provisioning | 🔧 | Revocation-aware auth (≤ 30 s). **Confirm self sign-up is disabled** in Firebase Auth (the stated policy) |
| H-6 | Client-writable rules + trusted `sampleStoragePath` | 🟡 🔧 | Server validates sample paths structurally; the repo can no longer deploy rules. **Review the deployed rules** (FIREBASE-RULES.md) |
| H-7 | 2018 ffmpeg, no format allow-list | ✅ | ffmpeg 6.1 (development) / Debian package (image); content-based allow-list; protocol whitelist; timeouts. Every media step tested on the new binary |
| H-8 | No admission control | ✅ | Dub queue (2 per workspace, 4 per server, rest queued); 3 heavy-work slots |
| H-9 | 1 MiB project document limit | ✅ | Measured (60 min × 3 languages failed); split layout (largest document 43% at 60 min × 10); lazy migration; rollback script |
| H-10 | No tests / CI / reproducible deploy | 🟡 | 188 tests on the Firebase emulators; GitHub Actions workflow; Dockerfile; `start` script. **CI hasn't run on GitHub yet, and the image hasn't been built** (Docker Desktop wasn't running locally) |
| H-11 | Backup / DR unknown | 🔧 | DISASTER-RECOVERY.md with procedures. **PITR, exports, soft delete and a restore test need the console** |
| M-1 | Revoked sessions valid 1 h | ✅ | Cached revocation check, ≤ 30 s |
| M-2 | 6-day URLs, share tokens in logs | ✅ | 3 h URLs; hashed, revocable shares with 2 h media URLs; token redaction |
| M-3 | Internal errors to clients | ✅ | One error shape, request IDs, generic 5xx messages; safe job and pipeline messages |
| M-4 | No input validation | ✅ | zod on every write endpoint |
| M-5 | No security headers | 🟡 | Headers enforced; strict CSP on share pages. **The app CSP is Report-Only** until the UI has been exercised under it (SECURITY.md) |
| M-6 | Data lifecycle | 🟡 | Complete project deletion (own folder, captions, shares; shared paths kept); record retention; temp sweeper. ⏸ **Account and workspace deletion, project expiry and TTS-cache purge on delete need product decisions** |
| M-7 | Usage accounting | ✅ | Storage measured from the bucket; optional enforcement; zero-length refused; per-job provider cost |
| M-8 | No job model | ✅ | Jobs with status, stage, attempts, timestamps, error codes, results; cancel; job API |
| M-9 | Timeouts / long requests | 🟡 | ffmpeg and ffprobe timeouts; async transcription with a 45-min timeout; download deadline. ⏸ No per-request deadline on Vertex/TTS calls (bounded by retries) and no overall dub timeout (cancellable instead) |
| M-10 | Logging / observability | 🟡 | JSON logs with correlation IDs and redaction; event catalogue; metric and alert definitions. 🔧 **Metrics and alerts must be created in Cloud Logging/Monitoring** |
| M-11 | Secrets handling | 🟡 | ADC mode (no key files), `CREDENTIALS_DIR`/`DUBLY_ENV_FILE`, rotation documented. **Move the secrets out of the OneDrive folder**; switch production to ADC |
| M-12 | Single instance only | ⏸ | Documented constraint plus migration path (ARCHITECTURE.md) |
| L-1 | Debug scripts enumerate users | ✅ | Removed |
| L-2 | Boilerplate README / package name | ✅ | New README; package `dubly@1.0.0` |
| L-3 | Very large UI components | ⏸ | Left for refactoring alongside future functional work (by design) |
| L-4 | Settings unvalidated | ✅ | Enum validation |
| L-5 | Removed member locked out | ✅ | Returns to their own workspace |

## Found during the work

| Item | Status |
|---|---|
| High-severity npm advisories (multer, onnxruntime-node/adm-zip) | ✅ Fixed by non-breaking upgrades |
| 8 moderate advisories via `firebase-admin@13` | ⏸ Needs the `firebase-admin@14` major upgrade (planned change) |
| The UI polls `GET /projects/:id` every 1.5 s, which returns every segment; with the split this costs 2 + languages reads per poll | ⏸ Performance follow-up: a lightweight status endpoint for polling |
| Optional Python engines absent from the Docker image | ⏸ Documented; add a torch layer if these features are needed in production |
| `bun.lock` is stale next to `package-lock.json` | ⏸ Remove, or regenerate if Bun is still used |

## Not done (phases of the brief)
- **Load and performance testing (Phase 20):** no load test was run, so no latency or throughput numbers are claimed. Doing it needs a staging environment with real providers; measuring against the emulator wouldn't be representative.
- **End-to-end browser test** of the full flow (sign-in → upload → dub → download): API-level flows are tested, but the UI hasn't been driven in a browser.
