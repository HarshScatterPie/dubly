# Database

MongoDB, one database (`dubly`), on a replica set. The backend is the only client: browsers never talk to the database, and every stored file is in it too (GridFS). Setup, users, Compass, backups and the full collection list: [MONGODB.md](MONGODB.md).

## Project layout

A project is one metadata document in `projects` plus its lines in `projectSegments`: one document for the transcript (`<projectId>:transcript`) and one per language (`<projectId>:lang:<code>`). `server/lib/projectStorage.ts` reassembles them on read and splits an all-in-one patch on write.

| Video | Languages | Largest single document |
|---|---|---|
| 60 min | 10 | well under 1 MiB (the transcript, with word timings) |

So nothing comes near MongoDB's 16 MiB document limit (`server/lib/documentSize.test.ts` measures it). The split is kept because progress polls and the project list read only the small metadata document, and a progress write never rewrites hours of lines. A write that would still pass 95% of 16 MiB in one document is refused with `413 PROJECT_TOO_LARGE`.

Every write also keeps the line count of each part on the project (`segmentCounts`), so the project list and the app's startup data send projects **without their lines** (`summary: true`, ~86 KiB instead of 1.2 MB for 23 projects); a project's lines come with `GET /api/projects/:id`. Projects stored before counts were kept are counted once, the first time they are listed.

Writes merge field by field (`mongo.mergeUpdate`): `{ languageOutputs: { hi: { status } } }` changes that one field and leaves the other languages alone. `DELETE_FIELD` removes a field.

**Line fields.** A `TranscriptSegment` may carry `delivery` (how the line is said, heard during transcription). A `LocalizedSegment` may carry `delivery` (voice direction, editable), `qaFlags` (review flags) and `renderKey` (fingerprint of what its last render spoke). The server owns `renderKey`, render flags and slot timings: when lines are saved it keeps its own values for them and recomputes the text flags ([lineReview.ts](../server/lib/lineReview.ts)).

## Transactions

All through `mongo.withTransaction` (snapshot reads, majority writes; the driver retries on write conflicts, so two requests racing for the same project or ledger never both win):

- **Starting a job:** project + active job + usage + idempotency key.
- **Job progress:** project + job, for the ownership and cancel check.
- **Settling:** job + project + usage, exactly once.
- **Invitations:** accept (invite + pointer + membership), create (revoke earlier + insert); removing a member (membership + pointer).
- **First workspace:** workspace + member + pointer; a duplicate key means another request made it first.
- **Every project write:** metadata and segment documents together.

Single-document changes that need a condition use one conditional write instead (`findOneAndUpdate`): revoking an invitation, requesting a cancel, claiming a stale queued job.

## Indexes

Created at startup (`ensureIndexes` in `server/lib/mongo.ts`, `ensureMediaIndexes` in `server/lib/mediaStore.ts`):

| Collection | Index | For |
|---|---|---|
| `users` | `email` unique | sign-in, one account per address |
| `sessions` | `uid`; `expiresAt` TTL | sign out everywhere; automatic expiry |
| `authTokens` | `uid, purpose`; `expiresAt` TTL | one live link of each kind; automatic expiry |
| `members` | `workspaceId, uid` unique; `workspaceId, role`; `workspaceId, email`; `uid` | team list, last-admin check, invitations |
| `projects` | `workspaceId, createdAt desc` | project list |
| `projectSegments` | `projectId` | reassembly, delete |
| `jobs` | `settled`; `finishedAt` | reconciliation; retention |
| `invites` | `workspaceId, invitedEmail, status`; `invitedEmail, status`; `expiresAt` | invitations; retention |
| `shares` | `projectId`; `expiresAt` | share list, project delete; retention |
| `media.files` | `filename, uploadDate desc`; `metadata.workspaceId` | newest version of a path; storage per workspace |

## Retention (server/lib/recordSweeper.ts, hourly)

| Records | Deleted after |
|---|---|
| Share links | 7 days past expiry |
| Invitations | 30 days past expiry |
| Idempotency keys | 2 days |
| Finished jobs (minute charge/refund history) | 180 days |
| Sessions, email links | at expiry, by MongoDB (TTL indexes) |
| Projects, files, workspaces, accounts | Kept until deleted by a user/admin |

## Schema changes

There is no migration runner. Changes follow one rule: new fields are optional and readers accept the old and new shapes. Anything destructive needs a one-off script, run first against a restored copy (`deploy/mongo/restore.mjs --into dubly_restore_check`), plus a fresh backup and a written rollback.
