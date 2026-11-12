import cluster, { type Worker } from 'node:cluster';
import { decideScale, isBusy, isQuiet, type ProcessLoad } from './lib/autoscale';
import { limits } from './lib/limits';
import { installStructuredConsole } from './lib/log';
import { freeMemoryMb, serveSlots, SlotBroker } from './lib/machineSlots';

installStructuredConsole();

/**
 * Supervises the server processes on this machine. It starts MIN_PROCESSES, adds one at a time up to MAX_PROCESSES while they are busy
 * and memory allows, and retires idle ones once they are quiet or memory runs short (autoscale.ts); it replaces one that dies, and passes
 * a shutdown on. It also keeps the machine's dub and heavy-work slots (machineSlots.ts), so those budgets hold however many processes
 * there are. It has no database connection: everything else shared between the processes lives in MongoDB, so any of them can take
 * any request.
 */
const STABLE_AFTER_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;
// Workers get their own grace period (SHUTDOWN_GRACE_MS, see worker.ts) to settle jobs; this only stops a stuck one holding the machine.
const STOP_TIMEOUT_MS = (Number(process.env.SHUTDOWN_GRACE_MS) || 25_000) + 10_000;
const SCALE_EVERY_MS = 5_000;
// Each process reports every 5 s; an older report is from one that is stuck or starting, and is left out of the decision.
const REPORT_FRESH_MS = 15_000;
// A retiring process finishes what it was doing first (it was chosen idle, so normally at once); past this it is stopped like a shutdown.
const RETIRE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Windows otherwise leaves connections to whichever process accepts first, which piles traffic onto one of them.
cluster.schedulingPolicy = cluster.SCHED_RR;

interface Tracked {
  worker: Worker;
  retiring: boolean;
  load?: ProcessLoad & { at: number };
}

const broker = new SlotBroker();
const tracked = new Map<number, Tracked>();
let target = limits.minProcesses;
let stopping = false;
let quickExits = 0;
let lastChangeAt = Date.now();
let busySince: number | null = null;
let quietSince: number | null = null;

const serving = () => [...tracked.values()].filter((t) => !t.retiring);

function start(): void {
  const startedAt = Date.now();
  // A new process works out its share of per-process budgets (ONNX threads) from how many there will be.
  const worker = cluster.fork({ DUBLY_PROCESS_COUNT: String(Math.max(target, serving().length + 1)) });
  const entry: Tracked = { worker, retiring: false };
  tracked.set(worker.id, entry);
  serveSlots(broker, worker);
  worker.on('message', (message: { type?: string; elu?: number; lagMs?: number; busy?: number }) => {
    if (message?.type !== 'load') return;
    entry.load = { id: worker.id, elu: Number(message.elu) || 0, lagMs: Number(message.lagMs) || 0, busy: Number(message.busy) || 0, at: Date.now() };
  });
  worker.once('exit', (code, signal) => {
    tracked.delete(worker.id);
    if (stopping) {
      if (tracked.size === 0) process.exit(0);
      return;
    }
    if (entry.retiring) {
      console.log(`[primary] process ${worker.process.pid} retired; ${serving().length} serving`);
      return;
    }
    // A crash loop (a bad deploy, the database down) backs off instead of spinning; a process that ran for a while restarts straight away.
    quickExits = Date.now() - startedAt >= STABLE_AFTER_MS ? 0 : quickExits + 1;
    const delay = Math.min(MAX_RESTART_DELAY_MS, 500 * 2 ** quickExits);
    console.error(`[primary] process ${worker.process.pid} stopped (${signal ?? code}); starting another in ${delay}ms`);
    setTimeout(() => {
      if (!stopping && serving().length < target) start();
    }, delay);
  });
}

// Stops taking requests and dubs, finishes what it has, then exits (worker.ts); its slots come back when it does.
function retire(id: number): void {
  const entry = tracked.get(id);
  if (!entry || entry.retiring) return;
  entry.retiring = true;
  entry.worker.send({ type: 'retire' });
  setTimeout(() => {
    if (tracked.has(id) && entry.worker.isConnected()) entry.worker.send({ type: 'shutdown' });
  }, RETIRE_TIMEOUT_MS).unref();
}

function scale(): void {
  if (stopping) return;
  const now = Date.now();
  const loads = serving()
    .map((t) => t.load)
    .filter((load): load is ProcessLoad & { at: number } => load !== undefined && now - load.at <= REPORT_FRESH_MS);
  busySince = isBusy(loads) ? busySince ?? now : null;
  quietSince = isQuiet(loads) ? quietSince ?? now : null;
  const count = serving().length;
  const freeMb = freeMemoryMb();
  const decision = decideScale({
    now,
    count,
    min: limits.minProcesses,
    max: limits.maxProcesses,
    freeMb,
    minFreeMb: limits.minFreeMemoryMb,
    processMb: limits.processMemoryMb,
    loads,
    lastChangeAt,
    busySince,
    quietSince,
  });
  if (decision.action === 'up') {
    target = count + 1;
    lastChangeAt = now;
    busySince = null;
    console.log(`[primary] processes are busy: adding one (${target} of at most ${limits.maxProcesses}, ${Math.round(freeMb)} MB free)`);
    start();
  } else if (decision.action === 'down') {
    target = Math.max(limits.minProcesses, count - 1);
    lastChangeAt = now;
    quietSince = null;
    const why = freeMb < limits.minFreeMemoryMb / 2 ? `memory is short (${Math.round(freeMb)} MB free)` : 'processes are quiet';
    console.log(`[primary] ${why}: retiring an idle one (${target} left, at least ${limits.minProcesses})`);
    retire(decision.id);
  }
}

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.warn(`[primary] ${signal}: stopping ${tracked.size} process(es)`);
  // A message rather than a signal: on Windows a signal ends the process on the spot, before it can settle its jobs.
  const workers = [...tracked.values()].map((t) => t.worker);
  if (workers.length === 0) process.exit(0);
  for (const worker of workers) if (worker.isConnected()) worker.send({ type: 'shutdown' });
  setTimeout(() => process.exit(1), STOP_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

const scaling = limits.maxProcesses > limits.minProcesses;
console.log(
  scaling
    ? `[primary] starting ${limits.minProcesses} server processes, scaling up to ${limits.maxProcesses} with the load`
    : `[primary] starting ${limits.minProcesses} server processes`
);
for (let i = 0; i < limits.minProcesses; i++) start();
if (scaling) setInterval(scale, SCALE_EVERY_MS).unref();
