import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../db/postgres/schema/metrics.js';
import { profile_completion_pct } from './profile_completion.js';
import { compute_profile_status } from './profile_status.js';
import { compute_actionable_tags } from './actionable_tags.js';
import { get_schema_for_aggregator } from './schema_lookup.js';

const BATCH_SIZE = 1000;
const PROFILE_ITEM_TYPE = 'profile_1.0';
const MS_PER_DAY = 86_400_000;

/**
 * Coerce a raw timestamp value from `db.execute(sql`...`)` into a Date.
 *
 * Drizzle's high-level query builder maps declared `timestamp()` columns
 * to Date automatically. Raw SQL via .execute() bypasses that — node-postgres
 * returns timestamps as ISO strings unless type parsers are configured.
 * Already-Date inputs pass through unchanged; null/undefined returns null.
 */
const to_date = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') return new Date(v);
  // Anything else (object that's not a Date?) — surface the bug rather than mask it.
  throw new TypeError(
    `to_date: expected Date | string | number | null, got ${typeof v}`,
  );
};

export interface RecomputeResult {
  processed: number;
  duration_ms: number;
}

// db.execute<T>'s T must extend Record<string, unknown> (pg's QueryResultRow).
type RecomputeRow = {
  user_id: string;
  created_at: Date;
  updated_at: Date;
  onboarded_by_org_id: string | null;
  onboarded_via: string | null;
  profile_state: Record<string, unknown> | null;
  profile_created_at: Date | null;
  profile_last_updated_at: Date | null;
  applications_total: number;
  applications_pending: number;
  applications_accepted: number;
  applications_rejected: number;
} & Record<string, unknown>;

/**
 * Recomputes participant_metrics for every user belonging to the given
 * aggregator. One SQL pass pulls user + latest profile_1.0 item + per-status
 * application counts; the three rule modules (Tasks 2-4) evaluate per row;
 * upsert flushes in batches of 1000.
 *
 * Caller is the staleness layer (Task 6) — recompute runs inside a Postgres
 * advisory lock so concurrent dashboard hits don't pile up duplicate work.
 *
 * Column mapping (verified against packages/database/src/drizzle_ref_tables):
 *   - items.created_by                → profile owner
 *   - items.item_state (jsonb)        → profile payload
 *   - item_actions.source_item_owner  → applicant (the seeker performing the
 *                                       action — set to source item's created_by)
 *   - item_actions.action_status      → free-form text; pilot assumes
 *                                       'pending'|'accepted'|'rejected'
 *
 * Only actions whose source_item_type = 'profile_1.0' are counted — keeps
 * "applications" scoped to the profile so unrelated action_types (e.g.
 * provider-side acknowledgements) don't inflate the seeker's totals.
 *
 * Multiple profile_1.0 items per user (across network/domain) are reduced to
 * the most-recently-updated one via DISTINCT ON.
 */
