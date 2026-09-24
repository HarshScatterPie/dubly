# Security

## Authentication
- **Firebase Authentication.** ScatterPie creates every account; self sign-up must stay disabled in the Firebase console (Authentication → Settings → User actions). Email verification isn't required, because accounts are created by ScatterPie and joining a team needs a private invite link as well as the matching email.
- **Token checks:** every request verifies the ID token (signature, expiry, project). It also checks that the account isn't disabled, deleted or revoked since the token was issued. That check is cached per user for 30 s, so revoking or disabling someone takes effect within 30 s (`server/lib/auth.ts`).
- **Brute force and password reset** are handled by Firebase Auth. Dubly has no password endpoints of its own.

## Authorization and tenancy
- The workspace comes only from the server-side membership lookup. Every project, job, share and usage query is addressed through `workspaces/{workspaceId}/…`, or checked against `workspaceId` for top-level records such as jobs and shares. Another workspace's IDs answer `404`, the same as missing ones.
- **Roles:** only admins can delete projects, rename the workspace, invite, change roles or remove members. Editors can do everything else. A workspace always keeps at least one admin.
- **Invitations** (`server/lib/workspaces.ts`):
  - No account is ever created and nobody is moved or copied at an admin's request.
  - Joining needs the private link, whose token is 256-bit and stored only as a SHA-256 hash, **and** a signed-in account with the invited email.
  - Links expire after 7 days, can be withdrawn, are single-use per user and idempotent. "Not for you", "revoked" and "doesn't exist" all give the same answer.
  - Someone already in another team with other members can't be pulled out by an invite.
- **Tests:** `server/routes/workspace.test.ts` and `server/routes/*.test.ts` include cross-tenant tests covering projects, jobs, shares and voices.

## Uploads and media
- **Content checks:** judged by content (magic bytes plus the container ffprobe detects), never by filename, extension or MIME type. Videos must be MP4/MOV/WebM, with a picture and sound; voice samples are wav/mp3/m4a/ogg/flac/webm. Playlists, concat lists, images and AVI are refused (`server/lib/mediaValidation.ts`).
- **Size and length:** 500 MB per video and 60 minutes. Zero-length and unreadable files are refused.
- **ffmpeg:**
  - It's restricted to local-file inputs (`-protocol_whitelist file,pipe`), so a crafted file can't make it fetch URLs.
  - Every call has a timeout (5 min for quick operations, 120 min for renders), and ffprobe runs with a 60 s timeout.
  - Production uses the Debian package, security-patched through the image; local development uses ffmpeg 6.1 from `ffmpeg-static`.
- **Storage:** stored names come from server-generated IDs (`workspaces/{ws}/projects/{id}/source.<ext from content>`).
- **Cloned voices:** a voice is used, listed or signed only if its sample path is exactly `users/{caller}/voices/{uuid}/sample.wav` (`server/lib/customVoices.ts`).
- **No server-side fetching of user URLs:** sample import takes a sample ID from a server list. The download is also checked: HTTPS only, allow-listed host, public IPs after DNS, no redirects, a timeout and a byte cap (`server/lib/safeDownload.ts`).

## Signed URLs and sharing
- Media is private in the bucket. Clients get signed URLs valid for **3 hours**, each reused for at most 55 minutes.
- Share links are public for 24 hours, stored hashed, and can be turned off. The share page's own media URLs last at most 2 hours, and the page has a strict CSP and `Referrer-Policy: no-referrer`.

## API hardening
- **Validation:** zod schemas on every write endpoint (`server/lib/validation.ts`). JSON bodies are capped at 2 MB.
- **Rate limits and admission:** per-user, per-workspace and per-IP rate limits, plus admission control on heavy work (see DEPLOYMENT.md).
- **Errors:** a single error format. Unplanned server errors never reach clients, only the log (with `request_id`).
- **Headers:**
  - Enforced: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and HSTS on HTTPS.
  - The app's CSP ships as **Report-Only**. **To enforce it:** walk through sign-in, upload, analysis, translation, dubbing, export, share, voice cloning and text-to-voice with the browser console open. Add any legitimate source that gets reported to `APP_CSP` in `server/app.ts`, then rename the header to `Content-Security-Policy`.
