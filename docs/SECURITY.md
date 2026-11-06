# Security

## Authentication
- **Dubly's own accounts, in MongoDB** (`server/lib/accounts.ts`). Passwords are hashed with scrypt (N=2^15, r=8, 16-byte salt). Sign-in creates a server-side session: a 32-byte random token in an httpOnly, SameSite=Strict cookie (Secure over HTTPS), stored only as its SHA-256. Every request looks its session up, so signing out, a password change or reset, disabling or removing someone ends their sessions at once. Sessions end after 30 days, or 7 days unused.
- **Sign-up** (`ALLOW_SIGNUP`, on by default) needs the emailed link before the account gets a workspace and its free minutes. Sign-up and "forgot password" answer the same whether or not the email has an account, and a wrong email fails exactly like a wrong password (same message, same time).
- **Cross-site requests:** besides SameSite=Strict, any change sent with the cookie must come from Dubly's own pages (Sec-Fetch-Site / Origin), else `403 CROSS_SITE`.
- **Token checks:** every request verifies the ID token (signature, expiry, project). It also checks that the account isn't disabled, deleted or revoked since the token was issued. That check is cached per user for 30 s, so revoking or disabling someone takes effect within 30 s (`server/lib/auth.ts`).
- **Brute force:** sign-in is limited per address (30 per 15 min). Only wrong passwords count against an account: 10 per 15 min for one email from one address, 100 an hour for one email from everywhere. So someone guessing locks out only themselves, never the account's owner. Reset and verification emails are limited per address and per email. Reset links work once, for 30 minutes; verification links for 24 hours. Both are stored only as hashes.
- **Every request** first passes a per-address ceiling (`express-rate-limit`, 3000 a minute, `RATE_ALL_PER_IP_MINUTE`); per-route and per-user limits sit on top. Behind the Cloudflare front door the address is the visitor's own, sent by the Worker with a shared secret (`EDGE_SHARED_SECRET`); without the secret the header is ignored.
- **Session lookups are cached for 30 s** in memory. Signing out, "sign out everywhere", a password change or reset, disabling, deleting or removing someone all clear the entry at once, so they apply on the very next request. Only edits made straight in the database (Compass) wait up to 30 s.
- **Sign-in by email link, no password** (`server/lib/magicLink.ts`). The asking browser gets an httpOnly cookie tied to the attempt; the email carries a one-time link (15 minutes). Opened in that same browser, the link signs it in. Opened anywhere else, it signs nobody in and shows a 6-digit code (10 minutes, 5 tries) that only the asking browser can redeem, so a link someone requested for another person's address is useless to them unless that person reads the code out. The code page shows which device and place asked. Links and codes are stored only as hashes; an address without an account gets the same answers and no email.
- **New-device emails** (`server/lib/devices.ts`). Each browser carries a random device id (httpOnly cookie, 2 years). A sign-in from a device the account has not used before, by any method, emails the owner the time, device, approximate location and IP. The first device of an account is only remembered. Location comes from Cloudflare via the front-door Worker and is trusted only with the shared secret.
- **Content Security Policy is enforced** (scripts only from the site itself; no frames, plugins or other script origins).

## Authorization and tenancy
- The workspace comes only from the server-side membership lookup. Every project, job, share and usage query is addressed through `workspaces/{workspaceId}/…`, or checked against `workspaceId` for top-level records such as jobs and shares. Another workspace's IDs answer `404`, the same as missing ones.
- **Roles:** only admins can delete projects, rename the workspace, invite, change roles or remove members. Editors can do everything else. A workspace always keeps at least one admin.
- **Invitations** (`server/lib/workspaces.ts`):
  - No account is ever created and nobody is moved or copied at an admin's request.
  - Joining needs the private link, whose token is 256-bit and stored only as a SHA-256 hash, **and** a signed-in account with the invited email.
  - Links expire after 7 days, can be withdrawn, are single-use per user and idempotent. "Not for you", "revoked" and "doesn't exist" all give the same answer.
  - Someone already in another team with other members can't be pulled out by an invite.
  - A login created from a link (`/api/invite-signup/claim`) is **not** marked email-verified: the inviting admin holds the same link, so it proves nothing about the inbox. Without a verified email, the bell (`/api/invites/mine`) and `accept-by-id` offer that login only the invitation it was made from; any other team's invitation needs its own emailed link.
