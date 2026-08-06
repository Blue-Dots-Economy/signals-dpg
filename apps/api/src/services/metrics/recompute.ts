import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { profile_completion_pct } from './profile_completion.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_item_schema } from './schema_lookup.js';
import { collect_tracked_interactions, type MetricCategoriesMap } from './metric_categories.js';
import { evaluate_status_rules, type StatusRule } from './evaluate_status_rules.js';
import { resolve_display_name } from './resolve_display_name.js';
import { CANONICAL_BUCKETS, type CanonicalBucket, type CanonicalStatus } from './buckets.js';
import { getNetworkConfigById } from '@/network_configs';

const BATCH_SIZE = 1000;
const MS_PER_DAY = 86_400_000;

const to_date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  throw new TypeError(`to_date: unexpected ${typeof v}`);
};

const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

export interface RecomputeResult {
  processed: number;
  duration_ms: number;
}

/** Both action directions, in payload order. */
const DIRECTIONS = ['initiated', 'received'] as const;
type Direction = (typeof DIRECTIONS)[number];

/** SQL column alias for a (direction, bucket) count, e.g. `initiated_create`. */
const count_col = (d: Direction, b: CanonicalBucket): string => `${d}_${b}`;
/** SQL column alias for a (direction, bucket) MAX timestamp. */
const last_col = (d: Direction, b: CanonicalBucket): string => `last_${d}_${b}_at`;

interface AggregatedRow extends Record<string, unknown> {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  lifecycle_status: string;
  owner_user_id: string;
  onboarded_by_org_id: string | null;
  onboarded_via: string | null;
  item_state: Record<string, unknown> | null;
  profile_created_at: Date | string | null;
  profile_last_updated_at: Date | string | null;
  // initiated_<bucket> / received_<bucket> counts + last_<direction>_<bucket>_at
  // timestamps are accessed dynamically via count_col() / last_col().
}

/**
 * Build a UNION ALL of per-(direction,bucket) event SELECTs for every tracked
 * interaction in the network. Each SELECT emits (item_id, direction, bucket,
 * created_at) rows that the outer GROUP BY in the main CTE buckets into
 * per-item directional counts and MAX timestamps.
 *
 * Directional: when an item's domain participates as the SOURCE of an
 * interaction (e.g. seeker→provider connect), the seeker's item_id is
 * source_item_id and the event is `initiated`. When it participates as TARGET
 * (e.g. provider→seeker connect for the seeker domain), the seeker's item_id
 * is target_item_id and the event is `received`. A self-domain interaction
 * (from_domain === to_domain === domain) emits BOTH an initiated and a
 * received row for the same action, since the same item plays both roles.
 */
const buildInteractionEvents = (
  tracked: Array<{ actionType: string; fromDomain: string; toDomain: string; categories: MetricCategoriesMap }>,
  domain: string,
): import('drizzle-orm').SQL | null => {
  const pieces: import('drizzle-orm').SQL[] = [];

  const emit = (
    t: { actionType: string; fromDomain: string; toDomain: string; categories: MetricCategoriesMap },
    idCol: import('drizzle-orm').SQL,
    direction: Direction,
  ) => {
    for (const bucket of CANONICAL_BUCKETS) {
      const statuses = t.categories[bucket];
      if (statuses.length === 0) continue;
      const list = sql.join(statuses.map((s) => sql`${s}`), sql`, `);
      pieces.push(sql`
        SELECT
          ${idCol} AS item_id,
          ${direction} AS direction,
          ${bucket} AS bucket,
          created_at
        FROM item_actions
        WHERE action_type = ${t.actionType}
          AND source_item_domain = ${t.fromDomain}
          AND target_item_domain = ${t.toDomain}
          AND action_status IN (${list})
          AND ${idCol} IS NOT NULL
      `);
    }
  };

  for (const t of tracked) {
    if (t.fromDomain === domain) emit(t, sql`source_item_id`, 'initiated');
    if (t.toDomain === domain) emit(t, sql`target_item_id`, 'received');
  }

  if (pieces.length === 0) return null;
  return sql.join(pieces, sql` UNION ALL `);
};

/**
 * Recomputes item_metrics for all items owned by users onboarded by the
 * given aggregator within the given domain. Directional: aggregates actions
 * into initiated (item-as-source) and received (item-as-target) maps, per the
 * tracked-interactions collected from the network config. Per-item status is
 * evaluated against the domain's status_rules using COMBINED (initiated +
 * received) counts, preserving the historical status semantics.
 */
