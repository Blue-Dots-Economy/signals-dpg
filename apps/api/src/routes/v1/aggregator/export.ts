import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { participant_metrics } from '../../../../db/postgres/schema/metrics.js';
import { eq, and, desc } from 'drizzle-orm';
import {
  ExportQuery,
  type ExportQuery as ExportQueryType,
} from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';

/**
 * GET /api/v1/aggregator/dashboard/export
 *
 * Plan 3 Task 10. Streams CSV of all participant_metrics rows for the
 * acting aggregator, with optional ?status filter. Same auth + staleness
 * contract as the dashboard route. No pagination in the URL — the export
 * is "everything matching the filter."
 *
 * Pages through the participant_metrics table in chunks of 5000 to avoid
 * loading 200k+ rows into memory at once. Output is piped via an async
 * generator wrapped in a Readable.
 */
const COLUMNS = [
  'user_id',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'applications_pending',
  'applications_accepted',
  'applications_rejected',
  'applications_total',
  'actionable_tags',
] as const;

const PAGE_SIZE = 5000;

const csv_escape = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s: string;
  if (Array.isArray(v)) s = v.join('|');
  else if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

async function* generate_csv(
  aggregator_id: string,
  status: string | undefined,
): AsyncGenerator<string> {
  yield COLUMNS.join(',') + '\n';

  const conditions = [eq(participant_metrics.onboardedByOrgId, aggregator_id)];
  if (status) {
    conditions.push(eq(participant_metrics.profileStatus, status));
  }
  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  let offset = 0;
  for (;;) {
    const rows = (await db
      .select()
      .from(participant_metrics)
      .where(where!)
      .orderBy(desc(participant_metrics.userId))
      .limit(PAGE_SIZE)
      .offset(offset)) as Array<{
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

    if (rows.length === 0) break;

    for (const r of rows) {
      const projected: Record<(typeof COLUMNS)[number], unknown> = {
        user_id: r.userId,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        applications_pending: r.applicationsPending,
        applications_accepted: r.applicationsAccepted,
        applications_rejected: r.applicationsRejected,
        applications_total: r.applicationsTotal,
        actionable_tags: r.actionableTags,
      };
      yield COLUMNS.map((c) => csv_escape(projected[c])).join(',') + '\n';
    }

    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

type ExportRequest = FastifyRequest<{ Querystring: ExportQueryType }>;

export const aggregator_export: FastifyPluginAsync = async (app) => {
  app.route({
    method: 'GET',
    url: '/dashboard/export',
    schema: { querystring: ExportQuery },
    handler: async (request: ExportRequest, reply: FastifyReply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      await check_and_refresh_if_stale(acting.org_id);

      const { status } = request.query;

      const filename = `participants_${acting.org_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${filename}"`,
        );

      return reply.send(Readable.from(generate_csv(acting.org_id, status)));
    },
  });
};

export default aggregator_export;
