import { col, type CollectionName } from './mongo';
import { log } from './log';

const DAY = 24 * 60 * 60 * 1000;

// Retention for short-lived records (docs/SECURITY.md); each rule deletes at most `batch` records per hourly run, oldest first.
// Sessions and one-time email tokens need no rule here: MongoDB's TTL indexes remove them when they expire (see mongo.ts).
export const RETENTION: { collection: CollectionName; field: string; keepMs: number }[] = [
  // Share links stop working after 24 h; the record is kept a week so "who shared what" can still be answered.
  { collection: 'shares', field: 'expiresAt', keepMs: 7 * DAY },
  // Invitations expire after 7 days; kept 30 more for the same reason.
  { collection: 'invites', field: 'expiresAt', keepMs: 30 * DAY },
  // Idempotency keys only matter for retries within a day.
  { collection: 'jobIdempotency', field: 'createdAt', keepMs: 2 * DAY },
  // Finished dub jobs are the record of minutes charged and refunded; kept 180 days.
  { collection: 'jobs', field: 'finishedAt', keepMs: 180 * DAY },
];

export async function sweepExpiredRecords(now = Date.now(), batch = 300): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of RETENTION) {
    const cutoff = new Date(now - rule.keepMs).toISOString();
    // Timestamps are ISO strings, which compare correctly as strings; a null or missing field is not matched.
    const ids = (
      await col<{ _id: string }>(rule.collection)
        .find({ [rule.field]: { $lt: cutoff, $type: 'string' } }, { projection: { _id: 1 } })
        .sort({ [rule.field]: 1 })
        .limit(batch)
        .toArray()
    ).map((d) => d._id);
    if (!ids.length) continue;
    const result = await col<{ _id: string }>(rule.collection).deleteMany({ _id: { $in: ids } });
    deleted[rule.collection] = result.deletedCount;
  }
  if (Object.keys(deleted).length) log.info('records_swept', { deleted });
  return deleted;
}
