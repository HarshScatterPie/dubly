import { db } from './firebaseAdmin';
import { log } from './log';

const DAY = 24 * 60 * 60 * 1000;

// Retention for short-lived records (docs/SECURITY.md); each rule deletes at most `batch` documents per hourly run, oldest first.
export const RETENTION = [
  // Share links stop working after 24 h; the record is kept a week so "who shared what" can still be answered.
  { collection: 'shares', field: 'expiresAt', keepMs: 7 * DAY },
  // Invitations expire after 7 days; kept 30 more for the same reason.
  { collection: 'invites', field: 'expiresAt', keepMs: 30 * DAY },
  // Idempotency keys only matter for retries within a day.
  { collection: 'jobIdempotency', field: 'createdAt', keepMs: 2 * DAY },
  // Finished dub jobs are the record of minutes charged and refunded; kept 180 days.
  { collection: 'jobs', field: 'finishedAt', keepMs: 180 * DAY },
] as const;

export async function sweepExpiredRecords(now = Date.now(), batch = 300): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of RETENTION) {
    const cutoff = new Date(now - rule.keepMs).toISOString();
    // Timestamps are ISO strings, which compare correctly as strings; documents with a null field are not matched.
    const snap = await db.collection(rule.collection).where(rule.field, '<', cutoff).orderBy(rule.field).limit(batch).get();
    if (snap.empty) continue;
    const writer = db.bulkWriter();
    snap.docs.forEach((d) => void writer.delete(d.ref));
    await writer.close();
    deleted[rule.collection] = snap.size;
  }
  if (Object.keys(deleted).length) log.info('records_swept', { deleted });
  return deleted;
}
