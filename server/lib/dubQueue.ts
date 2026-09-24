import { limits } from './limits';

/**
 * In-process admission for dub runs: at most `limits.maxDubsPerWorkspace` per workspace and `limits.maxActiveDubs` in total
 * render at once, first come first served; the rest wait here. The queue itself is memory only; the jobs are persisted with
 * status `queued`, so after a restart the new process picks up whatever was still waiting (see requeue in server/index.ts).
 */
interface Entry {
  jobId: string;
  workspaceId: string;
  start: () => Promise<void>;
  abandon: () => void;
}

const waiting: Entry[] = [];
const runningByWorkspace = new Map<string, number>();
let running = 0;
let frozen = false;

export function enqueueDub(entry: Entry): { startedImmediately: boolean } {
  waiting.push(entry);
  pump();
  return { startedImmediately: !waiting.includes(entry) };
}

function pump(): void {
  if (frozen) return;
  for (let i = 0; i < waiting.length && running < limits.maxActiveDubs; ) {
    const entry = waiting[i];
    const inWorkspace = runningByWorkspace.get(entry.workspaceId) ?? 0;
    if (inWorkspace >= limits.maxDubsPerWorkspace) {
      i++;
      continue;
    }
    waiting.splice(i, 1);
    running++;
    runningByWorkspace.set(entry.workspaceId, inWorkspace + 1);
    void entry
      .start()
      .catch((err) => console.error(`[queue] dub ${entry.jobId} crashed outside its own error handling`, err))
      .finally(() => {
        running = Math.max(0, running - 1);
        const left = (runningByWorkspace.get(entry.workspaceId) ?? 1) - 1;
        if (left > 0) runningByWorkspace.set(entry.workspaceId, left);
        else runningByWorkspace.delete(entry.workspaceId);
        pump();
      });
  }
}

// How many dubs of the same workspace are ahead of this one (0 when it is next or running).
export function positionInQueue(jobId: string): number {
  const entry = waiting.find((e) => e.jobId === jobId);
  if (!entry) return 0;
  return waiting.filter((e) => e.workspaceId === entry.workspaceId).indexOf(entry);
}

export function queueStats(): { running: number; waiting: number } {
  return { running, waiting: waiting.length };
}

// Shutdown: nothing new starts, and waiting jobs are released untouched so the next process can pick them up.
export function freezeQueue(): number {
  frozen = true;
  const released = waiting.splice(0, waiting.length);
  released.forEach((e) => e.abandon());
  return released.length;
}

export function resetQueueForTests(): void {
  frozen = false;
  waiting.splice(0, waiting.length);
  runningByWorkspace.clear();
  running = 0;
}
