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

interface AggregatedRow extends Record<string, unknown> {
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
  count_create: number;
  count_accept: number;
  count_reject: number;
  count_cancel: number;
  last_create_at: Date | string | null;
  last_accept_at: Date | string | null;
  last_reject_at: Date | string | null;
  last_cancel_at: Date | string | null;
}

/**
 * Build a UNION ALL of per-bucket event SELECTs for every tracked interaction
 * in the network. Each SELECT emits (item_id, bucket, created_at) rows that
 * the outer GROUP BY in the main CTE buckets into per-item counts and MAX
 * timestamps.
 *
 * Bidirectional: when an item's domain participates as the SOURCE of an
 * interaction (e.g. seeker→provider connect), the seeker's item_id is
 * source_item_id. When it participates as TARGET (e.g. provider→seeker
 * connect for the provider domain), the provider's item_id is target_item_id.
 * Both source and target rows of the same canonical bucket get counted on
 * each side — that's what "symmetric" means in spec §c.
 */
const buildInteractionEvents = (
  tracked: Array<{ actionType: string; fromDomain: string; toDomain: string; categories: MetricCategoriesMap }>,
  domain: string,
): import('drizzle-orm').SQL | null => {
  const pieces: import('drizzle-orm').SQL[] = [];

  for (const t of tracked) {
    const isSource = t.fromDomain === domain;
    const isTarget = t.toDomain === domain;
    if (!isSource && !isTarget) continue;

    const idCol = isSource ? sql`source_item_id` : sql`target_item_id`;

    for (const bucket of CANONICAL_BUCKETS) {
      const statuses = t.categories[bucket];
      if (statuses.length === 0) continue;
      const list = sql.join(statuses.map((s) => sql`${s}`), sql`, `);
      pieces.push(sql`
        SELECT
          ${idCol} AS item_id,
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
  }

  if (pieces.length === 0) return null;
  return sql.join(pieces, sql` UNION ALL `);
};

/**
 * Recomputes item_metrics for all items owned by users onboarded by the
 * given aggregator within the given domain. Bidirectional: aggregates
 * actions in both source and target positions, per the tracked-interactions
 * collected from the network config. Per-item status is evaluated against
 * the domain's status_rules from network.json.
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

  // Main query: aggregate events into per-item bucket counts/timestamps,
  // join to items + user attribution. Empty `eventsCte` (no tracked
  // interactions touch this domain) → action_counts is an empty CTE so
  // every join yields 0 counts via COALESCE.
  const actionCountsCte = eventsCte
    ? sql`
        WITH ev AS (${eventsCte}),
        action_counts AS (
          SELECT
            item_id,
            COUNT(*) FILTER (WHERE bucket = 'create')::int AS count_create,
            COUNT(*) FILTER (WHERE bucket = 'accept')::int AS count_accept,
            COUNT(*) FILTER (WHERE bucket = 'reject')::int AS count_reject,
            COUNT(*) FILTER (WHERE bucket = 'cancel')::int AS count_cancel,
            MAX(created_at) FILTER (WHERE bucket = 'create') AS last_create_at,
            MAX(created_at) FILTER (WHERE bucket = 'accept') AS last_accept_at,
            MAX(created_at) FILTER (WHERE bucket = 'reject') AS last_reject_at,
            MAX(created_at) FILTER (WHERE bucket = 'cancel') AS last_cancel_at
          FROM ev
          GROUP BY item_id
        )
      `
    : sql`
        WITH action_counts AS (
          SELECT
            ''::text AS item_id,
            0::int AS count_create, 0::int AS count_accept,
            0::int AS count_reject, 0::int AS count_cancel,
            NULL::timestamp AS last_create_at,
            NULL::timestamp AS last_accept_at,
            NULL::timestamp AS last_reject_at,
            NULL::timestamp AS last_cancel_at
          WHERE FALSE
        )
      `;

  const result = await db.execute<AggregatedRow>(sql`
    ${actionCountsCte}
    SELECT
      i.item_id            AS item_id,
      i.item_network       AS item_network,
      i.item_domain        AS item_domain,
      i.item_type          AS item_type,
      i.created_by         AS owner_user_id,
      u.onboarded_by_org_id AS onboarded_by_org_id,
      u.onboarded_via      AS onboarded_via,
      i.item_state         AS item_state,
      i.created_at         AS profile_created_at,
      i.updated_at         AS profile_last_updated_at,
      COALESCE(ac.count_create, 0) AS count_create,
      COALESCE(ac.count_accept, 0) AS count_accept,
      COALESCE(ac.count_reject, 0) AS count_reject,
      COALESCE(ac.count_cancel, 0) AS count_cancel,
      ac.last_create_at, ac.last_accept_at,
      ac.last_reject_at, ac.last_cancel_at
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
    const last_create = to_date(r.last_create_at);
    const last_accept = to_date(r.last_accept_at);
    const last_reject = to_date(r.last_reject_at);
    const last_cancel = to_date(r.last_cancel_at);

    const schema = await get_item_schema(r.item_network, r.item_domain, r.item_type);

    const age_days = days_between(profile_created, now);

    const dsl_input = {
      item_age_days: age_days,
      count: {
        create: r.count_create,
        accept: r.count_accept,
        reject: r.count_reject,
        cancel: r.count_cancel,
      } as Record<CanonicalBucket, number>,
      days_since_last: {
        create: last_create === null ? null : days_between(last_create, now),
        accept: last_accept === null ? null : days_between(last_accept, now),
        reject: last_reject === null ? null : days_between(last_reject, now),
        cancel: last_cancel === null ? null : days_between(last_cancel, now),
      } as Record<CanonicalBucket, number | null>,
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
      ownerUserId: r.owner_user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      displayName,
      profileStatus,
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: age_days,
      countCreate: r.count_create,
      countAccept: r.count_accept,
      countReject: r.count_reject,
      countCancel: r.count_cancel,
      lastCreateAt: last_create,
      lastAcceptAt: last_accept,
      lastRejectAt: last_reject,
      lastCancelAt: last_cancel,
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
        ownerUserId: sql`excluded.owner_user_id`,
        onboardedByOrgId: sql`excluded.onboarded_by_org_id`,
        onboardedVia: sql`excluded.onboarded_via`,
        displayName: sql`excluded.display_name`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        countCreate: sql`excluded.count_create`,
        countAccept: sql`excluded.count_accept`,
        countReject: sql`excluded.count_reject`,
        countCancel: sql`excluded.count_cancel`,
        lastCreateAt: sql`excluded.last_create_at`,
        lastAcceptAt: sql`excluded.last_accept_at`,
        lastRejectAt: sql`excluded.last_reject_at`,
        lastCancelAt: sql`excluded.last_cancel_at`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
