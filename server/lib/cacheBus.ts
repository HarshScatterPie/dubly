import { randomUUID } from 'node:crypto';
import type { ChangeStream } from 'mongodb';
import { col } from './mongo';

/**
 * Keeps the in-memory caches of several server processes honest. A cache entry is cleared at once in the process that changed the
 * record; here the same clearing reaches every other process too, through a MongoDB change stream, so a sign-out or a re-rendered
 * file takes effect everywhere within moments rather than when entries age out. One process has nobody to tell, so nothing runs.
 */
interface CacheEvent {
  channel: string;
  // Null clears the whole channel.
  key: string | null;
  from: string;
  at: Date;
}

type Clear = (key: string | null) => void;

const RECONNECT_MS = 5_000;
const processId = randomUUID();
const channels = new Map<string, Clear>();
const events = () => col<CacheEvent>('cacheEvents');

let stream: ChangeStream<CacheEvent> | null = null;
let running = false;
let reconnect: NodeJS.Timeout | undefined;

export function clearAllCaches(): void {
  for (const clear of channels.values()) clear(null);
}

/** Registers a cache: clears the key here and in every other process. `clear(null)` must empty the whole cache. */
export function sharedInvalidator(channel: string, clear: Clear): (key: string | null) => void {
  channels.set(channel, clear);
  return (key) => {
    clear(key);
    if (running) void events().insertOne({ channel, key, from: processId, at: new Date() }).catch((err) => console.error('[cacheBus] could not publish', err));
  };
}

function listen(): void {
  stream = events().watch<CacheEvent>([{ $match: { operationType: 'insert' } }]);
  stream.on('change', (change) => {
    if (change.operationType !== 'insert') return;
    const { channel, key, from } = change.fullDocument;
    if (from !== processId) channels.get(channel)?.(key);
  });
  stream.on('error', (err) => {
    console.error('[cacheBus] change stream failed; reconnecting', err);
    void stream?.close().catch(() => undefined);
    stream = null;
    if (!running) return;
    // Events during the gap are lost, so nothing cached before it can be trusted.
    clearAllCaches();
    reconnect = setTimeout(listen, RECONNECT_MS);
    reconnect.unref();
  });
}

export function startCacheBus(): void {
  if (running) return;
  running = true;
  listen();
}

export async function stopCacheBus(): Promise<void> {
  running = false;
  clearTimeout(reconnect);
  await stream?.close().catch(() => undefined);
  stream = null;
}
