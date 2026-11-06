import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createUser, resetDatabase, startApi, type TestApi, type TestUser } from '../test/helpers';
import { setWorkspacePlan } from '../lib/plans';
import { getSignedDownloadUrl, signReadUrl, uploadBufferToStorage } from '../lib/mediaStore';
import { rateRules } from '../lib/limits';
import { env } from '../lib/env';
import { shareCsp } from '../lib/sharePage';
import { MAX_SOURCE_VIDEO_BYTES } from './projects';
import { setSpeechSynthesisForTests } from './tts';

// What an outsider would try against the server itself, with no browser in the way. Every request here goes straight to the API.

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  setSpeechSynthesisForTests(null);
  await api.close();
});
beforeEach(resetDatabase);

const workspaceOf = async (user: TestUser) => (await api.call('GET', '/api/workspace', { token: user.token })).body as { id: string };
const newProject = async (user: TestUser, title = 'Launch video') => (await api.call('POST', '/api/projects', { token: user.token, body: { title } })).body as { id: string };

function uploadForm(token: string, projectId: string, name: string, type: string, content: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)], { type }), name);
  return fetch(`${api.baseUrl}/api/projects/${projectId}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

describe('uploads the browser never checked', () => {
  it('refuses a text file, whatever it calls itself', async () => {
    const user = await createUser('txt@team.test');
    const { id } = await newProject(user);
    expect((await uploadForm(user.token, id, 'notes.txt', 'text/plain', Buffer.from('hello'))).status).toBe(400);
    // Dressed up as a video: refused by its content.
    const disguised = await uploadForm(user.token, id, 'notes.mp4', 'video/mp4', Buffer.from('hello, this is not a video at all'));
    expect(disguised.status).toBe(400);
  });

  it('refuses an empty file', async () => {
    const user = await createUser('empty@team.test');
    const { id } = await newProject(user);
    const res = await uploadForm(user.token, id, 'empty.mp4', 'video/mp4', Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('EMPTY_FILE');
  });

  it('refuses an oversized body from its headers, before anything is written', async () => {
    const user = await createUser('huge@team.test');
    const { id } = await newProject(user);
    const { hostname, port } = new URL(api.baseUrl);
    // Says 6 GB and sends nothing: the answer has to come from the headers alone.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname,
          port,
          method: 'POST',
          path: `/api/projects/${id}/upload`,
          headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(6 * 1024 ** 3) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(MAX_SOURCE_VIDEO_BYTES).toBeLessThan(6 * 1024 ** 3);
  });

  it('refuses an upload to a project of another workspace before reading the file', async () => {
    const owner = await createUser('owner@team.test');
    const outsider = await createUser('outsider@team.test');
    const { id } = await newProject(owner);
    await workspaceOf(outsider);
    expect((await uploadForm(outsider.token, id, 'clip.mp4', 'video/mp4', Buffer.from('x'))).status).toBe(404);
  });
});

describe('voice clips', () => {
  const generate = (user: TestUser, text: string) => api.call('POST', '/api/tts/generate', { token: user.token, body: { text, voiceId: 'gemini-lite-kore' } });

  it('refuses a script too long for one clip, without calling a voice', async () => {
    let calls = 0;
    setSpeechSynthesisForTests((async () => {
      calls++;
      throw new Error('must not be reached');
    }) as never);
    const user = await createUser('script@team.test');
    await workspaceOf(user);
    const res = await generate(user, 'word '.repeat(24_000));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TEXT_TOO_LONG');
    // Counted in bytes, as Google counts them: 2,000 letters of Hindi are 6,000 bytes.
    expect((await generate(user, 'न'.repeat(2000))).body.error.code).toBe('TEXT_TOO_LONG');
    expect(calls).toBe(0);
  });
});

describe('one workspace cannot reach another', () => {
  it('reads, changes and deletes nothing across workspaces', async () => {
    const owner = await createUser('owner@team.test');
    const outsider = await createUser('outsider@team.test');
    await workspaceOf(outsider);
    const { id } = await newProject(owner, 'Confidential');

    expect((await api.call('GET', `/api/projects/${id}`, { token: outsider.token })).status).toBe(404);
    expect((await api.call('GET', `/api/projects/${id}/progress`, { token: outsider.token })).status).toBe(404);
    expect((await api.call('PATCH', `/api/projects/${id}`, { token: outsider.token, body: { title: 'Mine now' } })).status).toBe(404);
    expect((await api.call('DELETE', `/api/projects/${id}`, { token: outsider.token })).status).toBe(404);
    expect(((await api.call('GET', '/api/projects', { token: outsider.token })).body as unknown[]).length).toBe(0);
    expect((await api.call('GET', `/api/projects/${id}`, { token: owner.token })).body.title).toBe('Confidential');
  });
});

describe('roles', () => {
  it('keeps an editor out of what only admins may do', async () => {
    const admin = await createUser('admin@team.test');
    const editor = await createUser('editor@team.test');
    const { id: workspaceId } = await workspaceOf(admin);
    await workspaceOf(editor);
    await setWorkspacePlan(workspaceId, 'enterprise');
    const invited = await api.call('POST', '/api/workspace/invites', { token: admin.token, body: { email: editor.email, role: 'editor' } });
    expect((await api.call('POST', '/api/invites/accept', { token: editor.token, body: { token: invited.body.token } })).status).toBeLessThan(300);
    const { id: projectId } = await newProject(admin);

    expect((await api.call('POST', '/api/workspace/invites', { token: editor.token, body: { email: 'x@team.test', role: 'editor' } })).status).toBe(403);
    expect((await api.call('GET', '/api/workspace/invites', { token: editor.token })).status).toBe(403);
    expect((await api.call('DELETE', `/api/workspace/members/${admin.uid}`, { token: editor.token })).status).toBe(403);
    expect((await api.call('DELETE', `/api/projects/${projectId}`, { token: editor.token })).status).toBe(403);
    // Still a member in good standing for what editors do.
    expect((await api.call('GET', `/api/projects/${projectId}`, { token: editor.token })).status).toBe(200);
  });
});

describe('signed media links', () => {
  const PATH = 'workspaces/ws-secret/projects/project-secret/source.mp4';

  it('say nothing about the workspace, the project or the account', async () => {
    await uploadBufferToStorage(PATH, Buffer.from('video'), 'video/mp4');
    const url = await getSignedDownloadUrl(PATH);
    const sealed = /\/api\/media\/([^?]+)/.exec(url)![1];
    const readable = `${url} ${Buffer.from(sealed, 'base64url').toString('latin1')}`;
    expect(readable).not.toMatch(/ws-secret|project-secret|workspaces\//);
  });

  it('stop working when any part is changed, or the time is up', async () => {
    await uploadBufferToStorage(PATH, Buffer.from('video'), 'video/mp4');
    await uploadBufferToStorage('workspaces/ws-other/projects/p/source.mp4', Buffer.from('other'), 'video/mp4');
    const url = await signReadUrl(PATH, Date.now() + 60_000);
    const other = await signReadUrl('workspaces/ws-other/projects/p/source.mp4', Date.now() + 60_000);
    const get = (u: string) => fetch(`${api.baseUrl}${u}`).then((r) => r.status);

    expect(await get(url)).toBe(200);
    // Another file's sealed path under this link's signature.
    expect(await get(url.replace(/\/api\/media\/[^?]+/, /\/api\/media\/[^?]+/.exec(other)![0]))).toBe(403);
    // The old readable form of the same path.
    expect(await get(url.replace(/\/api\/media\/[^?]+/, `/api/media/${Buffer.from(PATH).toString('base64url')}`))).toBe(403);
    // A later expiry than was signed.
    expect(await get(url.replace(/e=\d+/, `e=${Math.floor(Date.now() / 1000) + 99_999}`))).toBe(403);
    expect(await get(url.replace(/s=[^&]+/, 's=AAAA'))).toBe(403);
    expect(await get(await signReadUrl(PATH, Date.now() - 1000))).toBe(403);
  });
});

describe('rate limits on signing in', () => {
  it('stops repeated logins from one address', async () => {
    const attempts = rateRules.loginPerIp.max + 1;
    const statuses: number[] = [];
    for (let i = 0; i < attempts; i++) statuses.push((await api.call('POST', '/api/auth/login', { body: { email: `nobody${i}@team.test`, password: 'wrong password' } })).status);
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('stops repeated sign-in links to one address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= rateRules.authEmailPerAddress.max; i++) statuses.push((await api.call('POST', '/api/auth/magic/request', { body: { email: 'target@team.test' } })).status);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('other websites', () => {
  const EVIL = 'https://evil.example';

  it('are not allowed to read answers', async () => {
    const user = await createUser('cors@team.test');
    const res = await api.call('GET', '/api/profile', { token: user.token, headers: { Origin: EVIL } });
    expect(res.headers.get('access-control-allow-origin')).toBe(env.webOrigin);
    expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
  });

  it('cannot post to sign-in from a browser', async () => {
    const res = await api.call('POST', '/api/auth/login', {
      body: { email: 'a@team.test', password: 'whatever it is' },
      headers: { Origin: EVIL, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });
});

describe('what the browser is told', () => {
  it('keeps private answers out of every cache, and leaves media to its own policy', async () => {
    const user = await createUser('cache@team.test');
    await workspaceOf(user);
    for (const path of ['/api/projects', '/api/usage', '/api/bootstrap', '/api/workspace', '/api/auth/me']) {
      expect((await api.call('GET', path, { token: user.token })).headers.get('cache-control')).toBe('no-store');
    }
    // An error is private too.
    expect((await api.call('GET', '/api/projects')).headers.get('cache-control')).toBe('no-store');

    await uploadBufferToStorage('workspaces/w/projects/p/clip.mp4', Buffer.from('video'), 'video/mp4');
    const media = await fetch(`${api.baseUrl}${await getSignedDownloadUrl('workspaces/w/projects/p/clip.mp4')}`);
    expect(media.headers.get('cache-control')).toMatch(/^private, max-age=\d+, no-transform$/);
  });

  it('allows no inline styles and no outside media', async () => {
    const policy = (await api.call('GET', '/api/healthz')).headers.get('content-security-policy') ?? '';
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).toMatch(/media-src 'self' data: blob:(;|$)/);
    expect(shareCsp('nonce')).not.toContain('unsafe-inline');
    expect(shareCsp('nonce')).not.toContain('storage.googleapis.com');
  });

  it('marks the session cookie so script cannot read it and other sites cannot send it', async () => {
    await createUser('cookie@team.test', 'correct-horse-battery');
    const res = await api.call('POST', '/api/auth/login', { body: { email: 'cookie@team.test', password: 'correct-horse-battery' } });
    const cookie = res.headers.getSetCookie().find((line) => line.startsWith('dubly_session=')) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
});
