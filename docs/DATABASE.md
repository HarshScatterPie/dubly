# Database

Firestore, in the Firebase project shared with ScatterStudio. The backend reaches it through the Admin SDK only; clients never read or write it directly (see [FIREBASE-RULES.md](FIREBASE-RULES.md)).

## Collections Dubly owns

| Path | Contents | Written by |
|---|---|---|
| `workspaces/{ws}` | `name`, `createdAt`, `createdBy`, `plan` (`starter` when absent), `planUpdatedAt` | workspaces.ts, plans.ts |
| `dublyPlans/{planId}` | `starter` and `enterprise`: `name`, `minutesPerMonth`, `paidExtras`, `extraRates` (extra allowance per dubbed minute for each paid extra), `teamInvites`. Seeded with the built-in values on first read; after that, edits here win (the server rereads within a minute) | plans.ts |
| `workspaces/{ws}/members/{uid}` | `uid, email, name, role (admin\|editor), addedAt, addedBy` | workspaces.ts |
| `workspaceMembership/{uid}` | `workspaceId` (null = removed), `personalWorkspaceId` (their own workspace to return to) | workspaces.ts |
| `workspaces/{ws}/projects/{id}` | Project metadata: title, languages, voice choices, status and progress, `languageOutputs` (per-language status + storage **paths**), `activeJobId`, `dubAttempts`, `segmentsStorage` | projectRepo.ts / projectStorage.ts |
| `…/projects/{id}/content/transcript` | `{ segments: TranscriptSegment[] }` (with word timings) | projectStorage.ts |
| `…/projects/{id}/languages/{code}` | `{ segments: LocalizedSegment[] }` for one target language | projectStorage.ts |
| `workspaces/{ws}/meta/glossary` | `{ entries: GlossaryEntry[], updatedAt, updatedBy }`: at most 300 terms, each `keep` (never translated) or `translate` (per-language rendering), with an optional `spokenAs` | glossaryStore.ts |
| `workspaces/{ws}/meta/usage` | Monthly minutes (`minutesDubbed`, `usagePeriod`) + lifetime counters | projectRepo.ts |
| `jobs/{jobId}` | Dub and transcription jobs (fields: [jobs.ts](../server/lib/jobs.ts) `DubJob`; a dub records the paid `extras` it was charged for) | jobs.ts |
| `jobIdempotency/{sha256(ws\|project\|key)}` | `{ jobId, createdAt }` | jobs.ts |
| `invites/{sha256(token)}` | `workspaceId, invitedEmail, role, status (pending\|accepted\|revoked), expiresAt, acceptedBy …` | workspaces.ts |
| `shares/{sha256(token)}` | `workspaceId, projectId, languageCode, storagePath, expiresAt, revokedAt?` (older links: keyed by the raw token) | share.ts |
| `users/{uid}/voices/{voiceId}` | Cloned voice: `sampleStoragePath` (must be `users/{uid}/voices/{uuid}/sample.wav`) | customVoices.ts |
| `users/{uid}/meta/settings` | Provider choices, plus `preferences` (the user's dubbing defaults, see API.md → settings) | projectRepo.ts |

**Line fields.** A `TranscriptSegment` may carry `delivery` (how the line is said, heard during transcription). A `LocalizedSegment` may carry `delivery` (voice direction, editable), `qaFlags` (review flags) and `renderKey` (fingerprint of what its last render spoke). The server owns `renderKey`, render flags and slot timings: when lines are saved it keeps its own values for them and recomputes the text flags ([lineReview.ts](../server/lib/lineReview.ts)).

`users/{uid}` itself belongs to ScatterStudio. Dubly only reads `name`, `role` and `workspace` from it, and never returns `api_key`.

## Project layout and migration

**Why it's split (measured, `server/lib/documentSize.test.ts`):**

| Video | Languages | All-in-one document | Split: largest document |
|---|---|---|---|
| 30 min | 5 | 1,034 KiB: **over the 1 MiB limit** | — |
| 60 min | 1 | 981 KiB (96%) | — |
| 60 min | 10 | 3,408 KiB: over | `content/transcript` 442 KiB (43%) |

- **New projects** are written split (`segmentsStorage: "split"`) from the start.
- **Existing projects** (no `segmentsStorage`) are read as they are. On their first write of any kind, their inline segments are moved into the subdocuments, and removed from the metadata document, in the **same transaction** as the write. No bulk migration or downtime is needed, and a project that is never touched again is never rewritten.
- **Rollback:** code from before the split can't read split projects (it would see empty segments). To roll back after the split has shipped, first run a one-off script that copies `content/transcript` and `languages/*` back into the parent document, or roll forward instead. This is recorded in DEPLOYMENT.md.
- **Guard:** a write that would still exceed ~98% of 1 MiB in any single document is refused with `413 PROJECT_TOO_LARGE`, rather than failing inside Firestore.

## Transactions
- **Starting a job:** project + active job + usage + idempotency key.
- **Job progress:** project + job, for the ownership and cancel check.
- **Settling:** job + project + usage, exactly once.
- **Invitations:** accept (invite + pointer + membership), plus create and revoke.
- **Every project write:** metadata and segment documents together.

## Indexes
Every query is either a single-field range query or an equality-only query, which Firestore serves from automatic indexes. **No composite indexes are required.**

| Query | Where |
|---|---|
| `jobs where settled == false` | reconciliation |
| `invites where workspaceId == … and invitedEmail == … and status == …` | invitations |
| `members where email == …`, `members where role == 'admin'` | invitations, role changes |
| `shares where projectId == …` | share list, project delete |
| `shares/invites/jobIdempotency/jobs where <timestamp> < cutoff order by <timestamp>` | retention sweeper |
| `projects order by createdAt desc` | project list |

## Retention (server/lib/recordSweeper.ts, hourly)
| Records | Deleted after |
|---|---|
| Share links | 7 days past expiry |
| Invitations | 30 days past expiry |
| Idempotency keys | 2 days |
| Finished jobs (minute charge/refund history) | 180 days |
| Projects, voices, workspaces | Kept until deleted by a user/admin |

## Schema changes
There is no SQL-style migration runner. Firestore changes are made the way the split was: new fields are optional, readers accept the old and new shapes, and a document is moved on its next write. Anything destructive needs a one-off Admin SDK script, run first against a restored copy (see [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md)), plus a backup and a written rollback.
