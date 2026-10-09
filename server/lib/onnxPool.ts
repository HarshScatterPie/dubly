import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { log } from './log';

/**
 * ONNX Runtime's Node backend runs each inference synchronously on the thread that calls it, so on the main thread every video
 * frame or audio window freezes the event loop for all other requests (a load test measured it at 47% of the main thread's
 * busy time, with health and progress polls taking 12 to 23 s). The face scan and the voice-activity pass therefore run in
 * worker threads; the main thread only posts a small message and awaits the answer.
 *
 * Workers start on demand (a second only when the first is busy), and exit after a quiet spell to give their memory back.
 * If a worker cannot start or dies, the task runs in-process as it always did, so this can only make things better.
 * ONNX_WORKERS caps the pool (default: 2, or fewer cores); ONNX_WORKERS=0 turns it off.
 */
export type OffThreadTask = 'faceScan' | 'vad';

const IDLE_EXIT_MS = 5 * 60_000;
// A worker that fails to run even one task this many times in a row is given up on for the life of the process.
const MAX_CONSECUTIVE_CRASHES = 3;

class WorkerCrashed extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
  idleTimer?: NodeJS.Timeout;
}

const configured = process.env.ONNX_WORKERS;
const maxWorkers = Math.max(1, Number(configured) || Math.min(2, availableParallelism()));
// Tests run the tasks in-process: the worker needs the TypeScript loader that only the server's own start-up provides.
let disabled = configured === '0' || Boolean(process.env.VITEST);
let consecutiveCrashes = 0;
let nextId = 1;
const slots: Slot[] = [];

function retire(slot: Slot, reason: Error): void {
  const at = slots.indexOf(slot);
  if (at >= 0) slots.splice(at, 1);
  clearTimeout(slot.idleTimer);
  for (const pending of slot.pending.values()) pending.reject(reason);
  slot.pending.clear();
}

function armIdleExit(slot: Slot): void {
  clearTimeout(slot.idleTimer);
  if (slot.pending.size > 0) return;
  slot.idleTimer = setTimeout(() => {
    retire(slot, new WorkerCrashed('ONNX worker retired while idle'));
    void slot.worker.terminate();
  }, IDLE_EXIT_MS);
  slot.idleTimer.unref();
}

function startWorker(): Slot {
  // The stub brings its own TypeScript loader, so the parent's flags (--inspect, --watch, --input-type...) are not passed down.
  const worker = new Worker(new URL('./onnxWorker.mjs', import.meta.url), { execArgv: [] });
  // Never keeps the process alive on its own; the HTTP server does that.
  worker.unref();
  const slot: Slot = { worker, pending: new Map() };
  worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const pending = slot.pending.get(message.id);
    if (!pending) return;
    slot.pending.delete(message.id);
    consecutiveCrashes = 0;
    armIdleExit(slot);
    if (message.error !== undefined) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
  worker.on('error', (err) => retire(slot, new WorkerCrashed(`ONNX worker failed: ${err.message}`)));
  worker.on('exit', (code) => retire(slot, new WorkerCrashed(`ONNX worker exited (${code})`)));
  slots.push(slot);
  return slot;
}

// The least busy worker, with a new one started when every worker is already occupied and there is room for another.
function pickSlot(): Slot {
  let best: Slot | undefined;
  for (const slot of slots) if (!best || slot.pending.size < best.pending.size) best = slot;
  if (!best || (best.pending.size > 0 && slots.length < maxWorkers)) return startWorker();
  return best;
}

function post<T>(task: OffThreadTask, args: unknown): Promise<T> {
  const slot = pickSlot();
  clearTimeout(slot.idleTimer);
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    slot.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      slot.worker.postMessage({ id, task, args });
    } catch (err) {
      slot.pending.delete(id);
      reject(new WorkerCrashed(`ONNX worker did not accept the task: ${(err as Error).message}`));
    }
  });
}

/** Runs `task` in a worker thread; `inline` is the same work in this thread, used when workers are off or broken. */
export async function runOffThread<T>(task: OffThreadTask, args: unknown, inline: () => Promise<T>): Promise<T> {
  if (disabled) return inline();
  try {
    return await post<T>(task, args);
  } catch (err) {
    // An error the task itself raised is the caller's to handle; only a broken worker falls back to running here.
    if (!(err instanceof WorkerCrashed)) throw err;
    log.warn('onnx_worker_crashed', { task, error: err.message }, `[onnx] ${err.message}; running this ${task} in-process`);
    if (++consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES) {
      disabled = true;
      log.warn('onnx_workers_disabled', {}, '[onnx] workers keep failing; running inference in-process from now on');
    }
    return inline();
  }
}
