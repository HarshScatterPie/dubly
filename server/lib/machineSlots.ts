import cluster, { type Worker } from 'node:cluster';
import { freemem } from 'node:os';
import { limits } from './limits';

/**
 * The machine's own budgets, shared by however many server processes it runs: dubs rendering (MAX_ACTIVE_DUBS) and transcriptions or
 * caption renders (MAX_HEAVY_REQUESTS). In a cluster the supervisor (primary.ts) keeps the counts and hands the slots out over IPC, so
 * the budget holds exactly while processes are added and retired; a single process keeps them itself.
 *
 * A slot is also handed out only while the machine has memory to spare (MIN_FREE_MEMORY_MB): past that, work waits for memory as it
 * waits for a slot, so a burst cannot push the machine into swapping or out of memory.
 */
export type SlotKind = 'dub' | 'heavy';
const KINDS: SlotKind[] = ['dub', 'heavy'];
const MB = 1024 * 1024;
// Memory can free up without anything here ending (another program closes), so waiting work is looked at again this often.
const RECHECK_MS = 2000;

let readFreeMemory = () => freemem();
// Test seam: what "free memory" reads, in bytes.
export function setFreeMemoryForTests(fn: (() => number) | null): void {
  readFreeMemory = fn ?? (() => freemem());
}
export const freeMemoryMb = () => readFreeMemory() / MB;

const capacityOf = (kind: SlotKind) => (kind === 'dub' ? limits.maxActiveDubs : limits.maxHeavyRequests);

interface Waiter {
  kind: SlotKind;
  owner: string;
  grant: () => void;
  timer?: NodeJS.Timeout;
}

export class SlotBroker {
  private held: Record<SlotKind, number> = { dub: 0, heavy: 0 };
  private byOwner = new Map<string, Record<SlotKind, number>>();
  private waiters: Waiter[] = [];
  private recheck?: NodeJS.Timeout;

  // Memory for one more piece of work: MIN_FREE_MEMORY_MB, or a quarter of it while nothing at all runs, so a machine short of memory
  // still works through its queue one piece at a time rather than not at all.
  memoryAllows(): boolean {
    const idle = this.held.dub + this.held.heavy === 0;
    return freeMemoryMb() >= (idle ? limits.minFreeMemoryMb / 4 : limits.minFreeMemoryMb);
  }

  private fits(kind: SlotKind): boolean {
    return this.held[kind] < capacityOf(kind) && this.memoryAllows();
  }

  private take(kind: SlotKind, owner: string): void {
    this.held[kind]++;
    const mine = this.byOwner.get(owner) ?? { dub: 0, heavy: 0 };
    mine[kind]++;
    this.byOwner.set(owner, mine);
  }

  /**
   * A slot now if one fits and nobody is waiting for one of this kind; else, with `waitMs` above 0, a place in the queue (first come,
   * first served) until one is granted or the wait runs out. Resolves true when granted. `onQueued` fires if it has to wait.
   */
  acquire(kind: SlotKind, owner: string, waitMs: number, onQueued?: () => void): Promise<boolean> {
    if (!this.waiters.some((w) => w.kind === kind) && this.fits(kind)) {
      this.take(kind, owner);
      return Promise.resolve(true);
    }
    if (waitMs <= 0) return Promise.resolve(false);
    onQueued?.();
    return new Promise((resolve) => {
      const waiter: Waiter = {
        kind,
        owner,
        grant: () => {
          this.take(kind, owner);
          resolve(true);
        },
      };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(false);
      }, waitMs);
      this.waiters.push(waiter);
      this.scheduleRecheck();
    });
  }

  release(kind: SlotKind, owner: string): void {
    const mine = this.byOwner.get(owner);
    if (!mine || mine[kind] <= 0) return;
    mine[kind]--;
    this.held[kind] = Math.max(0, this.held[kind] - 1);
    this.grantWaiting();
  }

  // A process that stopped gives back everything it held, and its place in the queue.
  releaseOwner(owner: string): void {
    const mine = this.byOwner.get(owner);
    if (mine) for (const kind of KINDS) this.held[kind] = Math.max(0, this.held[kind] - mine[kind]);
    this.byOwner.delete(owner);
    this.waiters = this.waiters.filter((w) => {
      if (w.owner !== owner) return true;
      clearTimeout(w.timer);
      return false;
    });
    this.grantWaiting();
  }

  private grantWaiting(): void {
    for (const kind of KINDS) {
      for (let next = this.waiters.find((w) => w.kind === kind); next && this.fits(kind); next = this.waiters.find((w) => w.kind === kind)) {
        const granted = next;
        this.waiters = this.waiters.filter((w) => w !== granted);
        clearTimeout(granted.timer);
        granted.grant();
      }
    }
    this.scheduleRecheck();
  }

  private scheduleRecheck(): void {
    if (this.recheck || this.waiters.length === 0) return;
    this.recheck = setTimeout(() => {
      this.recheck = undefined;
      this.grantWaiting();
    }, RECHECK_MS);
    this.recheck.unref();
  }

  stats(): { dub: number; heavy: number; waiting: number } {
    return { dub: this.held.dub, heavy: this.held.heavy, waiting: this.waiters.length };
  }
}

