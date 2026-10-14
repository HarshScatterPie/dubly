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
| GET | `/api/profile` | `{ name, role, workspace, avatar }`: from the shared ScatterStudio profile (whitelisted fields only), with the name and picture the person chose in Dubly's Settings taking precedence |
| PATCH | `/api/profile` | `{ name?, avatar? }`: `name` 1–60 characters; `avatar` a small JPEG/PNG/WebP `data:` URL (≤ 60,000 characters, checked by content) or `null` to remove it. Saved on Dubly's side only (`users/{uid}/meta/profile`); the ScatterStudio document is never written. Also updates the caller's entry on the team list. Needs a workspace |
| GET/PUT | `/api/settings` | Per-user settings: provider choices (`auto` \| `vertex`) and `preferences`, the defaults a new dub starts from (`defaultTargetLanguages` ≤ 10, `defaultVoiceId`, `translationStyle`, `adaptExpressions`, `voiceEmotion`, `voiceSpeed` 0.75–1.25, `expressiveVoices`, `separateBackground`, `autoLipSync`, `burnCaptions`). PUT merges: only the fields sent change. `expressiveVoices: false` voices that user's dubs and previews steadily, without delivery direction or performed laughs and sighs |
| POST | `/api/profile/sign-out-everywhere` | Revokes every session of the caller's account, this one included (`204`); their tokens are refused from then on |
| GET | `/api/bootstrap` | Everything the app opens with, in one response: `{ workspace, preferences, usage, projects, profile }` (same shapes as the separate endpoints). The client caches it per account in the browser and refreshes it on every visit |
| GET | `/api/usage` | Minutes (used, limit; `renewsMonthly` false and no `resetsAt` on Free, whose minutes are a one-time total), storage measured from the bucket, and the workspace plan: `activePlan`, `planId`, `paidExtrasAllowed`, `extraRates`, `teamInvites` |
| POST | `/api/usage/quota-request` | "Request Quota Increase": `{ name, company?, phone?, plan: starter|enterprise|custom, minutesPerMonth, message }`. The requester and workspace come from the session. Stored and emailed to `QUOTA_REQUEST_TO` (else the SMTP account); `201 { id, emailed }`. 5 a day per user |

