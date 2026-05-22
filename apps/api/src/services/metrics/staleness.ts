import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../db/postgres/schema/metrics.js';
import { sql, eq, min } from 'drizzle-orm';
import { recompute_aggregator_metrics } from './recompute.js';
import { createHash } from 'node:crypto';

export const TTL_SECONDS = Number(
  process.env.DASHBOARD_CACHE_TTL_SECONDS ?? '3600',
);

/**
 * Map an arbitrary string aggregator_id to a stable signed 63-bit int
 * for pg_advisory_lock (single-arg form). SHA-256 first 8 bytes, top bit
 * masked off to stay positive.
 */
const lock_key_for = (aggregator_id: string): bigint => {
  const hash = createHash('sha256').update(aggregator_id).digest();
  return hash.readBigInt64BE(0) & 0x7fffffffffffffffn;
};

export interface StalenessResult {
  refreshed: boolean;
  last_computed_at: Date | null;
}

/**
 * Read MIN(last_computed_at) for the aggregator. If older than TTL_SECONDS
 * (or no rows exist), recompute under a PG advisory lock. If the lock is
 * held by another request, return stale data — the in-flight recompute
 * will land within seconds.
 *
 * Callers: dashboard route + CSV export route (Tasks 9-10).
 */
export const check_and_refresh_if_stale = async (
  aggregator_id: string,
): Promise<StalenessResult> => {
  const [row] = await db
    .select({ ts: min(participant_metrics.lastComputedAt) })
    .from(participant_metrics)
    .where(eq(participant_metrics.onboardedByOrgId, aggregator_id));

  const min_ts = (row?.ts as Date | null | undefined) ?? null;
  const stale =
    min_ts === null ||
    (Date.now() - min_ts.getTime()) / 1000 > TTL_SECONDS;

  if (!stale) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  const lock_key = lock_key_for(aggregator_id);

  // pg_try_advisory_lock returns boolean. Non-blocking — if another session
  // holds the lock, return false immediately.
  const lockResult: unknown = await db.execute(
    sql`SELECT pg_try_advisory_lock(${lock_key.toString()}::bigint) AS locked`,
  );
  const rows: Array<{ locked?: unknown }> = Array.isArray(lockResult)
    ? (lockResult as Array<{ locked?: unknown }>)
    : ((lockResult as { rows?: Array<{ locked?: unknown }> }).rows ?? []);
  const locked = rows[0]?.locked === true;

  if (!locked) {
    // Another request is recomputing. Serve stale.
    return { refreshed: false, last_computed_at: min_ts };
  }

  try {
    await recompute_aggregator_metrics(aggregator_id);
  } finally {
    await db.execute(
      sql`SELECT pg_advisory_unlock(${lock_key.toString()}::bigint)`,
    );
  }

  // Re-read MIN after recompute so we return the fresh timestamp.
  const [after] = await db
    .select({ ts: min(participant_metrics.lastComputedAt) })
    .from(participant_metrics)
    .where(eq(participant_metrics.onboardedByOrgId, aggregator_id));

  return {
    refreshed: true,
    last_computed_at: (after?.ts as Date | null | undefined) ?? null,
  };
};