// --- The process side ---------------------------------------------------------------------------------------------------------

type SlotReply = { type: 'slot-reply'; id: number; granted?: boolean; queued?: boolean };
type SlotRequest = { type: 'slot-acquire'; id: number; kind: SlotKind; waitMs: number } | { type: 'slot-release'; kind: SlotKind };

const inCluster = cluster.isWorker && typeof process.send === 'function';
let local = new SlotBroker();
const pending = new Map<number, { resolve: (granted: boolean) => void; onQueued?: () => void }>();
let nextId = 0;

if (inCluster) {
  process.on('message', (message: SlotReply) => {
    if (message?.type !== 'slot-reply') return;
    const waiting = pending.get(message.id);
    if (!waiting) return;
    if (message.queued) {
      waiting.onQueued?.();
      return;
    }
    pending.delete(message.id);
    waiting.resolve(message.granted === true);
  });
}

function sendToSupervisor(message: SlotRequest): boolean {
  try {
    return process.send!(message);
  } catch {
    // The supervisor is gone (the machine is shutting down): nothing new starts.
    return false;
  }
}

/**
 * A slot of this machine's `kind` budget, or null when none is free within `waitMs` (0: only one free right now). Call the returned
 * function exactly once when the work ends; calling it again does nothing.
 */
export async function acquireSlot(kind: SlotKind, opts: { waitMs?: number; onQueued?: () => void } = {}): Promise<(() => void) | null> {
  const waitMs = opts.waitMs ?? 0;
  // The broker this slot comes from, so it goes back to the same one (tests replace the local broker between runs).
  const broker = local;
  let granted: boolean;
  if (inCluster) {
    const id = ++nextId;
    granted = await new Promise<boolean>((resolve) => {
      pending.set(id, { resolve, onQueued: opts.onQueued });
      if (!sendToSupervisor({ type: 'slot-acquire', id, kind, waitMs })) {
        pending.delete(id);
        resolve(false);
      }
    });
  } else {
    granted = await broker.acquire(kind, 'self', waitMs, opts.onQueued);
  }
  if (!granted) return null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (inCluster) sendToSupervisor({ type: 'slot-release', kind });
    else broker.release(kind, 'self');
  };
}

// --- The supervisor side ------------------------------------------------------------------------------------------------------

/** Answers one process's slot requests from the machine's broker, and takes back what it held when it stops. */
export function serveSlots(broker: SlotBroker, worker: Worker): void {
  const owner = String(worker.id);
  worker.on('message', (message: SlotRequest) => {
    if (message?.type === 'slot-acquire') {
      const reply = (body: Omit<SlotReply, 'type' | 'id'>) => {
        if (worker.isConnected()) worker.send({ type: 'slot-reply', id: message.id, ...body });
      };
      void broker.acquire(message.kind, owner, message.waitMs, () => reply({ queued: true })).then((granted) => reply({ granted }));
    } else if (message?.type === 'slot-release') {
      broker.release(message.kind, owner);
    }
  });
  worker.once('exit', () => broker.releaseOwner(owner));
}

// Test seams: the single-process broker's counts, and a fresh one, so work left hanging by one test holds nothing in the next.
export function localSlotStats(): { dub: number; heavy: number; waiting: number } {
  return local.stats();
}
export function resetSlotsForTests(): void {
  local = new SlotBroker();
}
