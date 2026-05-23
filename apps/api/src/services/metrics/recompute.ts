import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../db/postgres/schema/metrics.js';
import { profile_completion_pct } from './profile_completion.js';
import { compute_seeker_status } from './seeker_status.js';
import { compute_provider_status } from './provider_status.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_item_schema } from './schema_lookup.js';
import { resolve_metric_categories } from './metric_categories.js';
import { getNetworkConfigById } from '@/network_configs';

const BATCH_SIZE = 1000;
const MS_PER_DAY = 86_400_000;
const APPLY_ACTION = 'apply';

/**
 * Coerce a raw timestamp value from `db.execute(sql`...`)` into a Date.
 * Drizzle's raw .execute() bypasses column-level Date coercion; node-postgres
 * returns timestamps as ISO strings unless type parsers are configured.
 */
const to_date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  throw new TypeError(
    `to_date: expected Date | string | number | null, got ${typeof v}`,
  );
};

const days_between = (earlier: Date, later: Date): number =>
  Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);

const min_not_null = (a: number | null, b: number | null): number | null => {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};

export interface RecomputeResult {
  processed: number;
  duration_ms: number;
}

type SampleRow = {
  item_network: string;
} & Record<string, unknown>;

type RecomputeRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  owner_user_id: string;
  onboarded_by_org_id: string | null;
  onboarded_via: string | null;
  item_state: Record<string, unknown> | null;
  profile_created_at: Date | string | null;
  profile_last_updated_at: Date | string | null;
  applications_total: number;
  applications_pending: number;
  applications_shortlisted: number;
  applications_rejected: number;
  last_applied_at: Date | string | null;
  last_shortlisted_at: Date | string | null;
  last_rejected_at: Date | string | null;
  openings: number | null;
} & Record<string, unknown>;

/**
 * Recomputes item_metrics for every item owned by users onboarded by the given
 * aggregator within the given domain. Per-(aggregator, domain) scoping is the
 * Plan B contract: aggregators can host items across multiple (network, domain,
 * item_type) triples, but a single recompute pass handles ONE domain at a time
 * so the metric_categories triple and direction filter stay coherent.
 *
 * Flow:
 *   1. Sample query → learns `item_network` for this (aggregator, domain). If
 *      no rows exist, return early with `processed: 0`.
 *   2. Resolve `metric_categories` from the network's `apply` interaction:
 *      - seeker domain → from_domain='seeker', to_domain='provider'
 *      - provider domain → from_domain='seeker', to_domain='provider' (same
 *        interaction; the direction filter on item_actions flips instead)
 *   3. Main CTE → counts item_actions bucketed by metric_categories, joined
 *      to items + users.
 *   4. Per row: domain-specific status helper + actionable_tags + flush in
 *      batches of 1000 via item_metrics upsert.
 */
