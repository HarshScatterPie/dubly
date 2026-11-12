import { limits } from './limits';
import { col, isDuplicateKeyError } from './mongo';
import { log } from './log';

// Two first calls for a model racing to create its document: the loser simply goes again, against the one that won.
async function retryingRace<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isDuplicateKeyError(err) || attempt >= 3) throw err;
    }
  }
}

/**
 * A queue in front of every AI model, shared by every process and machine through MongoDB.
 *
 * - A model with a known quota (requests per minute) is paced: each call takes the next turn, one interval (60 s / RPM) after the
 *   one before, in one atomic step, and waits until its turn comes. So Dubly never sends a model more than its quota, however many
 *   dubs and processes are calling it, and calls past it wait in arrival order instead of failing or going to a dearer model.
 * - When the provider still answers "out of quota" (its quota is shared with something else, or set lower than configured), the
 *   model is paused for everyone (AI_QUOTA_PAUSE_SECONDS) and the call waits it out with the rest, rather than each process finding
 *   out by failing on its own.
 * - A call that would wait longer than it may (a voice preview someone is watching, or a job past AI_QUEUE_MAX_WAIT_MINUTES) gets
 *   AiBusyError straight away, and its turn goes back to the queue.
 *
 * One document per model in `aiPace`: `nextAt` is when the next turn starts, `pausedUntil` the end of a pause. Models without a
 * configured quota are not paced, only paused.
 */

export class AiBusyError extends Error {
  constructor(
    public model: string,
    public waitMs: number
  ) {
    super(`The AI model ${model} is busy (the next free turn is in about ${Math.ceil(waitMs / 1000)} s). Please try again in a few minutes.`);
  }
}

interface PaceDoc {
  _id: string;
  nextAt?: number;
  pausedUntil?: number;
  lastStart?: number;
}

const paces = () => col<PaceDoc>('aiPace');

// Requests per minute for models whose quota is known: measured 2026-09-29, Gemini 2.5 Flash TTS on Cloud TTS allows about 10 for
// this project. Everything else is unpaced until configured. AI_MODEL_RPM replaces this list: "model=rpm,model=rpm" (empty: pace none).
const DEFAULT_RPM: Record<string, number> = { 'gemini-2.5-flash-tts': 10 };

function parseRpm(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of text.split(',')) {
    const [model, value] = pair.split('=').map((s) => s?.trim());
    const rpm = Number(value);
    if (model && Number.isFinite(rpm) && rpm > 0) out[model] = rpm;
  }
  return out;
}

let rpmTable: Record<string, number> = process.env.AI_MODEL_RPM !== undefined ? parseRpm(process.env.AI_MODEL_RPM) : DEFAULT_RPM;

export function rpmFor(model: string): number | null {
  return rpmTable[model] ?? null;
}

// Test seam.
export function setModelRpmForTests(table: Record<string, number> | null): void {
  rpmTable = table ?? (process.env.AI_MODEL_RPM !== undefined ? parseRpm(process.env.AI_MODEL_RPM) : DEFAULT_RPM);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// How long a call to `model` would wait if it asked now, without taking a turn.
async function expectedWait(model: string, intervalMs: number, now: number): Promise<number> {
  const doc = await paces().findOne({ _id: model });
  return Math.max(0, (intervalMs ? doc?.nextAt ?? 0 : 0) - now, (doc?.pausedUntil ?? 0) - now);
}

/**
 * Waits for `model`'s next turn. `maxWaitMs`: the longest the caller may wait (default AI_QUEUE_MAX_WAIT_MINUTES); past it, AiBusyError
 * without waiting. `onWait` fires once if the call has to wait at all, e.g. to tell the person why it is slow.
 */
export async function takeTurn(model: string, opts: { maxWaitMs?: number; onWait?: (waitMs: number) => void } = {}): Promise<void> {
  const maxWaitMs = opts.maxWaitMs ?? limits.aiQueueMaxWaitMs;
  const rpm = rpmFor(model);
  const intervalMs = rpm ? 60_000 / rpm : 0;
  const now = Date.now();

  // Looked at first, so a call that could not wait anyway takes nobody's turn.
  const ahead = await expectedWait(model, intervalMs, now);
  if (ahead > maxWaitMs) throw new AiBusyError(model, ahead);

  if (!intervalMs) {
    // Unpaced: only a pause holds it up.
    if (ahead > 0) {
      opts.onWait?.(ahead);
      await sleep(ahead);
    }
    return;
  }

  // The turn: starts at the latest of now, the queue's next free turn and the end of any pause; the next one is an interval after it.
  const doc = await retryingRace(() =>
    paces().findOneAndUpdate(
      { _id: model },
      [
        { $set: { lastStart: { $max: [now, { $ifNull: ['$nextAt', 0] }, { $ifNull: ['$pausedUntil', 0] }] } } },
        { $set: { nextAt: { $add: ['$lastStart', intervalMs] } } },
      ],
      { upsert: true, returnDocument: 'after' }
    )
  );
  const start = doc!.lastStart!;
  const wait = start - now;
  if (wait > maxWaitMs) {
    // Others joined the queue in the meantime: hand the turn back if nobody has queued behind it, and give up.
    await paces().updateOne({ _id: model, nextAt: doc!.nextAt }, { $inc: { nextAt: -intervalMs } });
    throw new AiBusyError(model, wait);
  }
  if (wait > 0) {
    opts.onWait?.(wait);
    await sleep(wait);
  }
}

/** The provider said `model` is out of quota: everyone waits for it, from now until the pause ends. */
export async function reportQuotaHit(model: string, pauseMs = limits.aiQuotaPauseMs): Promise<void> {
  const until = Date.now() + pauseMs;
  await retryingRace(() => paces().updateOne({ _id: model }, { $max: { pausedUntil: until } }, { upsert: true }));
  log.warn('ai_model_paused', { model, pauseMs }, `[ai] ${model} is out of quota; calls to it wait ${Math.round(pauseMs / 1000)} s`);
}

/** Whether `model` is paused for quota right now, and for how much longer (0 when it is not). */
export async function pausedFor(model: string): Promise<number> {
  const doc = await paces().findOne({ _id: model }, { projection: { pausedUntil: 1 } });
  return Math.max(0, (doc?.pausedUntil ?? 0) - Date.now());
}

// gRPC RESOURCE_EXHAUSTED (Cloud TTS), HTTP 429 (Vertex, the Gemini API), or the same said in words. Not any mention of "quota":
// a setup error such as "requires a quota project" must fail at once, not wait half an hour.
export function isQuotaError(err: unknown): boolean {
  const candidate = err as { code?: unknown; status?: unknown; message?: unknown };
  return (
    candidate?.code === 8 ||
    candidate?.status === 429 ||
    /RESOURCE_EXHAUSTED|quota exceeded|exceeded .*quota|rate limit exceeded|too many requests/i.test(String(candidate?.message ?? err))
  );
}
