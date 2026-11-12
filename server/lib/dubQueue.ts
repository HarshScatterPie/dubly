import { limits } from './limits';
import { claimNextDubJob, type DubJob } from './jobs';
import { acquireSlot, resetSlotsForTests } from './machineSlots';

/**
 * Dub admission. Waiting dubs live in the database, not in a process, so whichever process has room takes the oldest one: a burst that
 * lands on one process spreads over all of them, and a restart loses nothing. A dub starts only with one of the machine's dub slots
 * (machineSlots.ts: MAX_ACTIVE_DUBS on the machine, and memory to spare), whichever of its processes asks; the per-workspace cap holds
 * across every process and machine (claimNextDubJob). A dub that cannot start waits in the queue, however long that takes.
 */
const DISPATCH_EVERY_MS = 3_000;

let runner: ((job: DubJob) => Promise<void>) | null = null;
let running = 0;
let frozen = false;
let pumping: Promise<void> | null = null;
let again = false;
let dispatcher: NodeJS.Timeout | undefined;

export function setDubRunner(run: (job: DubJob) => Promise<void>): void {
  runner = run;
}

async function pump(): Promise<void> {
  do {
    again = false;
    try {
      while (!frozen && runner) {
        // The slot first: a dub claimed without one could not be handed back to the queue.
        const release = await acquireSlot('dub');
        if (!release) break;
        let job: DubJob | null;
        try {
          job = await claimNextDubJob(limits.maxDubsPerWorkspace);
        } catch (err) {
          release();
          throw err;
        }
        if (!job) {
          release();
          break;
        }
        const claimed = job;
        running++;
        void runner(claimed)
          .catch((err) => console.error(`[queue] dub ${claimed.id} crashed outside its own error handling`, err))
          .finally(() => {
            running = Math.max(0, running - 1);
            release();
            void wakeDubQueue();
          });
      }
    } catch (err) {
      // The next tick tries again; a database blip must not stop admission for good.
      console.error('[queue] could not admit dubs', err);
    }
  } while (again);
}

// Admits whatever fits now. Never rejects; resolves once this process has taken what it can.
export function wakeDubQueue(): Promise<void> {
  if (pumping) {
    again = true;
    return pumping;
  }
  pumping = pump().finally(() => {
    pumping = null;
  });
  return pumping;
}

// Picks up dubs queued by other processes, and any left waiting when a process stopped.
export function startDubDispatcher(): void {
  dispatcher = setInterval(() => void wakeDubQueue(), DISPATCH_EVERY_MS);
  dispatcher.unref();
  void wakeDubQueue();
}

export function dubsRunningHere(): number {
  return running;
}

// Shutdown: nothing new starts here. Waiting dubs stay in the database for the other processes, or the next one.
export function freezeQueue(): void {
  frozen = true;
  clearInterval(dispatcher);
}

export function resetQueueForTests(): void {
  frozen = false;
  running = 0;
  again = false;
  clearInterval(dispatcher);
  resetSlotsForTests();
}
