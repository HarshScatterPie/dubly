import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The client's cache, run against a stand-in for the browser's localStorage.
class MemoryStorage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  clear() {
    this.items.clear();
  }
}

const storage = new MemoryStorage();
let cache: typeof import('../../src/lib/bootCache');

const usage = {
  minutesDubbed: 1,
  minutesLimit: 50,
  activePlan: 'Starter',
  planId: 'starter',
  voiceEngines: ['gemini-flash-lite'],
  extraRates: {},
};
const boot = () =>
  ({
    workspace: { id: 'w1', name: 'Team', myRole: 'admin', myUid: 'u1', members: [{ uid: 'u1', email: 'asha@team.test', name: 'Asha', role: 'admin' }] },
    preferences: { theme: 'light' },
    usage,
    projects: [
      {
        id: 'p1',
        title: 'Launch',
        videoUrl: '/api/media/abc?e=1&s=2',
        videoThumbnailUrl: '/api/media/def?e=1&s=2',
        languageOutputs: { hi: { finalDubbedVideoUrl: '/api/media/ghi?e=1&s=2' } },
      },
    ],
    profile: { name: 'Asha', role: 'admin', workspace: 'Team' },
  }) as never;

beforeAll(async () => {
  vi.stubGlobal('localStorage', storage);
  storage.setItem('dubly.boot.v1.u1', JSON.stringify({ savedAt: Date.now(), data: { projects: [{ videoUrl: '/api/media/old' }] } }));
  cache = await import('../../src/lib/bootCache');
});
beforeEach(() => {
  for (const key of ['dubly.boot.v2.u1']) storage.removeItem(key);
});

describe('the boot cache', () => {
  it('drops copies saved before links and addresses were left out', () => {
    expect(storage.getItem('dubly.boot.v1.u1')).toBeNull();
  });

  it('keeps no signed links or email addresses in the browser', () => {
    cache.writeBootCache('u1', boot());
    const raw = storage.getItem('dubly.boot.v2.u1')!;
    expect(raw).not.toContain('/api/media/');
    expect(raw).not.toContain('asha@team.test');
    expect(cache.readBootCache('u1')?.workspace.members[0].name).toBe('Asha');
    expect(cache.readBootCache('u1')?.projects[0].title).toBe('Launch');
  });

  it('never stores a bad answer over a good copy', () => {
    cache.writeBootCache('u1', boot());
    cache.updateBootCache('u1', { projects: null as never });
    expect(cache.readBootCache('u1')?.projects).toHaveLength(1);
    cache.updateBootCache('u1', { usage: {} as never });
    expect(cache.readBootCache('u1')?.usage.activePlan).toBe('Starter');
  });

  it('throws away a bad copy already in storage, so a reload recovers', () => {
    for (const data of [{ workspace: { id: 'w1', members: [] }, preferences: {}, usage: null, projects: [] }, { workspace: { id: 'w1', members: [] }, preferences: {}, usage, projects: null }, null]) {
      storage.setItem('dubly.boot.v2.u1', JSON.stringify({ savedAt: Date.now(), data }));
      expect(cache.readBootCache('u1')).toBeNull();
      expect(storage.getItem('dubly.boot.v2.u1')).toBeNull();
    }
  });

  it('counts an empty or partial usage answer as a failure', () => {
    expect(cache.isUsageStats({})).toBe(false);
    expect(cache.isUsageStats(null)).toBe(false);
    expect(cache.isUsageStats(usage)).toBe(true);
    expect(() => cache.assertAnswer({}, cache.isUsageStats)).toThrow();
  });

  it('leaves nothing behind on sign-out', () => {
    cache.writeBootCache('u1', boot());
    cache.clearBootCaches();
    expect(cache.readBootCache('u1')).toBeNull();
  });
});