### Workspace and invitations
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/api/workspace` | member | Members, `myRole`, `myUid` |
| PATCH | `/api/workspace` | admin | `{ name }` |
| POST | `/api/workspace/members` | admin | **Retired: `410 USE_INVITES`** |
| GET | `/api/workspace/invites` | admin | Pending, unexpired invitations |
| POST | `/api/workspace/invites` | admin | `{ email, role }` → `201 { invite, token, emailed }`. Same response whether or not the email has an account. Re-inviting replaces the earlier link. The link is `/?invite=<token>`, valid 7 days. `emailed` is true when SMTP is configured and the server accepted the email to the invitee; the link is returned either way. `403 PLAN_NO_TEAM` on a plan without teammates. Rate-limited per admin and per workspace |
| DELETE | `/api/workspace/invites/:inviteId` | admin | Withdraw an invitation |
| PATCH | `/api/workspace/members/:uid` | admin | `{ role }`. The last admin can't be demoted |
| DELETE | `/api/workspace/members/:uid` | admin | Removes the member for good, at once: the membership and a "removed" mark are written atomically (every request they make is then `403 NO_WORKSPACE`, even with a still-valid session), and every session is revoked. They are locked out of Dubly entirely, including a workspace of their own, until an admin invites them again. A login Dubly created from an invitation is deleted; a pre-existing login (shared with ScatterStudio) is only locked out of Dubly. `400` when removing yourself or the last admin |
| GET | `/api/workspace/glossary` | member | `{ entries, canEdit }` |
| PUT | `/api/workspace/glossary` | admin | `{ entries }` (≤ 300; each `{ id, term, mode: keep\|translate, translations?, spokenAs?, note? }`; terms unique regardless of case). Replaces the whole list. Translations, line shortening, review flags and the voice's pronunciation follow it |
| POST | `/api/invites/preview` | any signed-in user | `{ token }`. Answers only if the signed-in email matches the invitation, otherwise the uniform `404 INVITE_NOT_FOUND` |
| POST | `/api/invites/accept` | any signed-in user | `{ token }`. Joins the workspace. Idempotent for the same user while they remain a member; a used link is spent once they are removed. `410 INVITE_EXPIRED`; `409 IN_OTHER_TEAM` if the caller is in another team with other members |
| GET | `/api/invites/mine` | any signed-in user | `{ invites: [{ id, workspaceName, role, invitedByName, createdAt, expiresAt }] }`: live invitations addressed to the caller's email, for the notification bell. Empty unless the email is verified. Not rate-limited like the other invite routes (the bell asks every few minutes) |
| POST | `/api/invites/accept-by-id` | verified email | `{ inviteId }`: joins from the bell or the join screen without the emailed link. `403 EMAIL_NOT_VERIFIED`; otherwise the same answers as `accept` |

**No workspace yet.** A login made from an invitation, or an existing login with an invitation waiting that has never used Dubly, gets no workspace of its own (so no Starter plan) until it joins: every workspace route answers `403 AWAITING_INVITE`. A removed member gets `403 NO_WORKSPACE`.

### Projects
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects` | `{ title?, sourceLanguage?, targetLanguage? }` |
| GET | `/api/projects` | All projects of the workspace, with 3-hour signed media URLs |
| GET | `/api/projects/:id` | One project, with segments reassembled, plus `retakeInfo`: per language, the lines edited since its last render (`changedLineIds`, `seconds`, `minutes`). The list endpoint leaves `retakeInfo` out |
| GET | `/api/projects/:id/progress` | `{ status, progressPercent, currentProcessingMessage, updatedAt }` from a single document read. For progress bars: poll this while a dub, re-dub or retake runs, then fetch the full project once when `status` is `completed` or `failed`. Never cached |
| PATCH | `/api/projects/:id` | Title, voice choices, maps, style, transcript/localized segments, `currentStep` |
| DELETE | `/api/projects/:id` | **Admin only.** Deletes the project, its segment documents, every file in its own storage folder and its share links |
| POST | `/api/projects/:id/upload` | multipart `file`, ≤ 500 MB, ≤ 60 min. MP4/MOV/WebM, checked by content. `400 UNSUPPORTED_MEDIA` / `MEDIA_UNREADABLE` / `NO_AUDIO_STREAM` / `VIDEO_TOO_LONG`; `413 STORAGE_LIMIT_REACHED` when enforcement is on |
| POST | `/api/projects/:id/import-sample` | `{ sampleId }`, one of the built-in samples. `400 UNKNOWN_SAMPLE` for anything else |
| POST | `/api/projects/:id/transcribe` | With `Prefer: respond-async`: `202 { jobId }`, then poll the job. Without it: waits and returns the project plus `detectedLanguage`, `removedSegments`, `sanitizeNote`. `409 JOB_ALREADY_RUNNING` |
| POST | `/api/projects/:id/translate` | `{ targetLanguageCodes (≤ 10), style?, adaptExpressions?, regenerate? }` |
| PATCH | `/api/projects/:id/languages/:code/segments` | `{ localizedSegments }`: edited lines for one language (`translatedText`, `delivery`). The server keeps its own `renderKey`, render flags and slot timings for existing lines and recomputes `qaFlags` |
| POST | `/api/projects/:id/languages/:code/retake` | Re-renders one language after line edits, charging only the lines whose fingerprint changed since its last render (in 0.1-minute steps, at least 0.1, never more than a full re-dub). Header `Idempotency-Key`. `202 { jobId, changedLines, minutes }`. `400 NOTHING_TO_RETAKE`, `400 RETAKE_UNAVAILABLE` (rendered before line fingerprints existed: re-dub instead), plus the dub errors |
| POST | `/api/projects/:id/dub` | Voice choices plus `languages?`. Header `Idempotency-Key` (recommended). `202 { status, jobId }`. `409 JOB_ALREADY_RUNNING`, `403 QUOTA_EXCEEDED`, `400 VIDEO_DURATION_UNKNOWN`, `400 LANGUAGE_NOT_VOICED` (a language no voice the server offers speaks, such as Santali without Gemini 3.8 voices). The dub may wait in the queue (the project message says so) |
| POST | `/api/projects/:id/export-video` | `{ languageCode?, captions? }` → `{ url }`. Captioned renders are made once and cached |

### Jobs
| Method | Path | Notes |
|---|---|---|
| GET | `/api/projects/:id/jobs/:jobId` | `{ id, type, status, stage, progress, settled, errorCode, message, result, languages, completedLanguages, failedLanguages, minutesReserved, minutesRefunded, … }` |
| POST | `/api/projects/:id/jobs/:jobId/cancel` | A queued dub is cancelled at once with a full refund. A running job stops at its next step, and a dub then refunds its unfinished languages |

### Sharing
| Method | Path | Notes |
|---|---|---|
| POST | `/api/projects/:id/share` | `{ languageCode?, captions? }` → `201 { token, shareId, path, expiresAt, captions }`: a 24-hour public link. `captions` (default `true`) puts the dub's word-by-word captions and a CC switch on the page |
| GET | `/api/projects/:id/shares` | The project's live links (`captions` says whether each carries them) |
| DELETE | `/api/projects/:id/shares/:shareId` | Turn a link off. Its page stops at once; any video URL already copied from it lasts at most 2 more hours |
| GET | `/api/share/:token` | **Public** HTML watch page with the ScatterPie logo and a player like the studio's (captions, CC, speed, fullscreen). `404` unknown, `410` expired or turned off. Limited per IP. Its one inline script is allowed by a per-response CSP nonce |
| GET | `/api/share/:token/captions.vtt` | **Public** WebVTT of the captions; `404` when the link has none |

### Text-to-voice
| Method | Path | Notes |
|---|---|---|
| POST | `/api/tts/generate` | `{ text, voiceId, languageCode?, speed?, pitch?, emotion?, delivery? }` → a WAV data URL. `emotion` and `delivery` direct the voice as a dub would. A voice on an engine the workspace's plan lacks is voiced as the same persona on one it has. `400 LANGUAGE_NOT_VOICED` for a language no available voice speaks. No length limit beyond the 2 MB body |
