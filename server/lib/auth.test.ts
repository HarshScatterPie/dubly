import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authAdmin, createUser, resetEmulators, signIn, startApi, type TestApi } from '../test/helpers';
import { clearAccountStateCache } from './auth';

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

const profile = (token?: string) => api.call('GET', '/api/profile', { token });
const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// The emulator accepts unsigned tokens but still enforces the claims, which is what lets an expired one be built here.
function forgeToken(uid: string, claims: Record<string, unknown>): string {
  const project = process.env.GCLOUD_PROJECT || 'demo-dubly';
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    sub: uid,
    user_id: uid,
    iat: now - 7200,
    auth_time: now - 7200,
    exp: now - 3600,
    ...claims,
  })}.`;
}

describe('requireAuth', () => {
  it('accepts a valid session', async () => {
    const user = await createUser('valid@team.test');
    expect((await profile(user.token)).status).toBe(200);
  });

  it('rejects missing, malformed and forged-garbage tokens', async () => {
    expect((await profile()).status).toBe(401);
    expect((await profile('not-a-jwt')).status).toBe(401);
    expect((await api.call('GET', '/api/profile', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const user = await createUser('expired@team.test');
    expect((await profile(forgeToken(user.uid, {}))).status).toBe(401);
  });

  it('rejects a token for a different project', async () => {
    const user = await createUser('other-project@team.test');
    const now = Math.floor(Date.now() / 1000);
    const token = forgeToken(user.uid, { aud: 'someone-elses-project', iss: 'https://securetoken.google.com/someone-elses-project', exp: now + 3600, iat: now, auth_time: now });
    expect((await profile(token)).status).toBe(401);
  });

  it('rejects sessions revoked after sign-in, and accepts the next sign-in', async () => {
    const user = await createUser('revoked@team.test');
    expect((await profile(user.token)).status).toBe(200);
    // Revocation is recorded to the second, so the token must be at least a second older than it.
    await new Promise((r) => setTimeout(r, 1100));
    await authAdmin.revokeRefreshTokens(user.uid);

    // Within the cache window the old answer still stands (bounded at ACCOUNT_STATE_CACHE_MS); after it, the session is refused.
    clearAccountStateCache(user.uid);
    expect((await profile(user.token)).status).toBe(401);

    await new Promise((r) => setTimeout(r, 1100));
    expect((await profile(await signIn(user.email))).status).toBe(200);
  });

  it('rejects disabled and deleted accounts', async () => {
    const disabled = await createUser('disabled@team.test');
    const deleted = await createUser('deleted@team.test');
    await authAdmin.updateUser(disabled.uid, { disabled: true });
    await authAdmin.deleteUser(deleted.uid);
    clearAccountStateCache();
    expect((await profile(disabled.token)).status).toBe(401);
    expect((await profile(deleted.token)).status).toBe(401);
  });
});
