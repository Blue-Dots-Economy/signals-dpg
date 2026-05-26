import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { sql, and, eq, min } from 'drizzle-orm';
import { recompute_aggregator_domain_metrics } from './recompute.js';
import { createHash } from 'node:crypto';

export const TTL_SECONDS = Number(
  process.env.DASHBOARD_CACHE_TTL_SECONDS ?? '3600',
);

/**
 * Map (aggregator_id, domain) to a stable signed 63-bit int for
 * pg_advisory_lock (single-arg form). SHA-256 first 8 bytes of
 * "<aggregator_id>:<domain>", top bit masked off to stay positive.
 * Different (org, domain) pairs get different lock keys, so multi-
 * domain aggregators can recompute domains in parallel.
 */
const lock_key_for = (aggregator_id: string, domain: string): bigint => {
  const hash = createHash('sha256').update(`${aggregator_id}:${domain}`).digest();
  return hash.readBigInt64BE(0) & 0x7fffffffffffffffn;
};

export interface StalenessResult {
  refreshed: boolean;
  last_computed_at: Date | null;
}

/**
 * Per-(aggregator, domain) staleness check + recompute under PG advisory
 * lock. Multi-domain orgs hit this in parallel — each (org, domain) has
 * its own lock, so domains don't block each other.
 *
 * Callers: dashboard route (Task 10) + CSV export route (Task 11).
 *
 * When force=true: skips the TTL check (treats as stale) and uses BLOCKING
 * pg_advisory_lock so a concurrent recompute is awaited, not skipped.
 */
export const check_and_refresh_if_stale = async (
  aggregator_id: string,
  domain: string,
  force = false,
): Promise<StalenessResult> => {
  const [row] = await db
    .select({ ts: min(item_metrics.lastComputedAt) })
    .from(item_metrics)
    .where(
      and(
        eq(item_metrics.onboardedByOrgId, aggregator_id),
        eq(item_metrics.itemDomain, domain),
      ),
    );

  const min_ts = (row?.ts as Date | null | undefined) ?? null;
  const stale =
    force ||
    min_ts === null ||
    (Date.now() - min_ts.getTime()) / 1000 > TTL_SECONDS;

  if (!stale) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  const lock_key = lock_key_for(aggregator_id, domain);
  // force=true uses BLOCKING pg_advisory_lock so a concurrent recompute is
  // awaited; non-force uses pg_try_advisory_lock to skip-on-contention.
  const lock_sql = force
    ? sql`SELECT pg_advisory_lock(${lock_key.toString()}::bigint) AS locked`
    : sql`SELECT pg_try_advisory_lock(${lock_key.toString()}::bigint) AS locked`;
  const lockResult: unknown = await db.execute(lock_sql);
  const lock_rows: Array<{ locked?: unknown }> = Array.isArray(lockResult)
    ? (lockResult as Array<{ locked?: unknown }>)
    : ((lockResult as { rows?: Array<{ locked?: unknown }> }).rows ?? []);
  // pg_advisory_lock returns void/true; pg_try_advisory_lock returns boolean.
  const acquired = force ? true : lock_rows[0]?.locked === true;

  if (!acquired) {
    return { refreshed: false, last_computed_at: min_ts };
  }

  try {
    await recompute_aggregator_domain_metrics(aggregator_id, domain);
  } finally {
    await db.execute(
      sql`SELECT pg_advisory_unlock(${lock_key.toString()}::bigint)`,
    );
  }

  const [after] = await db
    .select({ ts: min(item_metrics.lastComputedAt) })
    .from(item_metrics)
    .where(
      and(
        eq(item_metrics.onboardedByOrgId, aggregator_id),
        eq(item_metrics.itemDomain, domain),
      ),
    );

  return {
    refreshed: true,
    last_computed_at: (after?.ts as Date | null | undefined) ?? null,
  };
};