export const recompute_aggregator_metrics = async (
  aggregator_id: string,
): Promise<RecomputeResult> => {
  const started = Date.now();
  const { schema } = await get_schema_for_aggregator(aggregator_id);
  const now = new Date();

  const result = await db.execute<RecomputeRow>(sql`
    WITH latest_profile AS (
      SELECT DISTINCT ON (created_by)
        created_by,
        item_state,
        created_at,
        updated_at
      FROM items
      WHERE item_type = ${PROFILE_ITEM_TYPE}
      ORDER BY created_by, updated_at DESC
    ),
    app_counts AS (
      SELECT
        source_item_owner,
        COUNT(*)::int                                                       AS total,
        COUNT(*) FILTER (WHERE action_status = 'pending')::int              AS pending,
        COUNT(*) FILTER (WHERE action_status = 'accepted')::int             AS accepted,
        COUNT(*) FILTER (WHERE action_status = 'rejected')::int             AS rejected
      FROM item_actions
      WHERE source_item_type = ${PROFILE_ITEM_TYPE}
        AND source_item_owner IS NOT NULL
      GROUP BY source_item_owner
    )
    SELECT
      u.id                                       AS user_id,
      u.created_at                               AS created_at,
      u.updated_at                               AS updated_at,
      u.onboarded_by_org_id                      AS onboarded_by_org_id,
      u.onboarded_via                            AS onboarded_via,
      lp.item_state                              AS profile_state,
      lp.created_at                              AS profile_created_at,
      lp.updated_at                              AS profile_last_updated_at,
      COALESCE(ac.total,    0)                   AS applications_total,
      COALESCE(ac.pending,  0)                   AS applications_pending,
      COALESCE(ac.accepted, 0)                   AS applications_accepted,
      COALESCE(ac.rejected, 0)                   AS applications_rejected
    FROM "user" u
    LEFT JOIN latest_profile lp ON lp.created_by = u.id
    LEFT JOIN app_counts    ac ON ac.source_item_owner = u.id
    WHERE u.onboarded_by_org_id = ${aggregator_id};
  `);

  // node-postgres driver returns `{ rows: T[] }` from drizzle's .execute().
  // Defensively accept either shape so tests that hand back an array still work.
  const rows: RecomputeRow[] = Array.isArray(result)
    ? (result as RecomputeRow[])
    : ((result as { rows?: RecomputeRow[] }).rows ?? []);

  let processed = 0;
  let buffer: Array<typeof participant_metrics.$inferInsert> = [];

  for (const r of rows) {
    const payload = r.profile_state ?? {};
    // node-postgres returns timestamps as strings from raw db.execute(sql`...`)
    // calls (Drizzle only coerces dates when the high-level query builder
    // sees a declared `timestamp()` column). Coerce defensively — already-
    // Date inputs pass through `new Date()` unchanged. user.created_at is
    // NOT NULL in the schema, so to_date never returns null here.
    const created_at = to_date(r.created_at)!;
    // Users without a profile fall back to their user record's timestamps —
    // age_days then reflects "how long since signup" instead of throwing.
    const profile_created = to_date(r.profile_created_at) ?? created_at;
    const profile_updated = to_date(r.profile_last_updated_at) ?? created_at;
    const idle_days = Math.floor((now.getTime() - profile_updated.getTime()) / MS_PER_DAY);

    buffer.push({
      userId: r.user_id,
      onboardedByOrgId: r.onboarded_by_org_id,
      onboardedVia: r.onboarded_via,
      profileStatus: compute_profile_status({
        profile_created_at: profile_created,
        profile_last_updated_at: profile_updated,
        applications_total: r.applications_total,
        applications_accepted: r.applications_accepted,
        now,
      }),
      profileCompletionPct: profile_completion_pct(payload, schema),
      profileCreatedAt: profile_created,
      profileLastUpdatedAt: profile_updated,
      ageDays: Math.floor((now.getTime() - created_at.getTime()) / MS_PER_DAY),
      applicationsPending: r.applications_pending,
      applicationsAccepted: r.applications_accepted,
      applicationsRejected: r.applications_rejected,
      applicationsTotal: r.applications_total,
      actionableTags: compute_actionable_tags({
        payload,
        schema,
        applications_total: r.applications_total,
        applications_rejected: r.applications_rejected,
        idle_days,
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
  rows: Array<typeof participant_metrics.$inferInsert>,
): Promise<void> => {
  await db
    .insert(participant_metrics)
    .values(rows)
    .onConflictDoUpdate({
      target: participant_metrics.userId,
      set: {
        onboardedByOrgId: sql`excluded.onboarded_by_org_id`,
        onboardedVia: sql`excluded.onboarded_via`,
        profileStatus: sql`excluded.profile_status`,
        profileCompletionPct: sql`excluded.profile_completion_pct`,
        profileCreatedAt: sql`excluded.profile_created_at`,
        profileLastUpdatedAt: sql`excluded.profile_last_updated_at`,
        ageDays: sql`excluded.age_days`,
        applicationsPending: sql`excluded.applications_pending`,
        applicationsAccepted: sql`excluded.applications_accepted`,
        applicationsRejected: sql`excluded.applications_rejected`,
        applicationsTotal: sql`excluded.applications_total`,
        actionableTags: sql`excluded.actionable_tags`,
        lastComputedAt: sql`excluded.last_computed_at`,
      },
    });
};
