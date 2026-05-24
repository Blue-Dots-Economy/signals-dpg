import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization, user } from '../../../../db/postgres/schema/auth.js';
import { eq, and, sql, desc, getTableColumns } from 'drizzle-orm';
import {
  DashboardRequestQuery,
  DashboardResponse,
  type DashboardRequestQuery as DQ,
} from '@dpg/schemas';
import {
  check_and_refresh_if_stale,
  TTL_SECONDS,
} from '@/services/metrics/staleness';

/**
 * GET /api/v1/aggregator/dashboard
 *
 * Plan B Task 10. Returns a per-domain rollup + paginated participants
 * list for the acting aggregator. The set of in-scope domains is
 * determined by `organization.metadata.domains` (a JSON string column);
 * callers can narrow to one with `?domain=`.
 *
 * Auth/acting_org resolution happens upstream in aggregator_routes'
 * preHandler chain. This handler enforces:
 *   - acting org_type === 'aggregator'           → 403 NOT_AGGREGATOR
 *   - org.metadata.domains is non-empty array    → 400 NO_DOMAINS_CONFIGURED
 *   - ?domain= (when present) is in that set     → 400 DOMAIN_NOT_CONFIGURED
 *
 * Per-domain staleness is refreshed in parallel via Promise.all. The
 * top-level metadata.last_computed_at is the earliest across all scoped
 * domains; metadata.refreshed is true if any domain was refreshed.
 */
type DashboardRequest = FastifyRequest<{ Querystring: DQ }>;

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard',
    schema: {
      tags: ['aggregator'],
      querystring: DashboardRequestQuery,
      response: { 200: DashboardResponse },
    },
    handler: aggregator_dashboard_handler,
  });
};

export const aggregator_dashboard_handler = async (
  request: DashboardRequest,
  reply: FastifyReply,
) => {
  const acting = request.acting_org;
  if (!acting || acting.org_type !== 'aggregator') {
    return reply.code(403).send({
      error: 'NOT_AGGREGATOR',
      message: 'caller must act on behalf of an aggregator org',
    });
  }

  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, acting.org_id))
    .limit(1)) as Array<{ metadata: string | null }>;

  let configured_domains: string[] = [];
  if (org?.metadata) {
    try {
      const meta = JSON.parse(org.metadata) as { domains?: unknown };
      if (Array.isArray(meta.domains)) {
        configured_domains = (meta.domains as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        );
      }
    } catch {
      /* fallthrough → 400 below */
    }
  }
  if (configured_domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }

  const { page, limit, domain: requested_domain, status } = request.query;
  let scope: string[] = configured_domains;
  if (requested_domain) {
    if (!configured_domains.includes(requested_domain)) {
      return reply.code(400).send({
        error: 'DOMAIN_NOT_CONFIGURED',
        message: `?domain=${requested_domain} is not in org.metadata.domains`,
      });
    }
    scope = [requested_domain];
  }

  // Parallel staleness check per (org, domain) — each has its own
  // advisory-lock key (see services/metrics/staleness.ts), so domains
  // can refresh concurrently without blocking each other.
  const staleness = await Promise.all(
    scope.map((d) => check_and_refresh_if_stale(acting.org_id, d)),
  );
  const earliest_last_computed =
    staleness
      .map((s) => s.last_computed_at)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const any_refreshed = staleness.some((s) => s.refreshed);

  const by_domain: Record<string, unknown> = {};
  for (const d of scope) {
    by_domain[d] = await build_domain_block(
      acting.org_id,
      d,
      page,
      limit,
      status,
    );
  }

  return {
    by_domain,
    metadata: {
      last_computed_at: earliest_last_computed?.toISOString() ?? null,
      ttl_seconds: TTL_SECONDS,
      refreshed: any_refreshed,
    },
  };
};

