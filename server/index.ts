import { env } from './lib/env';
import express from 'express';
import cors from 'cors';
import { requireAuth } from './lib/auth';
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] Unhandled error', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(env.port, () => {
  console.log(`Dubly API listening on http://localhost:${env.port}`);
});