export const recompute_aggregator_domain_metrics = async (
  aggregator_id: string,
  domain: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const now = new Date();

  // Step 1: learn the network for this (aggregator, domain) pair. One sample
  // is enough because all items in a (aggregator, domain) share a network in
  // Plan B's data model — aggregator.metadata.domains pins network + domain
  // bindings together.
  const sample = await db.execute<SampleRow>(sql`
    SELECT i.item_network
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain}
    LIMIT 1
  `);

  const sampleRows: SampleRow[] = Array.isArray(sample)
    ? (sample as SampleRow[])
    : ((sample as { rows?: SampleRow[] }).rows ?? []);

  if (sampleRows.length === 0) {
    return { processed: 0, duration_ms: Date.now() - started };
  }

  const network = sampleRows[0].item_network;

  // Step 2: resolve metric_categories. The `apply` interaction is always
  // seeker→provider (the action flows from the seeker to the provider).
  // For seeker rows we count where source_item_id = the seeker item; for
  // provider rows we count where target_item_id = the provider item.
  const networkConfig = await getNetworkConfigById(network);
  const categories = resolve_metric_categories(networkConfig, {
    actionType: APPLY_ACTION,
    fromDomain: 'seeker',
    toDomain: 'provider',
  }) ?? { shortlisted: [], rejected: [], pending: [] };

  const shortlistedArr = categories.shortlisted;
  const rejectedArr = categories.rejected;
  const pendingArr = categories.pending;

  // Drizzle's template-tag interpolation splays a JS array into individual
  // positional params, producing `($1, $2, $3)::text[]` which is invalid PG
  // syntax. Build a parameterized `IN (...)` list via `sql.join` instead.
  // Empty array → `IN (NULL)` which is always false (gives 0 counts, matching
  // the "metric_categories null → 0 counts" semantic).
  const sqlList = (arr: string[]) =>
    arr.length > 0
      ? sql.join(arr.map((s) => sql`${s}`), sql`, `)
      : sql`NULL`;

  const pendingList = sqlList(pendingArr);
  const shortlistedList = sqlList(shortlistedArr);
  const rejectedList = sqlList(rejectedArr);

  // Direction filter: seeker domain joins on source_item_id; provider on target.
  const directionCol =
    domain === 'provider' ? sql`target_item_id` : sql`source_item_id`;

  // Step 3: main CTE. Counts per item, joined to items + users.
  const result = await db.execute<RecomputeRow>(sql`
    WITH action_counts AS (
      SELECT
        ${directionCol} AS item_id,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE action_status IN (${pendingList}))::int     AS pending,
        COUNT(*) FILTER (WHERE action_status IN (${shortlistedList}))::int AS shortlisted,
        COUNT(*) FILTER (WHERE action_status IN (${rejectedList}))::int    AS rejected,
        MAX(created_at)                                                    AS last_applied_at,
        MAX(created_at) FILTER (WHERE action_status IN (${shortlistedList})) AS last_shortlisted_at,
        MAX(created_at) FILTER (WHERE action_status IN (${rejectedList}))    AS last_rejected_at
      FROM item_actions
      WHERE ${directionCol} IS NOT NULL
        AND action_type = ${APPLY_ACTION}
        AND source_item_domain = 'seeker'
        AND target_item_domain = 'provider'
      GROUP BY ${directionCol}
    )
    SELECT
      i.item_id                                  AS item_id,
      i.item_network                             AS item_network,
      i.item_domain                              AS item_domain,
      i.item_type                                AS item_type,
      i.created_by                               AS owner_user_id,
      u.onboarded_by_org_id                      AS onboarded_by_org_id,
      u.onboarded_via                            AS onboarded_via,
      i.item_state                               AS item_state,
      i.created_at                               AS profile_created_at,
      i.updated_at                               AS profile_last_updated_at,
      COALESCE(ac.total,       0)                AS applications_total,
      COALESCE(ac.pending,     0)                AS applications_pending,
      COALESCE(ac.shortlisted, 0)                AS applications_shortlisted,
      COALESCE(ac.rejected,    0)                AS applications_rejected,
      ac.last_applied_at                         AS last_applied_at,
      ac.last_shortlisted_at                     AS last_shortlisted_at,
      ac.last_rejected_at                        AS last_rejected_at,
      (i.item_state ->> 'positions')::int        AS openings
    FROM items i
    JOIN "user" u ON u.id = i.created_by
    LEFT JOIN action_counts ac ON ac.item_id = i.item_id
    WHERE u.onboarded_by_org_id = ${aggregator_id}
      AND i.item_domain = ${domain};
  `);

  const rows: RecomputeRow[] = Array.isArray(result)
    ? (result as RecomputeRow[])
    : ((result as { rows?: RecomputeRow[] }).rows ?? []);

  let processed = 0;
  let buffer: Array<typeof item_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = (r.item_state ?? {}) as Record<string, unknown>;
    const profile_created = to_date(r.profile_created_at) ?? now;
    const profile_updated = to_date(r.profile_last_updated_at) ?? profile_created;
    const last_applied_at = to_date(r.last_applied_at);
    const last_shortlisted_at = to_date(r.last_shortlisted_at);
    const last_rejected_at = to_date(r.last_rejected_at);

    // Resolve the JSON Schema for this item's (network, domain, item_type).
    // Cached at the network_configs layer; per-row call is cheap.
    const schema = await get_item_schema(
      r.item_network,
      r.item_domain,
      r.item_type,
    );

    const age_days = days_between(profile_created, now);

    let profileStatus: string;
    let last_applied_age_days: number | null = null;
    let min_decision_age_days: number | null = null;

    if (r.item_domain === 'provider') {
      const openings = r.openings ?? Number.POSITIVE_INFINITY;
      profileStatus = compute_provider_status({
        profile_created_at: profile_created,
        applications_total: r.applications_total,
        applications_shortlisted: r.applications_shortlisted,
        applications_rejected: r.applications_rejected,
        openings,
        last_shortlisted_at,
        last_rejected_at,
        now,
      });
      const sh_age = last_shortlisted_at === null ? null : days_between(last_shortlisted_at, now);
      const rj_age = last_rejected_at === null ? null : days_between(last_rejected_at, now);
      min_decision_age_days = min_not_null(sh_age, rj_age);
    } else {
      profileStatus = compute_seeker_status({
        profile_created_at: profile_created,
        last_applied_at,
        now,
      });
      last_applied_age_days =
        last_applied_at === null ? null : days_between(last_applied_at, now);
    }

    const actionableDomain: 'seeker' | 'provider' =
      r.item_domain === 'provider' ? 'provider' : 'seeker';

    buffer.push({
      itemId: r.item_id,
      itemNetwork: r.item_network,
      itemDomain: r.item_domain,
      itemType: r.item_type,
      ownerUserId: r.owner_user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      profileStatus,
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: age_days,
      applicationsTotal: r.applications_total,
      applicationsPending: r.applications_pending,
      applicationsShortlisted: r.applications_shortlisted,
      applicationsRejected: r.applications_rejected,
      lastAppliedAt: r.item_domain === 'provider' ? null : last_applied_at,
      lastShortlistedAt: r.item_domain === 'provider' ? last_shortlisted_at : null,
      lastRejectedAt: r.item_domain === 'provider' ? last_rejected_at : null,
      openings: r.item_domain === 'provider' ? r.openings : null,
      actionableTags: compute_actionable_tags({
        domain: actionableDomain,
        payload,
        schema,
        applications_total: r.applications_total,
        applications_rejected: r.applications_rejected,
        job_post_age_days: r.item_domain === 'provider' ? age_days : 0,
        last_applied_age_days,
        min_decision_age_days,
      }),
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
        ownerUserId: sql`excluded.owner_user_id`,
        onboardedByOrgId: sql`excluded.onboarded_by_org_id`,
        onboardedVia: sql`excluded.onboarded_via`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        applicationsTotal: sql`excluded.applications_total`,
        applicationsPending: sql`excluded.applications_pending`,
        applicationsShortlisted: sql`excluded.applications_shortlisted`,
        applicationsRejected: sql`excluded.applications_rejected`,
        lastAppliedAt: sql`excluded.last_applied_at`,
        lastShortlistedAt: sql`excluded.last_shortlisted_at`,
        lastRejectedAt: sql`excluded.last_rejected_at`,
        openings: sql`excluded.openings`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
