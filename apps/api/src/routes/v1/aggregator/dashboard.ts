import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization } from '../../../../db/postgres/schema/auth.js';
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
 * Returns a per-domain rollup + paginated items list for the acting
 * aggregator. The set of in-scope domains is determined by
 * `organization.metadata.domains` (a JSON string column); callers
 * can narrow to one with `?domain=`.
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
    } catch { /* fallthrough → 400 below */ }
  }
  if (configured_domains.length === 0) {
    return reply.code(400).send({
      error: 'NO_DOMAINS_CONFIGURED',
      message: 'org.metadata.domains is empty — re-upsert with domains array',
    });
  }

  const { page, limit, domain: requested_domain, status, refresh } = request.query;
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
    scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
  );
  const earliest_last_computed = staleness
    .map((s) => s.last_computed_at)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const any_refreshed = staleness.some((s) => s.refreshed);

  const by_domain: Record<string, unknown> = {};
  for (const d of scope) {
    by_domain[d] = await build_domain_block(acting.org_id, d, page, limit, status);
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

  // Single aggregate query for the rollup tiles + derived metrics.
  // ?status= filters the items list but NOT the rollup counts — those
  // reflect the full domain population regardless of the status filter.
  const rollupRes: unknown = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total_items,
      COUNT(*) FILTER (WHERE ${item_metrics.profileCompletionPct} >= 100)::int AS complete_profiles,
      COUNT(*) FILTER (
        WHERE (${item_metrics.countCreate} + ${item_metrics.countAccept}
             + ${item_metrics.countReject} + ${item_metrics.countCancel}) > 0
      )::int AS has_applications,

      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'new')::int      AS s_new,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'active')::int   AS s_active,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'at_risk')::int  AS s_at_risk,
      COUNT(*) FILTER (WHERE ${item_metrics.profileStatus} = 'inactive')::int AS s_inactive,

      COALESCE(SUM(${item_metrics.countCreate}), 0)::int AS b_create,
      COALESCE(SUM(${item_metrics.countAccept}), 0)::int AS b_accept,
      COALESCE(SUM(${item_metrics.countReject}), 0)::int AS b_reject,
      COALESCE(SUM(${item_metrics.countCancel}), 0)::int AS b_cancel,

      COUNT(DISTINCT ${item_metrics.ownerUserId})::int AS unique_users,
      COALESCE(SUM(
        ${item_metrics.countCreate} + ${item_metrics.countAccept}
        + ${item_metrics.countReject} + ${item_metrics.countCancel}
      ), 0)::int AS total_actions,
      COUNT(DISTINCT ${item_metrics.ownerUserId}) FILTER (
        WHERE (${item_metrics.countCreate} + ${item_metrics.countAccept}
             + ${item_metrics.countReject} + ${item_metrics.countCancel}) > 0
      )::int AS engaged_users
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain};
  `);
  const rollupRow: Record<string, number> = (Array.isArray(rollupRes)
    ? (rollupRes as Array<Record<string, number>>)[0]
    : ((rollupRes as { rows?: Array<Record<string, number>> }).rows ?? [])[0]) ?? {};

  const modeRes: unknown = await db.execute(sql`
    SELECT ${item_metrics.onboardedVia} AS via, COUNT(*)::int AS n
    FROM ${item_metrics}
    WHERE ${item_metrics.onboardedByOrgId} = ${org_id}
      AND ${item_metrics.itemDomain} = ${domain}
    GROUP BY ${item_metrics.onboardedVia};
  `);
  const modeRows: Array<{ via: string | null; n: number }> = Array.isArray(modeRes)
    ? (modeRes as Array<{ via: string | null; n: number }>)
    : ((modeRes as { rows?: Array<{ via: string | null; n: number }> }).rows ?? []);
  const mode_wise_counts: Record<string, number> = {};
  for (const r of modeRows) if (r?.via) mode_wise_counts[r.via] = r.n;

  const total_items = rollupRow.total_items ?? 0;
  const unique_users = rollupRow.unique_users ?? 0;
  const total_actions = rollupRow.total_actions ?? 0;
  const engaged_users = rollupRow.engaged_users ?? 0;

  const rollup = {
    total_items,
    complete_profiles: rollupRow.complete_profiles ?? 0,
    has_applications: rollupRow.has_applications ?? 0,
    by_status: {
      new: rollupRow.s_new ?? 0,
      active: rollupRow.s_active ?? 0,
      at_risk: rollupRow.s_at_risk ?? 0,
      inactive: rollupRow.s_inactive ?? 0,
    },
    by_action_status: {
      create: rollupRow.b_create ?? 0,
      accept: rollupRow.b_accept ?? 0,
      reject: rollupRow.b_reject ?? 0,
      cancel: rollupRow.b_cancel ?? 0,
    },
    avg_items_per_user: unique_users > 0 ? total_items / unique_users : 0,
    avg_actions_per_user: engaged_users > 0 ? total_actions / engaged_users : 0,
    mode_wise_counts,
  };

  const total_rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(item_metrics)
    .where(filter_where!)) as Array<{ n: number }>;
  const total_matching = total_rows[0]?.n ?? 0;

  const list_rows = await db
    .select(getTableColumns(item_metrics))
    .from(item_metrics)
    .where(filter_where!)
    .orderBy(desc(item_metrics.profileLastUpdatedAt), desc(item_metrics.itemId))
    .limit(limit)
    .offset((page - 1) * limit);

  const items = list_rows.map((r) => ({
    item_network: r.itemNetwork,
    item_domain: r.itemDomain,
    item_type: r.itemType,
    name: r.displayName,
    onboarded_via: r.onboardedVia,

    profile_status: r.profileStatus as 'new' | 'active' | 'at_risk' | 'inactive' | null,
    profile_completion_pct: r.profileCompletionPct,
    profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
    profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
    age_days: r.ageDays,

    count_create: r.countCreate ?? 0,
    count_accept: r.countAccept ?? 0,
    count_reject: r.countReject ?? 0,
    count_cancel: r.countCancel ?? 0,

    last_create_at: r.lastCreateAt?.toISOString() ?? null,
    last_accept_at: r.lastAcceptAt?.toISOString() ?? null,
    last_reject_at: r.lastRejectAt?.toISOString() ?? null,
    last_cancel_at: r.lastCancelAt?.toISOString() ?? null,

    actionable_tags: r.actionableTags ?? [],
  }));

  return {
    rollup,
    items,
    total_matching,
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
  };
}

export default aggregator_dashboard;
