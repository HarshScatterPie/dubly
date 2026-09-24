# API

Base path `/api`. Every endpoint except `/api/healthz` and `/api/share/:token` requires `Authorization: Bearer <Firebase ID token>`. Endpoints under `/api/projects`, `/api/workspace` and `/api/usage` act on the **caller's workspace**, which is resolved on the server. A project ID from another workspace answers `404`, exactly like one that doesn't exist.

## Conventions

**Errors.** Every JSON error has one shape:
```json
{ "error": { "code": "JOB_ALREADY_RUNNING", "message": "This project is already being dubbed…", "request_id": "…", "jobId": "…" } }
```
- `message` is safe to show to users.
- Unplanned server errors are reported as `INTERNAL` with a generic message; the details go only to the server log, under `request_id`.
- Every response carries an `X-Request-Id` header. A well-formed `X-Request-Id` sent by the caller is kept, so traces can span services.

**Validation.** Write bodies are validated (types, enums, ranges, sizes). A failure returns `400 VALIDATION_FAILED` with `fields`. Unknown top-level fields are dropped.

**Rate limits.** A `429 RATE_LIMITED` response includes `Retry-After` and `retryAfterSeconds`. The limits are listed in [DEPLOYMENT.md](DEPLOYMENT.md#limits). While the server is restarting, work-starting endpoints answer `503 SERVER_RESTARTING` with `Retry-After`.

## Endpoints

### Health, profile, settings, usage
| Method | Path | Notes |
|---|---|---|
| GET | `/api/healthz` | Public liveness check: `{ ok: true }` |
| GET | `/api/health` | Provider and optional-engine availability |
| GET | `/api/profile` | Name, role and workspace from the shared ScatterStudio profile (whitelisted fields only) |
| GET/PUT | `/api/settings` | Per-user settings: provider choices (`auto` \| `vertex`) and `preferences`, the defaults a new dub starts from (`defaultTargetLanguages` ≤ 10, `defaultVoiceId`, `translationStyle`, `adaptExpressions`, `voiceEmotion`, `voiceSpeed` 0.75–1.25, `expressiveVoices`, `separateBackground`, `autoLipSync`, `burnCaptions`). PUT merges: only the fields sent change. `expressiveVoices: false` voices that user's dubs and previews with Chirp3-HD |
| POST | `/api/profile/sign-out-everywhere` | Revokes every session of the caller's account, this one included (`204`); their tokens are refused from then on |
| GET | `/api/usage` | Monthly minutes (used, limit, reset time) and storage measured from the bucket |

### Workspace and invitations
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/workspace` | member | Members, `myRole`, `myUid` |
| PATCH | `/api/workspace` | admin | `{ name }` |
| POST | `/api/workspace/members` | admin | **Retired: `410 USE_INVITES`** |
| GET | `/api/workspace/invites` | admin | Pending, unexpired invitations |
| POST | `/api/workspace/invites` | admin | `{ email, role }` → `201 { invite, token }`. Same response whether or not the email has an account. Re-inviting replaces the earlier link. The link is `/?invite=<token>`, valid 7 days |
| DELETE | `/api/workspace/invites/:inviteId` | admin | Withdraw an invitation |
| PATCH | `/api/workspace/members/:uid` | admin | `{ role }`. The last admin can't be demoted |
| DELETE | `/api/workspace/members/:uid` | admin | Removes the member, who returns to their own workspace if they had one |
| GET | `/api/workspace/glossary` | member | `{ entries, canEdit }` |
| PUT | `/api/workspace/glossary` | admin | `{ entries }` (≤ 300; each `{ id, term, mode: keep\|translate, translations?, spokenAs?, note? }`; terms unique regardless of case). Replaces the whole list. Translations, line shortening, review flags and the voice's pronunciation follow it |
| POST | `/api/invites/preview` | any signed-in user | `{ token }`. Answers only if the signed-in email matches the invitation, otherwise the uniform `404 INVITE_NOT_FOUND` |
| POST | `/api/invites/accept` | any signed-in user | `{ token }`. Joins the workspace. Idempotent for the same user. `410 INVITE_EXPIRED`; `409 IN_OTHER_TEAM` if the caller is in another team with other members |

### Projects
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects` | `{ title?, sourceLanguage?, targetLanguage? }` |
| GET | `/api/projects` | All projects of the workspace, with 3-hour signed media URLs |
| GET | `/api/projects/:id` | One project, with segments reassembled, plus `retakeInfo`: per language, the lines edited since its last render (`changedLineIds`, `seconds`, `minutes`). The list endpoint leaves `retakeInfo` out |
| PATCH | `/api/projects/:id` | Title, voice choices, maps, style, transcript/localized segments, `currentStep` |
| DELETE | `/api/projects/:id` | **Admin only.** Deletes the project, its segment documents, every file in its own storage folder and its share links |
| POST | `/api/projects/:id/upload` | multipart `file`, ≤ 500 MB, ≤ 60 min. MP4/MOV/WebM, checked by content. `400 UNSUPPORTED_MEDIA` / `MEDIA_UNREADABLE` / `NO_AUDIO_STREAM` / `VIDEO_TOO_LONG`; `413 STORAGE_LIMIT_REACHED` when enforcement is on |
| POST | `/api/projects/:id/import-sample` | `{ sampleId }`, one of the built-in samples. `400 UNKNOWN_SAMPLE` for anything else |
| POST | `/api/projects/:id/transcribe` | With `Prefer: respond-async`: `202 { jobId }`, then poll the job. Without it: waits and returns the project plus `detectedLanguage`, `removedSegments`, `sanitizeNote`. `409 JOB_ALREADY_RUNNING` |
| POST | `/api/projects/:id/translate` | `{ targetLanguageCodes (≤ 10), style?, adaptExpressions?, regenerate? }` |
| PATCH | `/api/projects/:id/languages/:code/segments` | `{ localizedSegments }`: edited lines for one language (`translatedText`, `delivery`). The server keeps its own `renderKey`, render flags and slot timings for existing lines and recomputes `qaFlags` |
| POST | `/api/projects/:id/languages/:code/retake` | Re-renders one language after line edits, charging only the lines whose fingerprint changed since its last render (in 0.1-minute steps, at least 0.1, never more than a full re-dub). Header `Idempotency-Key`. `202 { jobId, changedLines, minutes }`. `400 NOTHING_TO_RETAKE`, `400 RETAKE_UNAVAILABLE` (rendered before line fingerprints existed: re-dub instead), plus the dub errors |
| POST | `/api/projects/:id/dub` | Voice choices plus `languages?`. Header `Idempotency-Key` (recommended). `202 { status, jobId }`. `409 JOB_ALREADY_RUNNING`, `403 QUOTA_EXCEEDED`, `400 VIDEO_DURATION_UNKNOWN`. The dub may wait in the queue (the project message says so) |
| POST | `/api/projects/:id/export-video` | `{ languageCode?, captions? }` → `{ url }`. Captioned renders are made once and cached |

### Jobs
| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/:id/jobs/:jobId` | `{ id, type, status, stage, progress, settled, errorCode, message, result, languages, completedLanguages, failedLanguages, minutesReserved, minutesRefunded, … }` |
| POST | `/api/projects/:id/jobs/:jobId/cancel` | A queued dub is cancelled at once with a full refund. A running job stops at its next step, and a dub then refunds its unfinished languages |

### Sharing
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects/:id/share` | `{ languageCode? }` → `201 { token, shareId, path, expiresAt }`: a 24-hour public link |
| GET | `/api/projects/:id/shares` | The project's live links |
| DELETE | `/api/projects/:id/shares/:shareId` | Turn a link off. Its page stops at once; any video URL already copied from it lasts at most 2 more hours |
| GET | `/api/share/:token` | **Public** HTML watch page. `404` unknown, `410` expired or turned off. Limited per IP |

### Voices and text-to-voice
| Method | Path | Notes |
|---|---|---|
| GET | `/api/voices` | The caller's cloned voices (only those whose sample lives in the caller's own folder) |
| POST | `/api/voices` | multipart `sample` (≤ 25 MB, 5–120 s audio, checked by content) plus `name?`, `gender?`, `languageCode?` |
| DELETE | `/api/voices/:id` | Deletes the voice, and its sample only when the sample is in the caller's own folder |
| POST | `/api/tts/generate` | `{ text, voiceId, languageCode?, speed?, pitch?, emotion?, delivery? }` → a WAV data URL. `emotion` and `delivery` direct the voice as a dub would. No length limit beyond the 2 MB body |
