# Dubly: backup and disaster recovery

**Status: the backup settings below have not been verified.** Nothing in this repository can switch on or confirm a backup setting. Every item marked 🔧 needs someone with access to the GCP console or `gcloud` for project `scatter-studio-live-2026`. Until the checklist at the end is filled in, treat Dubly as having **no tested backups**.

> The Firestore database and the Storage bucket are **shared with ScatterStudio**. Point-in-time recovery, exports and bucket settings apply to ScatterStudio's data as well, so agree on them with the ScatterStudio owners before changing anything. A restore must bring back **only Dubly's collections** (listed below), never the whole database.

## What needs protecting

| Data | Where | Can it be rebuilt? | Protection |
|---|---|---|---|
| Workspaces, members, invites, projects (metadata + `content/transcript` + `languages/{code}`), jobs, shares | Firestore: `workspaces/**`, `workspaceMembership/*`, `invites/*`, `jobs/*`, `jobIdempotency/*`, `shares/*` | No | Point-in-time recovery + scheduled exports |
| Cloned voices, per-user settings | Firestore: `users/{uid}/voices/*`, `users/{uid}/meta/*` | No | Same as above |
| Source videos, dubbed audio and video, thumbnails, caption renders | Storage: `workspaces/{ws}/projects/{id}/*` | Renders can be redone (they cost minutes and provider spend); **source uploads cannot** | Soft delete / object versioning |
| Voice samples | Storage: `users/{uid}/voices/*/sample.wav` | No | Same as above |
| Scratch files, TTS cache | Server disk: `server/tmp`, `server/cache` | Yes, disposable | None needed |
| Service-account keys, `server/.env` | Server disk (see docs/SECURITY.md) | Can be re-issued | Kept in a secret manager, never only on the server |
| Application | Git + Docker image | Yes | GitHub, CI-built image |

## Targets (proposed; confirm with the business)

| | Target | How it is met |
|---|---|---|
| **RPO** (data loss tolerated): Firestore | ≤ 5 minutes for incidents found within 7 days; ≤ 24 hours beyond that | Point-in-time recovery (7-day window) + daily export |
| **RPO**: media files | 0 for accidental deletes found within the soft-delete window | Bucket soft delete (7+ days) |
| **RTO** (time back to service) | 4 hours | Redeploy the image (docs/DEPLOYMENT.md), restore affected collections |

## 🔧 One-time setup (manual, GCP)

1. **Firestore point-in-time recovery (PITR).**
   `gcloud firestore databases update --database='(default)' --enable-pitr --project=scatter-studio-live-2026`
   Check with `gcloud firestore databases describe --database='(default)'`, which should show `pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_ENABLED`.
2. **A separate backup bucket**, in a different region from the media bucket, with a retention policy so backups can't be deleted early:
   `gcloud storage buckets create gs://dubly-firestore-backups --location=<other-region> --retention-period=30d --uniform-bucket-level-access`
   Give write access only to the export service agent. Operators get read-only access.
3. **A daily Firestore export of Dubly's collections**, using Cloud Scheduler plus a small Cloud Run job or Workflow that runs:
   `gcloud firestore export gs://dubly-firestore-backups/$(date +%F) --collection-ids=workspaces,projects,content,languages,members,meta,workspaceMembership,invites,jobs,jobIdempotency,shares,voices`
   Collection IDs cover subcollections at any depth, so the names above include Dubly's nested collections. Add a lifecycle rule that deletes exports after 30 days.
4. **Soft delete on the media bucket.** New buckets get 7 days by default; check it with `gcloud storage buckets describe gs://<bucket> --format='value(softDeletePolicy)'`, and raise it to 14–30 days if the storage cost is acceptable. Optionally, turn on object versioning for `workspaces/` media with a lifecycle rule that keeps 1 non-current version for 30 days.
5. **Key and config backups.** Store service-account keys (or, better, use no keys; see docs/SECURITY.md) and the `server/.env` values in Secret Manager, not only on the VM.

## Restore procedures

### A. A project or workspace was deleted or corrupted by mistake (most likely incident)
1. Find the time just before the bad change, from the logs (request id, `updatedAt`).
2. Within 7 days, use PITR to export the state as of that moment:
   `gcloud firestore export gs://dubly-firestore-backups/restore-$(date +%s) --snapshot-time=<RFC3339 time rounded to the minute> --collection-ids=workspaces,projects,content,languages,members,meta`
   After 7 days, use the latest daily export from before the incident.
3. **Import into a scratch project, never straight into production:** `gcloud firestore import gs://dubly-firestore-backups/restore-… --project=dubly-restore-scratch`.
4. Copy back only the affected documents, with a one-off Admin SDK script that reads from scratch and writes to production. Always include the project document **and** its `content/transcript` and `languages/*` subdocuments.
5. Media: restore soft-deleted objects with `gcloud storage restore gs://<bucket>/workspaces/<ws>/projects/<id>/**` (or restore a non-current version), then check that the project's `*StoragePath` fields point at existing objects.

### B. The Firestore database is lost or unusable
1. Put Dubly in maintenance mode (stop the container). Jobs that were running are settled and refunded by reconciliation when the service restarts.
2. Restore the latest PITR moment or export into a new database, following the same scratch-project process as A, then import into production.
3. Start Dubly. Any job left unsettled is failed and refunded, or re-queued, within about 2 minutes (docs/RUNBOOK.md).

### C. The Storage bucket is lost
- Deleted objects: restore from soft delete (step A5).
- Losing the whole bucket with no soft delete means the source uploads are gone. Renders could be redone only if the source survived. **This is the reason for step 4 of the setup.**

### D. The server / VM / container is lost
Nothing on the server's disk needs backing up. Redeploy the last good image (docs/DEPLOYMENT.md) with the secrets. Dubs that were running are settled as interrupted and refunded; dubs that were still queued restart by themselves.

### E. An AI provider (Vertex / Cloud TTS) is unavailable
No data is at risk:
- Transient errors are retried with backoff (`server/lib/vertexClient.ts`, `modelRouter.ts`).
- A dub whose languages all fail ends as `failed` with its minutes refunded.
- A partial failure bills only the languages that rendered.

Tell users, and retry once the provider recovers.

## 🔧 Restore test (do this quarterly; untested backups don't count)

1. Pick a real workspace ID and project ID.
2. Run procedure A steps 2–3 into `dubly-restore-scratch`, using the most recent daily export.
3. Check in the scratch project that the project document, its transcript document and every `languages/*` document exist and load (for example, point a local Dubly at the scratch project in read-only fashion, or compare counts with a script).
4. Restore one soft-deleted test object in the media bucket.
5. Record the result below. A failed test is an incident.

| Date | Who | Export used | Result | Time taken |
|---|---|---|---|---|
| _not yet performed_ | | | | |

## Verification checklist

| Item | Status |
|---|---|
| Firestore PITR enabled | 🔧 Not verified |
| Daily export scheduled to a separate-region bucket with retention | 🔧 Not verified |
| Media bucket soft delete ≥ 7 days | 🔧 Not verified |
| Secrets held in Secret Manager | 🔧 Not verified |
| Restore test performed | 🔧 Never |
