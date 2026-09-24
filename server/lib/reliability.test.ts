import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Router } from './router';
import { sweepTmp } from './tmpSweeper';
import { isDraining, resetLifecycleForTests, startDraining, trackBackgroundWork, waitForBackgroundWork } from './lifecycle';
import { createApp, errorHandler, GENERIC_ERROR_MESSAGE, normalizeErrorResponses, redactUrl } from '../app';
import { addLogContext, log, redact, setJsonLogging, withLogContext } from './log';

async function serve(app: express.Express) {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('async route errors', () => {
  it('turns a rejected async handler into a generic 500 instead of crashing the process', async () => {
    const router = Router();
    router.get('/boom', async () => {
      throw new Error('FAILED_PRECONDITION: firestore index missing at /srv/dubly/server/lib/projectRepo.ts');
    });
    router.get('/ok', async (_req, res) => {
      res.json({ ok: true });
    });
    const app = express();
    app.use('/t', router);
    app.use(errorHandler);
    const { base, close } = await serve(app);
    try {
      const boom = await fetch(`${base}/t/boom`);
      expect(boom.status).toBe(500);
      const text = await boom.text();
      expect(JSON.parse(text).code).toBe('INTERNAL');
      expect(text).not.toContain('projectRepo');
      expect(text).not.toContain('FAILED_PRECONDITION');
      const ok = await fetch(`${base}/t/ok`);
      expect(ok.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('keeps the internal error text out of the API response and returns a request id', async () => {
    const app = createApp({ serveFrontend: false, logRequests: false });
    const { base, close } = await serve(app);
    try {
      const res = await fetch(`${base}/api/healthz`);
      expect(res.headers.get('x-request-id')).toBeTruthy();
      const bad = await fetch(`${base}/api/share/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error.code).toBe('INVALID_REQUEST');
    } finally {
      await close();
    }
  });

  it('redacts share tokens from logged URLs', () => {
    expect(redactUrl('/api/share/abcDEF123_-?x=1')).toBe('/api/share/[redacted]?x=1');
    expect(redactUrl('/api/projects/p1')).toBe('/api/projects/p1');
  });
});

describe('graceful shutdown bookkeeping', () => {
  it('waits for tracked work and reports when the grace window runs out', async () => {
    resetLifecycleForTests();
    let finish!: () => void;
    const slow = new Promise<void>((r) => (finish = r));
    void trackBackgroundWork(slow);
    startDraining();
    expect(isDraining()).toBe(true);
    expect(await waitForBackgroundWork(50)).toBe(false);
    finish();
    expect(await waitForBackgroundWork(1000)).toBe(true);
    resetLifecycleForTests();
  });
});

describe('temporary file sweeper', () => {
  it('removes old scratch entries, keeps recent ones and anything still in use', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dubly-sweep-'));
    const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000;
    const mk = async (rel: string, isOld: boolean, file = false) => {
      const full = path.join(root, rel);
      if (file) {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, 'x');
      } else {
        await mkdir(full, { recursive: true });
      }
      if (isOld) await utimes(full, old, old);
      return full;
    };
    const crashed = await mk('jobs/job-crashed', true);
    const running = await mk('jobs/job-running', true);
    const fresh = await mk('jobs/job-fresh', false);
    const upload = await mk('uploads/abc.mp4', true, true);
    const loose = await mk('vad_1.raw', true, true);
    const unrelated = await mk('not-scratch/keep-me', true);

    const removed = await sweepTmp({ root, keep: new Set([running]) });
    expect(removed.sort()).toEqual([crashed, upload, loose].map((p) => path.resolve(p)).sort());
    await expect(stat(crashed)).rejects.toThrow();
    await stat(running);
    await stat(fresh);
    await stat(unrelated);
  });
});

describe('error responses', () => {
  it('gives every error one shape and hides unplanned 5xx text', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = 'req-test-123';
      next();
    });
    app.use(normalizeErrorResponses);
    app.get('/raw', (_req, res) => res.status(500).json({ error: 'ENOENT: /srv/dubly/server/credentials/gcp-service-account.json' }));
    app.get('/planned', (_req, res) => res.status(503).json({ error: 'Dubly is restarting.', code: 'SERVER_RESTARTING' }));
    app.get('/client', (_req, res) => res.status(409).json({ error: 'Already running', code: 'JOB_ALREADY_RUNNING', jobId: 'job-1' }));
    app.get('/ok', (_req, res) => res.json({ error: 'not an error response' }));
    const { base, close } = await serve(app);
    try {
      const raw = await (await fetch(`${base}/raw`)).json();
      expect(raw).toEqual({ error: { code: 'INTERNAL', message: GENERIC_ERROR_MESSAGE, request_id: 'req-test-123' } });
      const planned = await (await fetch(`${base}/planned`)).json();
      expect(planned.error).toMatchObject({ code: 'SERVER_RESTARTING', message: 'Dubly is restarting.' });
      const client = await (await fetch(`${base}/client`)).json();
      expect(client.error).toEqual({ code: 'JOB_ALREADY_RUNNING', message: 'Already running', request_id: 'req-test-123', jobId: 'job-1' });
      expect(await (await fetch(`${base}/ok`)).json()).toEqual({ error: 'not an error response' });
    } finally {
      await close();
    }
  });

  it('sends the security headers', async () => {
    const { base, close } = await serve(createApp({ serveFrontend: false, logRequests: false }));
    try {
      const res = await fetch(`${base}/api/healthz`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('content-security-policy-report-only')).toContain("frame-ancestors 'none'");
    } finally {
      await close();
    }
  });
});

describe('structured logging', () => {
  it('redacts credentials whatever code tried to print them', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
    const text = [
      `Authorization: Bearer ${jwt}`,
      `token ${jwt}`,
      'hf_AbCdEfGhIjKlMnOpQrStUv',
      'key AIzaSyD0000000000000000fakeTestKey00000',
      '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
      'GET /api/share/abcdefghijklmnop',
      'https://storage.googleapis.com/b/o?X-Goog-Signature=deadbeef&x=1',
      '{"password":"hunter2","private_key":"xyz"}',
    ].join('\n');
    const out = redact(text);
    for (const secret of [jwt, 'hf_AbCdEfGhIjKlMnOpQrStUv', 'AIzaSyD0000000000000000fakeTestKey00000', 'MIIEv', 'abcdefghijklmnop', 'deadbeef', 'hunter2', '"xyz"']) {
      expect(out).not.toContain(secret);
    }
  });

  it('writes JSON lines carrying the request/job context of the code that logged', () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      lines.push(String(chunk));
      return true;
    };
    setJsonLogging(true);
    try {
      withLogContext({ requestId: 'req-1', jobId: 'job-9' }, () => {
        addLogContext({ userId: 'user-7' });
        log.info('job_started', { languages: ['hi'] });
      });
    } finally {
      setJsonLogging(false);
      (process.stdout as { write: unknown }).write = original;
    }
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ severity: 'INFO', event: 'job_started', requestId: 'req-1', jobId: 'job-9', userId: 'user-7', languages: ['hi'] });
    expect(typeof entry.timestamp).toBe('string');
  });
});
