import { env } from './lib/env';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { requireAuth } from './lib/auth';
import { repoRoot } from './lib/paths';
import { healthRouter } from './routes/health';
import { settingsRouter } from './routes/settings';
import { usageRouter } from './routes/usage';
import { projectsRouter } from './routes/projects';
import { dubRouter } from './routes/dub';
import { ttsRouter } from './routes/tts';
import { voicesRouter } from './routes/voices';

const app = express();

app.use(cors({ origin: env.webOrigin }));
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[req] ${req.method} ${req.originalUrl} - started`);
  res.on('finish', () => {
    console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api/health', requireAuth, healthRouter);
app.use('/api/settings', requireAuth, settingsRouter);
app.use('/api/usage', requireAuth, usageRouter);
app.use('/api/tts', requireAuth, ttsRouter);
app.use('/api/voices', requireAuth, voicesRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/projects', requireAuth, dubRouter);

// Serves the built frontend (`npm run build` -> dist/) when it's present, so one process
// can be the whole deployment on a single small VM instead of needing a separate static
// host. Skipped entirely in local dev, where Vite's own dev server serves the frontend on
// its own port instead. The SPA has no server-side routes of its own (navigation is all
// client-side state, not URL-based), so any unmatched GET just gets index.html.
const distDir = path.join(repoRoot, 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] Unhandled error', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(env.port, () => {
  console.log(`Dubly API listening on http://localhost:${env.port}`);
});