- **Tests:** `server/routes/workspace.test.ts` and `server/routes/*.test.ts` include cross-tenant tests covering projects, jobs, shares and voices.

## Uploads and media
- **Content checks:** judged by content (magic bytes plus the container ffprobe detects), never by filename, extension or MIME type. Videos must be MP4/MOV/WebM, with a picture and sound; voice samples are wav/mp3/m4a/ogg/flac/webm. Playlists, concat lists, images and AVI are refused (`server/lib/mediaValidation.ts`).
- **Size and length:** 500 MB per video and 60 minutes. Zero-length and unreadable files are refused.
- **ffmpeg:**
  - It's restricted to local-file inputs (`-protocol_whitelist file,pipe`), so a crafted file can't make it fetch URLs.
  - Every call has a timeout (5 min for quick operations, 120 min for renders), and ffprobe runs with a 60 s timeout.
  - Production uses the Debian package, security-patched through the image; local development uses ffmpeg 6.1 from `ffmpeg-static`.
- **Storage:** stored names come from server-generated IDs (`workspaces/{ws}/projects/{id}/source.<ext from content>`).
- **No server-side fetching of user URLs:** sample import takes a sample ID from a server list. The download is also checked: HTTPS only, allow-listed host, public IPs after DNS, no redirects, a timeout and a byte cap (`server/lib/safeDownload.ts`).

## Signed URLs and sharing
- Media is private in the database (GridFS). Clients get signed URLs to `/api/media` (HMAC-SHA256 over the path and expiry, key in `system.mediaUrlKey` or `MEDIA_URL_SECRET`) valid for **3 hours**, each reused for at most 55 minutes. A changed path, signature or expiry gets `403`.
- Share links are public for 24 hours, stored hashed, and can be turned off. The share page's own media URLs last at most 2 hours, and the page has a strict CSP and `Referrer-Policy: no-referrer`.

## API hardening
- **Validation:** zod schemas on every write endpoint (`server/lib/validation.ts`). JSON bodies are capped at 2 MB.
- **Rate limits and admission:** per-user, per-workspace and per-IP rate limits, plus admission control on heavy work (see DEPLOYMENT.md).
- **Errors:** a single error format. Unplanned server errors never reach clients, only the log (with `request_id`).
- **Headers:**
  - Enforced: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and HSTS on HTTPS.
  - The app's CSP ships as **Report-Only**. **To enforce it:** walk through sign-in, upload, analysis, translation, dubbing, export, share and text-to-voice with the browser console open. Add any legitimate source that gets reported to `APP_CSP` in `server/app.ts`, then rename the header to `Content-Security-Policy`.
- **CORS** allows only `WEB_ORIGIN`. Authentication is a bearer token (no cookies), so CSRF doesn't apply.

## Secrets
| Secret | Where it lives | Rotation |
|---|---|---|
| GCP service account (Vertex, TTS) | Production: **none** with `CREDENTIALS_MODE=adc` (the VM or Cloud Run service account). Development: `gcp-service-account.json` in `CREDENTIALS_DIR` | Create a new key in IAM → replace the file → restart → delete the old key. With ADC there's nothing to rotate |
| MongoDB passwords (`dubly_app`, `dubly_admin`, `dubly_test`) | `MONGODB_URI` in server/.env; all three in the credentials file `setup-users.mjs` wrote | Change with `db.changeUserPassword` as `dubly_admin`, update `MONGODB_URI`, restart |
| `GEMINI_API_KEY` (optional, Gemini 3.8 voices) | `server/.env` or `DUBLY_ENV_FILE` | Create a new key in Google AI Studio → replace it → restart → delete the old key |