async function build_domain_block(
  org_id: string,
  domain: string,
  page: number,
  limit: number,
  status: string | undefined,
) {
  const base_where = and(
    eq(item_metrics.onboardedByOrgId, org_id),
    eq(item_metrics.itemDomain, domain),
  );
  const filter_where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  // Status histogram + application sums (per profile_status bucket).
  const rollup_rows = (await db
    .select({
      profile_status: item_metrics.profileStatus,
      n: sql<number>`count(*)::int`,
      apps_total: sql<number>`COALESCE(sum(${item_metrics.applicationsTotal}), 0)::int`,
      pending: sql<number>`COALESCE(sum(${item_metrics.applicationsPending}), 0)::int`,
      shortlisted: sql<number>`COALESCE(sum(${item_metrics.applicationsShortlisted}), 0)::int`,
      rejected: sql<number>`COALESCE(sum(${item_metrics.applicationsRejected}), 0)::int`,
    })
    .from(item_metrics)
    .where(base_where!)
    .groupBy(item_metrics.profileStatus)) as Array<{
    profile_status: string | null;
    n: number;
    apps_total: number;
    pending: number;
    shortlisted: number;
    rejected: number;
  }>;

  // Per-user aggregates (one row).
  const user_agg_result: unknown = await db.execute(sql`
    SELECT
      COUNT(DISTINCT ${item_metrics.ownerUserId})::int             AS unique_users,
      COUNT(*) FILTER (WHERE ${item_metrics.profileCompletionPct} >= 100)::int AS complete_profiles_count,
      COUNT(DISTINCT ${item_metrics.ownerUserId}) FILTER (
        WHERE ${item_metrics.applicationsTotal} > 0
      )::int                                                       AS users_with_applications,
      COUNT(*) FILTER (
        WHERE ${item_metrics.profileCreatedAt} >= NOW() - INTERVAL '7 days'
      )::int                                                       AS new_users_last_7_days,
      COALESCE(SUM(${item_metrics.applicationsTotal}), 0)::int     AS total_applications
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain};
  `);
  const user_agg_rows: Array<{
    unique_users: number;
    complete_profiles_count: number;
    users_with_applications: number;
    new_users_last_7_days: number;
    total_applications: number;
  }> = Array.isArray(user_agg_result)
    ? (user_agg_result as Array<{
        unique_users: number;
        complete_profiles_count: number;
        users_with_applications: number;
        new_users_last_7_days: number;
        total_applications: number;
      }>)
    : (
        (user_agg_result as {
          rows?: Array<{
            unique_users: number;
            complete_profiles_count: number;
            users_with_applications: number;
            new_users_last_7_days: number;
            total_applications: number;
          }>;
        }).rows ?? []
      );
  const user_agg = user_agg_rows[0];

  const items_total = rollup_rows.reduce((s, r) => s + (r.n ?? 0), 0);
  const apps_total = rollup_rows.reduce(
    (s, r) => s + (r.apps_total ?? 0),
    0,
  );

  // Mode-wise counts (group by onboarded_via).
  const mode_result: unknown = await db.execute(sql`
    SELECT ${item_metrics.onboardedVia} AS via, COUNT(*)::int AS n
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
    GROUP BY ${item_metrics.onboardedVia};
  `);
  const mode_rows: Array<{ via: string | null; n: number }> = Array.isArray(
    mode_result,
  )
    ? (mode_result as Array<{ via: string | null; n: number }>)
    : (
        (mode_result as { rows?: Array<{ via: string | null; n: number }> })
          .rows ?? []
      );

  const mode_wise_counts: Record<string, number> = {};
  for (const r of mode_rows) {
    if (r?.via) mode_wise_counts[r.via] = r.n;
  }

  const rollup = {
    items_total,
    by_status: Object.fromEntries(
      rollup_rows.map((r) => [r.profile_status ?? 'unknown', r.n ?? 0]),
    ) as Record<string, number>,
    applications_total: apps_total,
    applications_pending: rollup_rows.reduce(
      (s, r) => s + (r.pending ?? 0),
      0,
    ),
    applications_shortlisted: rollup_rows.reduce(
      (s, r) => s + (r.shortlisted ?? 0),
      0,
    ),
    applications_rejected: rollup_rows.reduce(
      (s, r) => s + (r.rejected ?? 0),
      0,
    ),
    unique_users: user_agg?.unique_users ?? 0,
    complete_profiles_count: user_agg?.complete_profiles_count ?? 0,
    avg_profiles_per_user: user_agg?.unique_users
      ? items_total / user_agg.unique_users
      : 0,
    users_with_applications: user_agg?.users_with_applications ?? 0,
    avg_applications_per_user: user_agg?.users_with_applications
      ? (user_agg?.total_applications ?? 0) / user_agg.users_with_applications
      : 0,
    new_users_last_7_days: user_agg?.new_users_last_7_days ?? 0,
    mode_wise_counts,
  };

  // total_matching applies the status filter (rollup above does not).
  const total_rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(item_metrics)
    .where(filter_where!)) as Array<{ n: number }>;
  const total_matching = total_rows[0]?.n ?? 0;

  const list_rows = await db
    .select({
      ...getTableColumns(item_metrics),
      name: user.name,
    })
    .from(item_metrics)
    .leftJoin(user, eq(user.id, item_metrics.ownerUserId))
    .where(filter_where!)
    .orderBy(
      desc(item_metrics.profileLastUpdatedAt),
      desc(item_metrics.itemId),
    )
    .limit(limit)
    .offset((page - 1) * limit);

  const participants = list_rows.map((r) => ({
    item_id: r.itemId,
    item_network: r.itemNetwork,
    owner_user_id: r.ownerUserId,
    name: r.name,
    item_type: r.itemType,
    profile_status: r.profileStatus,
    profile_completion_pct: r.profileCompletionPct,
    profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
    profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
    age_days: r.ageDays,
    applications_total: r.applicationsTotal ?? 0,
    applications_pending: r.applicationsPending ?? 0,
    applications_shortlisted: r.applicationsShortlisted ?? 0,
    applications_rejected: r.applicationsRejected ?? 0,
    last_applied_at: r.lastAppliedAt?.toISOString() ?? null,
    last_shortlisted_at: r.lastShortlistedAt?.toISOString() ?? null,
    last_rejected_at: r.lastRejectedAt?.toISOString() ?? null,
    openings: r.openings ?? null,
    actionable_tags: r.actionableTags ?? [],
  }));

  return {
    rollup,
    participants,
    total_matching,
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
  };
}

export default aggregator_dashboard;
