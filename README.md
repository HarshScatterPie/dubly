# Dubly

AI video dubbing studio by ScatterPie. Upload a video (up to 60 minutes). Dubly transcribes it, translates it into up to 10 of 45 languages (every major Indian language and dialect among them), voices every line with Google's Gemini and Chirp 3 HD voices, and renders the dubbed video. Teams share projects and a monthly minute allowance through workspaces.

- **Frontend:** React 19 + Vite + Tailwind, in `src/`
- **Backend:** Express 4 on Node 24 (run with `tsx`), in `server/`. The same process also serves the built frontend.
- **Data:** MongoDB only: accounts and sessions, every record, and every stored file (GridFS). See [MONGODB](docs/MONGODB.md)
- **AI:** Vertex AI Gemini 3.5 Flash-Lite (speech-to-text, translation, review), and Google Cloud TTS voices (Gemini 2.5 Flash and Chirp 3 HD) by default. Gemini 3.8 Flash-Lite and Flash TTS (Gemini API) take over with `TTS_ENGINE=gemini` and a paid key.
- **Media:** ffmpeg (the OS package in Docker, the `ffmpeg-static` npm build locally)

## Local development

Requirements: Node 24+, a MongoDB replica set (local setup in [docs/MONGODB.md](docs/MONGODB.md)), and the Google service account for the AI models.

```bash
npm ci
# server/.env: MONGODB_URI, MONGODB_DB, MONGODB_TEST_URI, VERTEX_PROJECT_ID, SMTP_* ... (see .env.example)
# server/credentials/: gcp-service-account.json (Vertex AI + Cloud TTS only)
#   (or set CREDENTIALS_DIR to a folder outside OneDrive; see docs/SECURITY.md)
npm run dev                     # Vite on :3000, API on :8787 (Vite proxies /api)
```

> **Local development uses whatever database `MONGODB_URI` points at.** Automated tests never touch it: they run in a database whose name must end in `_test`, emptied between tests.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # Vitest against MongoDB (MONGODB_TEST_URI, a *_test database); no real data
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
| [DATABASE](docs/DATABASE.md) | Project layout, transactions, indexes, retention |
| [MONGODB](docs/MONGODB.md) | MongoDB setup, users, Compass, collections, files, backups |
| [SECURITY](docs/SECURITY.md) | Auth, tenancy, uploads, secrets and rotation, privacy |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Image, configuration, limits, rollback |
| [RUNBOOK](docs/RUNBOOK.md) | Operating Dubly and handling incidents; log events and metrics |
| [DISASTER-RECOVERY](docs/DISASTER-RECOVERY.md) | Backups, restore procedures, RPO/RTO |
| [ENTERPRISE-READINESS](docs/ENTERPRISE-READINESS.md) | Status of every audit finding |