- **Never committed:** `.env*` (except `.env.example`), `server/credentials/` and key files are gitignored. CI runs a secret scan (TruffleHog) over the full history.
- **Never logged:** tokens, JWTs, API keys, private keys, share tokens and URL signatures are redacted from every log line (`server/lib/log.ts`).
- **OneDrive:** the development copy of this repo sits in a OneDrive-synced folder, so `server/.env` and `server/credentials/` are uploaded to OneDrive. Either move the working copy out of OneDrive, or keep secrets elsewhere with `CREDENTIALS_DIR` and `DUBLY_ENV_FILE`, and delete them from the synced folder.
- **ADC permissions in production:** the runtime service account needs only Vertex AI User and Cloud Text-to-Speech access. The database is reached with its own login, never with Google credentials.
- **If a secret leaks:** rotate it at once as above, then check Cloud Audit Logs for its use. End the sessions of affected users with "Sign out everywhere", or delete their `sessions` documents; it takes effect on their next request.

## Data retention (implemented)
| Data | Kept |
|---|---|
| Projects and their media | Until deleted. Deleting a project removes its documents, every file in its storage folder and its share links |
| Server scratch files | ≤ 6 hours (sweeper), and removed right after each job normally |
| TTS audio cache (server disk) | Least recently used, capped at 1.5 GB; **not** removed when a project is deleted |
| Share links / invitations / idempotency keys / finished jobs | 7 days past expiry / 30 days past expiry / 2 days / 180 days |

**Not implemented (product decision needed):** automatic expiry of old projects, account deletion and workspace deletion.

## Privacy: what leaves Dubly
| Recipient | What | When |
|---|---|---|
| Google Vertex AI (Gemini) | The video's audio (speech-to-text), transcript and translation text (translation, condensing) | Analysis, translation, dubbing |
| Google Cloud Text-to-Speech | Translated text | Dubbing, text-to-voice (Gemini 2.5 Flash, Chirp 3 HD and premium voices) |
| Google Gemini API (Developer API with `GEMINI_API_KEY`, else Vertex AI) | Translated text and its delivery direction | Dubbing, text-to-voice (Gemini 3.8 voices) |

- **Ownership and access:** uploaded content belongs to the workspace; its members can access it, and share-link holders can access the one dubbed video for 24 hours.
- **Model training:** Dubly doesn't use content for training. Whether Google may use it is governed by **its** terms and your agreements with it. Google Cloud's published terms for Vertex AI say customer data isn't used to train its models without permission; the Gemini Developer API's paid-tier terms say the same, but its free tier may use content, so production must use a billed key. Confirm that against your own contract before telling customers.

## Dependency posture
- `npm audit --omit=dev` reports **0 high/critical** issues (`vite` 6.4.4 cleared the `launch-editor` advisories of 2026-10-21). CI fails on high; the Release gate also fails on any critical issue in the build and test tooling. New advisories are published every week, so a push can fail on one that appeared since the last; update the package rather than lowering the bar.
- `firebase`, `firebase-admin` and `firebase-tools` were removed on 2026-11-06 with the move to MongoDB, and their advisories with them.
- Development tooling (2026-10-19): `vitest` 4.1.12 and `firebase-tools` 15 cleared the critical `tinypool`, `@vitest/mocker` and `tar` advisories, and `concurrently` 9.2.5 the `shell-quote` one. 
- **CodeQL** (GitHub's default setup) alerts are checked by the Release gate before a deploy. `js/missing-rate-limiting` is reported on every route because CodeQL only recognises third-party rate-limit packages; every reported route is limited by `requireAuth` (per user) or `server/lib/rateLimit.ts` (per address), so those alerts are allowed by the gate and should be dismissed as false positives on GitHub.
