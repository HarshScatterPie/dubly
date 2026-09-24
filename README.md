# Dubly

AI video dubbing studio by ScatterPie. Upload a video (up to 60 minutes). Dubly transcribes it, translates it into up to 10 languages, voices every line with neural TTS (or a cloned voice), and renders the dubbed video. Teams share projects and a monthly minute allowance through workspaces.

- **Frontend:** React 19 + Vite + Tailwind, in `src/`
- **Backend:** Express 4 on Node 24 (run with `tsx`), in `server/`. The same process also serves the built frontend.
- **Data:** Firebase Auth, Firestore and Cloud Storage, in the Firebase project shared with ScatterStudio
- **AI:** Vertex AI Gemini (speech-to-text, translation) and Google Cloud TTS. Voice cloning is optional, via a Hugging Face Space.
- **Media:** ffmpeg (the OS package in Docker, the `ffmpeg-static` npm build locally)

## Local development

Requirements: Node 24+, Java 11+ (only for the test emulators), and access to the service accounts.

```bash
npm ci
cp .env.example .env            # fill in the VITE_FIREBASE_* values (public client config)
# server/.env: VERTEX_PROJECT_ID, FIREBASE_STORAGE_BUCKET, ... (see .env.example)
# server/credentials/: gcp-service-account.json, firebase-service-account.json
#   (or set CREDENTIALS_DIR to a folder outside OneDrive; see docs/SECURITY.md)
npm run dev                     # Vite on :3000, API on :8787 (Vite proxies /api)
```

> **Local development uses the real, shared Firebase project.** Everything you do in the running app happens in production data. Automated tests never do: they refuse to run outside the emulators.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # Vitest under the Firebase emulators (Firestore, Auth, Storage); no production access
npm run build       # production frontend bundle into dist/
```

CI runs all of these, plus a dependency audit, a secret scan and a Docker build (`.github/workflows/ci.yml`).

## Production

`docker build` → one container that serves both the API and the UI. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Components, request and job flow, module map |
| [API](docs/API.md) | Every endpoint, error format, limits |
| [DATABASE](docs/DATABASE.md) | Firestore collections, project layout, migrations, retention |
| [SECURITY](docs/SECURITY.md) | Auth, tenancy, uploads, secrets and rotation, privacy |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Image, configuration, limits, rollback |
| [RUNBOOK](docs/RUNBOOK.md) | Operating Dubly and handling incidents; log events and metrics |
| [DISASTER-RECOVERY](docs/DISASTER-RECOVERY.md) | Backups, restore procedures, RPO/RTO |
| [FIREBASE-RULES](docs/FIREBASE-RULES.md) | Security-rules ownership in the shared Firebase project |
| [ENTERPRISE-READINESS](docs/ENTERPRISE-READINESS.md) | Status of every audit finding |