export const recompute_aggregator_domain_metrics = async (
  aggregator_id: string,
  domain: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const now = new Date();

  // Discover the network for this (aggregator, domain) via a one-row sample.
  // All items in a (aggregator, domain) share a network in our data model.
  const sample = await db.execute<{ item_network: string }>(sql`
    SELECT i.item_network
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain}
    LIMIT 1
  `);
  const sampleRows: Array<{ item_network: string }> = Array.isArray(sample)
    ? (sample as Array<{ item_network: string }>)
    : ((sample as { rows?: Array<{ item_network: string }> }).rows ?? []);
  if (sampleRows.length === 0) {
    return { processed: 0, duration_ms: Date.now() - started };
  }
  const network = sampleRows[0].item_network;

  const networkConfig = await getNetworkConfigById(network);
  const tracked = collect_tracked_interactions(networkConfig);
  const eventsCte = buildInteractionEvents(tracked, domain);

  // Resolve status_rules for this domain.
  const domainCfg = networkConfig.domains.find((d) => d.id === domain);
  if (!domainCfg) {
    throw new Error(
      `recompute: domain "${domain}" not found in network "${network}" config`,
    );
  }
  const status_rules = domainCfg.status_rules as StatusRule[] | undefined;
  if (!status_rules || status_rules.length === 0) {
    throw new Error(
      `recompute: network "${network}" domain "${domain}" has no status_rules — add per spec`,
    );
  }

  // The per-(direction,bucket) count + MAX-timestamp projections shared by both
  // the populated and the empty CTE branch.
  const countSelects = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map(
        (b) => sql`COUNT(*) FILTER (WHERE direction = ${d} AND bucket = ${b})::int AS ${sql.raw(count_col(d, b))}`,
      ),
    ),
    sql`, `,
  );
  const lastSelects = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map(
        (b) => sql`MAX(created_at) FILTER (WHERE direction = ${d} AND bucket = ${b}) AS ${sql.raw(last_col(d, b))}`,
      ),
    ),
    sql`, `,
  );
  const emptyCountCols = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map((b) => sql`0::int AS ${sql.raw(count_col(d, b))}`),
    ),
    sql`, `,
  );
  const emptyLastCols = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map((b) => sql`NULL::timestamp AS ${sql.raw(last_col(d, b))}`),
    ),
    sql`, `,
  );

  // Main query: aggregate events into per-item directional bucket
  // counts/timestamps, join to items + user attribution. Empty `eventsCte`
  // (no tracked interactions touch this domain) → action_counts is an empty
  // CTE so every join yields 0 counts via COALESCE.
  const actionCountsCte = eventsCte
    ? sql`
        WITH ev AS (${eventsCte}),
        action_counts AS (
          SELECT
            item_id,
            ${countSelects},
            ${lastSelects}
          FROM ev
          GROUP BY item_id
        )
      `
    : sql`
        WITH action_counts AS (
          SELECT
            NULL::uuid AS item_id,
            ${emptyCountCols},
            ${emptyLastCols}
          WHERE FALSE
        )
      `;

  // Projected count/last columns for the main SELECT — COALESCE counts to 0,
  // pass timestamps through (NULL when the bucket never occurred).
  const projectedCounts = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map(
        (b) => sql`COALESCE(ac.${sql.raw(count_col(d, b))}, 0) AS ${sql.raw(count_col(d, b))}`,
      ),
    ),
    sql`, `,
  );
  const projectedLast = sql.join(
    DIRECTIONS.flatMap((d) =>
      CANONICAL_BUCKETS.map((b) => sql`ac.${sql.raw(last_col(d, b))}`),
    ),
    sql`, `,
  );

  const result = await db.execute<AggregatedRow>(sql`
    ${actionCountsCte}
    SELECT
      i.item_id            AS item_id,
      i.item_network       AS item_network,
      i.item_domain        AS item_domain,
      i.item_type          AS item_type,
      i.lifecycle_status   AS lifecycle_status,
      i.created_by         AS owner_user_id,
      u.onboarded_by_org_id AS onboarded_by_org_id,
      u.onboarded_via      AS onboarded_via,
      i.item_state         AS item_state,
      i.created_at         AS profile_created_at,
      i.updated_at         AS profile_last_updated_at,
      ${projectedCounts},
      ${projectedLast}
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    LEFT JOIN action_counts ac ON ac.item_id = i.item_id
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain};
  `);
  const rows: AggregatedRow[] = Array.isArray(result)
    ? (result as AggregatedRow[])
    : ((result as { rows?: AggregatedRow[] }).rows ?? []);

  let processed = 0;
  let buffer: Array<typeof item_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = (r.item_state ?? {}) as Record<string, unknown>;
    const profile_created = to_date(r.profile_created_at) ?? now;
    const profile_updated = to_date(r.profile_last_updated_at) ?? profile_created;

    const schema = await get_item_schema(r.item_network, r.item_domain, r.item_type);

    const age_days = days_between(profile_created, now);

    // Per-direction full count maps + per-direction last-Date maps.
    const counts: Record<Direction, Record<CanonicalBucket, number>> = {
      initiated: { create: 0, accept: 0, reject: 0, cancel: 0 },
      received: { create: 0, accept: 0, reject: 0, cancel: 0 },
    };
    const lastDates: Record<Direction, Record<CanonicalBucket, Date | null>> = {
      initiated: { create: null, accept: null, reject: null, cancel: null },
      received: { create: null, accept: null, reject: null, cancel: null },
    };
    for (const d of DIRECTIONS) {
      for (const b of CANONICAL_BUCKETS) {
        counts[d][b] = Number(r[count_col(d, b)] ?? 0);
        lastDates[d][b] = to_date(r[last_col(d, b)]);
      }
    }

    // Sparse last-at maps: only buckets with a timestamp (omit absent).
    const sparse_last = (dir: Direction): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const b of CANONICAL_BUCKETS) {
        const dt = lastDates[dir][b];
        if (dt !== null) out[b] = dt.toISOString();
      }
      return out;
    };

    // Status DSL is fed COMBINED counts + the most-recent timestamp across
    // both directions per bucket, preserving the pre-directional semantics.
    const dsl_input = {
      item_age_days: age_days,
      count: Object.fromEntries(
        CANONICAL_BUCKETS.map((b) => [b, counts.initiated[b] + counts.received[b]]),
      ) as Record<CanonicalBucket, number>,
      days_since_last: Object.fromEntries(
        CANONICAL_BUCKETS.map((b) => {
          const candidates = [lastDates.initiated[b], lastDates.received[b]]
            .filter((d): d is Date => d !== null)
            .map((d) => days_between(d, now));
          return [b, candidates.length === 0 ? null : Math.min(...candidates)];
        }),
      ) as Record<CanonicalBucket, number | null>,
    };

    const profileStatus: CanonicalStatus = evaluate_status_rules(status_rules, dsl_input);

    const displayName = resolve_display_name({
      schema: schema as { display_name_field?: string; properties?: Record<string, unknown> },
      item_state: payload,
      item_id: r.item_id,
    });

    buffer.push({
      itemId: r.item_id,
      itemNetwork: r.item_network,
      itemDomain: r.item_domain,
      itemType: r.item_type,
      lifecycleStatus: r.lifecycle_status,
      ownerUserId: r.owner_user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      displayName,
      profileStatus,
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: age_days,
      initiated: counts.initiated,
      received: counts.received,
      lastInitiatedAt: sparse_last('initiated'),
      lastReceivedAt: sparse_last('received'),
      actionableTags: compute_actionable_tags({ payload, schema }),
      lastComputedAt: now,
    });

    if (buffer.length >= BATCH_SIZE) {
      await flush(buffer);
      processed += buffer.length;
      buffer = [];
    }
  }
  if (buffer.length > 0) {
    await flush(buffer);
    processed += buffer.length;
  }

  return { processed, duration_ms: Date.now() - started };
};

const flush = async (
  rows: Array<typeof item_metrics.$inferInsert>,
): Promise<void> => {
  await db
    .insert(item_metrics)
    .values(rows)
    .onConflictDoUpdate({
      target: item_metrics.itemId,
      set: {
        itemNetwork: sql`excluded.item_network`,
        itemDomain: sql`excluded.item_domain`,
        itemType: sql`excluded.item_type`,
        lifecycleStatus: sql`excluded.lifecycle_status`,
        ownerUserId: sql`excluded.owner_user_id`,
        onboardedByOrgId: sql`excluded.onboarded_by_org_id`,
        onboardedVia: sql`excluded.onboarded_via`,
        displayName: sql`excluded.display_name`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        initiated: sql`excluded.initiated`,
        received: sql`excluded.received`,
        lastInitiatedAt: sql`excluded.last_initiated_at`,
        lastReceivedAt: sql`excluded.last_received_at`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
