import { env } from './lib/env';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import multer from 'multer';
import { HttpError } from './lib/httpError';
import { log, withLogContext } from './lib/log';
import { requireAuth, requireWorkspace } from './lib/auth';
import { repoRoot } from './lib/paths';
import { healthRouter } from './routes/health';
import { settingsRouter } from './routes/settings';
import { usageRouter } from './routes/usage';
import { projectsRouter } from './routes/projects';
import { dubRouter } from './routes/dub';
import { ttsRouter } from './routes/tts';
import { voicesRouter } from './routes/voices';
import { profileRouter } from './routes/profile';
import { publicShareRouter, shareCreateRouter } from './routes/share';
import { invitesRouter, workspaceRouter } from './routes/workspace';
import { jobsRouter } from './routes/jobs';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const DEFAULT_ERROR_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'TOO_LARGE',
  429: 'RATE_LIMITED',
  503: 'UNAVAILABLE',
};
export const GENERIC_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';

// Gives every JSON error one shape { error: { code, message, request_id } }; unplanned 5xx text is logged and replaced with a generic message.
export function normalizeErrorResponses(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const send = res.json.bind(res);
  res.json = (body?: unknown) => {
    const payload = body as { error?: unknown; code?: unknown } | undefined;
    if (res.statusCode >= 400 && payload && typeof payload === 'object' && typeof payload.error === 'string') {
      const { error, code, ...details } = payload as Record<string, unknown> & { error: string; code?: string };
      delete details.requestId;
      let message = error;
      if (res.statusCode >= 500 && !code) {
        log.error('unplanned_error_response', new Error(error), { status: res.statusCode, route: `${req.baseUrl}${req.route?.path ?? ''}` });
        message = GENERIC_ERROR_MESSAGE;
      }
      return send({
        error: { code: code ?? DEFAULT_ERROR_CODES[res.statusCode] ?? 'INTERNAL', message, request_id: req.requestId, ...details },
      });
    }
    return send(body);
  };
  next();
}

// Reported, not enforced, until the UI has been exercised under it; see docs/SECURITY.md for the switch to enforcing.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: https://images.unsplash.com https://storage.googleapis.com",
  "media-src 'self' data: blob: https://storage.googleapis.com https://interactive-examples.mdn.mozilla.net https://images-assets.nasa.gov",
  "connect-src 'self' data: blob: https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://storage.googleapis.com",
  'frame-src https://*.firebaseapp.com',
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Signed media URLs must not leak to other sites through the Referer header.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  // Google sign-in opens a popup that must be able to report back.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy-Report-Only', APP_CSP);
  next();
}

// Share tokens are bearer secrets, so they never go into logs.
export function redactUrl(url: string): string {
  return url.replace(/(\/api\/share\/)[^/?#]+/, '$1[redacted]');
}

export function createApp(options: { serveFrontend?: boolean; logRequests?: boolean } = {}): express.Express {
  const app = express();
  // Behind a proxy/tunnel the client address is in X-Forwarded-For; set TRUST_PROXY (e.g. 1 = one hop) so per-IP limits see it.
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);

  // Every request gets an id (a well-formed incoming X-Request-Id is kept) that tags its log lines and access-log entry.
  app.use((req, res, next) => {
    const incoming = req.get('X-Request-Id');
    req.requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (options.logRequests === false) return;
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      log.info(
        'http_request',
        { requestId: req.requestId, userId: req.uid, workspaceId: req.workspaceId, method: req.method, route, status: res.statusCode, durationMs: Math.round(durationMs) },
        `${req.method} ${redactUrl(req.originalUrl)} -> ${res.statusCode} (${Math.round(durationMs)}ms)`
      );
    });
    withLogContext({ requestId: req.requestId }, () => next());
  });
  app.use(normalizeErrorResponses);

  app.use(securityHeaders);
  app.use(cors({ origin: env.webOrigin }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/api/health', requireAuth, healthRouter);
  app.use('/api/profile', requireAuth, profileRouter);
  app.use('/api/settings', requireAuth, settingsRouter);
  app.use('/api/usage', requireAuth, requireWorkspace, usageRouter);
  app.use('/api/tts', requireAuth, ttsRouter);
  app.use('/api/voices', requireAuth, voicesRouter);
  // Invitations addressed to the caller are resolved by their email, before (and regardless of) which workspace they are in.
  app.use('/api/invites', requireAuth, invitesRouter);
  // Projects belong to a workspace: every request is resolved to the caller's workspace and role first.
  app.use('/api/workspace', requireAuth, requireWorkspace, workspaceRouter);
  app.use('/api/projects', requireAuth, requireWorkspace, projectsRouter);
  app.use('/api/projects', requireAuth, requireWorkspace, dubRouter);
  app.use('/api/projects', requireAuth, requireWorkspace, shareCreateRouter);
  app.use('/api/projects', requireAuth, requireWorkspace, jobsRouter);
  // Public on purpose: recipients of a share link are not Dubly users.
  app.use('/api/share', publicShareRouter);

  // Serves the built frontend (`npm run build` -> dist/) when present, so one process can be the whole deployment; any unmatched GET gets index.html.
  const distDir = path.join(repoRoot, 'dist');
  if (options.serveFrontend !== false && existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}

// Internal details (provider, database, filesystem errors) stay in the log; the client gets a generic message and the request id to quote.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error & { status?: number; type?: string }, req: express.Request, res: express.Response, _next: express.NextFunction): void {
  if (res.headersSent) return;
  if (err.type === 'entity.too.large' || err.type === 'entity.parse.failed') {
    res.status(err.status || 400).json({ error: 'The request body is invalid or too large.', code: 'INVALID_REQUEST' });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'That file is too large.' : 'The upload could not be read.',
      code: tooLarge ? 'FILE_TOO_LARGE' : 'INVALID_UPLOAD',
    });
    return;
  }
  log.error('unhandled_error', err, { method: req.method, route: `${req.baseUrl}${req.route?.path ?? ''}`, url: redactUrl(req.originalUrl) });
  res.status(500).json({ error: GENERIC_ERROR_MESSAGE, code: 'INTERNAL' });
}
