import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertSafeDownloadUrl, isPublicAddress, streamToFile, type Resolver } from './safeDownload';
import { createUser, db, resetEmulators, startApi, type TestApi } from '../test/helpers';

const resolvesTo = (...addresses: string[]): Resolver => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const HOSTS = ['videos.example.com'];

describe('isPublicAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254'])(
    'blocks %s',
    (ip) => expect(isPublicAddress(ip)).toBe(false)
  );
  it.each(['8.8.8.8', '142.250.72.14', '172.32.0.1', '2607:f8b0:4004:800::200e'])('allows %s', (ip) => expect(isPublicAddress(ip)).toBe(true));
  it('blocks things that are not IPs', () => expect(isPublicAddress('localhost')).toBe(false));
});

describe('assertSafeDownloadUrl', () => {
  const pub = resolvesTo('93.184.216.34');
  it('allows an https URL on the allow-list that resolves publicly', async () => {
    await expect(assertSafeDownloadUrl('https://videos.example.com/a.mp4', HOSTS, pub)).resolves.toBeInstanceOf(URL);
  });
  it.each([
    ['plain http', 'http://videos.example.com/a.mp4'],
    ['a host off the list', 'https://evil.example.net/a.mp4'],
    ['a lookalike host', 'https://videos.example.com.evil.net/a.mp4'],
    ['the cloud metadata server', 'https://169.254.169.254/computeMetadata/v1/'],
    ['an IPv6 literal', 'https://[::1]/a.mp4'],
    ['loopback by name', 'https://localhost/a.mp4'],
    ['embedded credentials', 'https://user:pw@videos.example.com/a.mp4'],
    ['a non-standard port', 'https://videos.example.com:8443/a.mp4'],
    ['a file URL', 'file:///etc/passwd'],
    ['garbage', 'not a url'],
  ])('refuses %s', async (_label, url) => {
    await expect(assertSafeDownloadUrl(url, HOSTS, pub)).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    ['a private address', resolvesTo('10.0.0.5')],
    ['loopback', resolvesTo('127.0.0.1')],
    ['the metadata address', resolvesTo('169.254.169.254')],
    ['a mix of public and private', resolvesTo('93.184.216.34', '192.168.0.10')],
    ['nothing', resolvesTo()],
  ])('refuses an allow-listed host that resolves to %s', async (_label, resolver) => {
    await expect(assertSafeDownloadUrl('https://videos.example.com/a.mp4', HOSTS, resolver)).rejects.toMatchObject({ status: 400 });
  });
});

describe('streamToFile', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  let redirectTargetHits = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.end('small video');
      } else if (req.url === '/declared-huge') {
        res.writeHead(200, { 'Content-Length': String(10_000) });
        res.end('x'.repeat(10_000));
      } else if (req.url === '/streamed-huge') {
        res.writeHead(200, { 'Transfer-Encoding': 'chunked' });
        let sent = 0;
        const tick = () => {
          if (sent >= 20) return res.end();
          sent++;
          res.write('y'.repeat(1000), tick);
        };
        tick();
      } else if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/internal-secret' });
        res.end();
      } else if (req.url === '/internal-secret') {
        redirectTargetHits++;
        res.end('secret');
      } else if (req.url === '/hang') {
        res.writeHead(200);
        res.write('partial');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), 'dubly-dl-'));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const limits = { maxBytes: 5_000, timeoutMs: 2_000 };

  it('saves a normal download', async () => {
    const dest = path.join(dir, 'ok.mp4');
    await expect(streamToFile(`${base}/ok`, dest, limits)).resolves.toEqual({ bytes: 11 });
    expect(await readFile(dest, 'utf8')).toBe('small video');
  });
  it('refuses a response that declares more than the cap, leaving no file', async () => {
    const dest = path.join(dir, 'declared.mp4');
    await expect(streamToFile(`${base}/declared-huge`, dest, limits)).rejects.toMatchObject({ status: 413 });
    await expect(stat(dest)).rejects.toThrow();
  });
  it('stops a stream that goes past the cap without declaring its size, leaving no file', async () => {
    const dest = path.join(dir, 'streamed.mp4');
    await expect(streamToFile(`${base}/streamed-huge`, dest, limits)).rejects.toMatchObject({ status: 413 });
    await expect(stat(dest)).rejects.toThrow();
  });
  it('does not follow redirects', async () => {
    const dest = path.join(dir, 'redirect.mp4');
    await expect(streamToFile(`${base}/redirect`, dest, limits)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    expect(redirectTargetHits).toBe(0);
  });
  it('gives up at the deadline', async () => {
    const dest = path.join(dir, 'hang.mp4');
    await expect(streamToFile(`${base}/hang`, dest, { maxBytes: 5_000, timeoutMs: 300 })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    await expect(stat(dest)).rejects.toThrow();
  });
});

describe('POST /api/projects/:id/import-sample', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetEmulators();
  });

  it('refuses every URL that is not one of the built-in samples, without fetching it', async () => {
    const user = await createUser('importer@team.test');
    const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'x' } });
    const importIt = (body: unknown) => api.call('POST', `/api/projects/${project.body.id}/import-sample`, { token: user.token, body });

    for (const sourceUrl of [
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
      'http://localhost:8787/api/healthz',
      'https://evil.example.net/video.mp4',
      'file:///etc/passwd',
    ]) {
      const res = await importIt({ sourceUrl });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('UNKNOWN_SAMPLE');
    }
    expect((await importIt({ sampleId: 'nope' })).status).toBe(400);
    expect((await importIt({})).status).toBe(400);
    const stored = await db.collection('workspaces').doc((await api.call('GET', '/api/workspace', { token: user.token })).body.id).collection('projects').doc(project.body.id).get();
    expect(stored.get('videoStoragePath')).toBeUndefined();
  });
});
