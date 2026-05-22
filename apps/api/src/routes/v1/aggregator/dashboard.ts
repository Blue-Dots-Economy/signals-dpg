import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../../db/postgres/schema/metrics.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import {
  DashboardRequestQuery,
  DashboardResponse,
  type DashboardRequestQuery as DashboardQuery,
} from '@dpg/schemas';
import {
  check_and_refresh_if_stale,
  TTL_SECONDS,
} from '@/services/metrics/staleness';

/**
 * GET /api/v1/aggregator/dashboard
 *
 * Plan 3 Task 9. Reads the participant_metrics cache scoped to
 * request.acting_org.org_id. Returns a status-rollup, a paginated
 * participant list, and cache metadata.
 *
 * Auth/acting_org resolution happens upstream in aggregator_routes'
 * preHandler chain (auth_middleware + acting_org_preHandler). This
 * handler narrows the permitted org_type to 'aggregator' only.
 */
type DashboardRequest = FastifyRequest<{ Querystring: DashboardQuery }>;

export const aggregator_dashboard: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard',
    schema: {
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

  const { page, limit, status } = request.query;

  const staleness = await check_and_refresh_if_stale(acting.org_id);

  // Rollup — group by status across the aggregator's rows.
  const rollup_rows = (await db
    .select({
      status: participant_metrics.profileStatus,
      n: sql<number>`count(*)::int`,
      pending: sql<number>`COALESCE(sum(${participant_metrics.applicationsPending}), 0)::int`,
      accepted: sql<number>`COALESCE(sum(${participant_metrics.applicationsAccepted}), 0)::int`,
      rejected: sql<number>`COALESCE(sum(${participant_metrics.applicationsRejected}), 0)::int`,
    })
    .from(participant_metrics)
    .where(eq(participant_metrics.onboardedByOrgId, acting.org_id))
    .groupBy(participant_metrics.profileStatus)) as Array<{
    status: string | null;
    n: number;
    pending: number;
    accepted: number;
    rejected: number;
  }>;

  const rollup = {
    participants_total: rollup_rows.reduce((s, r) => s + (r.n ?? 0), 0),
    by_status: Object.fromEntries(
      rollup_rows.map((r) => [r.status ?? 'unknown', r.n ?? 0]),
    ) as Record<string, number>,
    applications_pending: rollup_rows.reduce(
      (s, r) => s + (r.pending ?? 0),
      0,
    ),
    applications_accepted: rollup_rows.reduce(
      (s, r) => s + (r.accepted ?? 0),
      0,
    ),
    applications_rejected: rollup_rows.reduce(
      (s, r) => s + (r.rejected ?? 0),
      0,
    ),
  };

  // Filter conditions for the list + total_matching.
  const conditions = [
    eq(participant_metrics.onboardedByOrgId, acting.org_id),
  ];
  if (status) {
    conditions.push(eq(participant_metrics.profileStatus, status));
  }
  const where =
    conditions.length === 1 ? conditions[0] : and(...conditions);

  const total_rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(participant_metrics)
    .where(where!)) as Array<{ n: number }>;
  const total_matching = total_rows[0]?.n ?? 0;

  const list_rows = (await db
    .select()
    .from(participant_metrics)
    .where(where!)
    .orderBy(desc(participant_metrics.userId))
    .limit(limit)
    .offset((page - 1) * limit)) as Array<{
    userId: string;
    profileStatus: string | null;
    profileCompletionPct: number | null;
    profileCreatedAt: Date | null;
    profileLastUpdatedAt: Date | null;
    ageDays: number | null;
    applicationsPending: number | null;
    applicationsAccepted: number | null;
    applicationsRejected: number | null;
    applicationsTotal: number | null;
    actionableTags: string[] | null;
  }>;

  return {
    rollup,
    participants: list_rows.map((r) => ({
      user_id: r.userId,
      profile_status: r.profileStatus,
      profile_completion_pct: r.profileCompletionPct,
      profile_created_at: r.profileCreatedAt?.toISOString() ?? null,
      profile_last_updated_at: r.profileLastUpdatedAt?.toISOString() ?? null,
      age_days: r.ageDays,
      applications_pending: r.applicationsPending ?? 0,
      applications_accepted: r.applicationsAccepted ?? 0,
      applications_rejected: r.applicationsRejected ?? 0,
      applications_total: r.applicationsTotal ?? 0,
      actionable_tags: r.actionableTags ?? [],
    })),
    next_cursor: list_rows.length === limit ? String(page + 1) : null,
    total_matching,
    metadata: {
      last_computed_at: staleness.last_computed_at?.toISOString() ?? null,
      ttl_seconds: TTL_SECONDS,
      refreshed: staleness.refreshed,
    },
  };
};

export default aggregator_dashboard;