- **CORS** allows only `WEB_ORIGIN`. Authentication is a bearer token (no cookies), so CSRF doesn't apply.

## Secrets
| Secret | Where it lives | Rotation |
|---|---|---|
| GCP service account (Vertex, TTS) | Production: **none** with `CREDENTIALS_MODE=adc` (the VM or Cloud Run service account). Development: `gcp-service-account.json` in `CREDENTIALS_DIR` | Create a new key in IAM → replace the file → restart → delete the old key. With ADC there's nothing to rotate |
| Firebase Admin service account | Same, via `firebase-service-account.json` or ADC (`FIREBASE_PROJECT_ID` required) | Same |
| `HF_TOKEN` (optional cloning) | `server/.env` or `DUBLY_ENV_FILE` | Revoke and reissue at huggingface.co → Settings → Access Tokens → restart |
| Firebase web API key | Frontend bundle (public by design) | Not secret. In the GCP console, restrict it to the Dubly and ScatterStudio origins |

- **Never committed:** `.env*` (except `.env.example`), `server/credentials/` and key files are gitignored. CI runs a secret scan (TruffleHog) over the full history.
- **Never logged:** tokens, JWTs, API keys, private keys, share tokens and URL signatures are redacted from every log line (`server/lib/log.ts`).
- **OneDrive:** the development copy of this repo sits in a OneDrive-synced folder, so `server/.env` and `server/credentials/` are uploaded to OneDrive. Either move the working copy out of OneDrive, or keep secrets elsewhere with `CREDENTIALS_DIR` and `DUBLY_ENV_FILE`, and delete them from the synced folder.
- **ADC permissions in production:** the runtime service account needs Vertex AI User, Cloud Text-to-Speech access, Firestore/Datastore User, Storage Object Admin on the media bucket, and **Service Account Token Creator on itself**, because signed URLs are signed through IAM when there's no key file.
- **If a secret leaks:** rotate it at once as above, then check Cloud Audit Logs for its use. Revoke Firebase sessions of affected users with `revokeRefreshTokens`, which takes effect within 30 s.

## Data retention (implemented)
| Data | Kept |
|---|---|
| Projects, their media, cloned voices | Until deleted. Deleting a project removes its documents, every file in its storage folder and its share links |
| Server scratch files | ≤ 6 hours (sweeper), and removed right after each job normally |
| TTS audio cache (server disk) | Least recently used, capped at 1.5 GB; **not** removed when a project is deleted |
| Share links / invitations / idempotency keys / finished jobs | 7 days past expiry / 30 days past expiry / 2 days / 180 days |

**Not implemented (product decision needed):** automatic expiry of old projects, account deletion and workspace deletion.

## Privacy: what leaves Dubly
| Recipient | What | When |
|---|---|---|
| Google Cloud (Firebase Auth, Firestore, Cloud Storage) | Account, project data, uploaded and generated media | Always |
| Google Vertex AI (Gemini) | The video's audio (speech-to-text), transcript and translation text (translation, condensing) | Analysis, translation, dubbing |
| Google Cloud Text-to-Speech | Translated text | Dubbing, text-to-voice |
| Hugging Face Space at `HF_SPACE_URL` | Voice sample audio and the text to speak | Only if configured and a cloned voice is used |

- **Ownership and access:** uploaded content belongs to the workspace; its members can access it, and share-link holders can access the one dubbed video for 24 hours.
- **Model training:** Dubly doesn't use content for training. Whether Google or the Space operator may use it is governed by **their** terms and your agreements with them. Google Cloud's published terms for Vertex AI say customer data isn't used to train its models without permission. Confirm that against your own contract before telling customers. The Hugging Face Space's data handling depends on who operates it; treat it as a third party.

## Dependency posture
- `npm audit --omit=dev` reports **0 high/critical** issues. CI fails on high.
- **8 moderate issues remain** in the `firebase-admin@13` dependency chain (`google-gax`, `uuid`, `teeny-request`, `retry-request`). Clearing them needs `firebase-admin@14`, a major upgrade to plan and test separately.
