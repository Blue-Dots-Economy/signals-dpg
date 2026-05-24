import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization, user } from '../../../../db/postgres/schema/auth.js';
import { eq, and, inArray, asc } from 'drizzle-orm';
import {
  ExportQuery,
  type ExportQuery as ExportQueryType,
} from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';

/**
 * GET /api/v1/aggregator/dashboard/export
 *
 * Plan B Task 11. Streams CSV of all item_metrics rows for the acting
 * aggregator across its configured domains. Mirrors the dashboard
 * route's auth + domain-resolution contract:
 *   - acting org_type === 'aggregator'              → else 403 NOT_AGGREGATOR
 *   - org.metadata.domains is non-empty             → else 400 NO_DOMAINS_CONFIGURED
 *   - ?domain= (if present) is in that set          → else 400 DOMAIN_NOT_CONFIGURED
 *
 * Per-domain staleness refresh runs in parallel before the stream opens.
 * No pagination in the URL — the export is "everything matching the filter."
 * Rows are streamed via an async generator wrapped in a Readable to avoid
 * loading 200k+ rows into memory. Ordering is `(item_domain, item_id)` so
 * multi-domain output is grouped by domain.
 *
 * Note: item_private_state is intentionally excluded; only the COLUMNS list
 * below ever reaches the response body.
 */
const COLUMNS = [
  'item_id',
  'item_network',
  'item_domain',
  'item_type',
  'owner_user_id',
  'name',
  'onboarded_by_org_id',
  'onboarded_via',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'applications_total',
  'applications_pending',
  'applications_shortlisted',
  'applications_rejected',
  'last_applied_at',
  'last_shortlisted_at',
  'last_rejected_at',
  'openings',
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

const read_configured_domains = async (
  org_id: string,
): Promise<string[] | null> => {
  const [org] = (await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, org_id))
    .limit(1)) as Array<{ metadata: string | null }>;
  if (!org?.metadata) return null;
  try {
    const meta = JSON.parse(org.metadata) as { domains?: unknown };
    if (!Array.isArray(meta.domains)) return null;
    return (meta.domains as unknown[]).filter(
      (x): x is string => typeof x === 'string',
    );
  } catch {
    return null;
  }
};

async function* generate_csv(
  aggregator_id: string,
  scope: string[],
  status: string | undefined,
): AsyncGenerator<string> {
  yield COLUMNS.join(',') + '\n';

  const base_where = and(
    eq(item_metrics.onboardedByOrgId, aggregator_id),
    inArray(item_metrics.itemDomain, scope),
  );
  const where = status
    ? and(base_where, eq(item_metrics.profileStatus, status))
    : base_where;

  let offset = 0;
  for (;;) {
    const rows = (await db
      .select()
      .from(item_metrics)
      .where(where!)
      .orderBy(asc(item_metrics.itemDomain), asc(item_metrics.itemId))
      .limit(PAGE_SIZE)
      .offset(offset)) as Array<typeof item_metrics.$inferSelect>;

    if (rows.length === 0) break;

    const name_by_user_id = new Map<string, string | null>();
    const name_rows = await db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, rows.map((r) => r.ownerUserId)));
    for (const n of name_rows) name_by_user_id.set(n.id, n.name);

    for (const r of rows) {
      const projected: Record<(typeof COLUMNS)[number], unknown> = {
        item_id: r.itemId,
        item_network: r.itemNetwork,
        item_domain: r.itemDomain,
        item_type: r.itemType,
        owner_user_id: r.ownerUserId,
        name: name_by_user_id.get(r.ownerUserId) ?? null,
        onboarded_by_org_id: r.onboardedByOrgId,
        onboarded_via: r.onboardedVia,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        applications_total: r.applicationsTotal,
        applications_pending: r.applicationsPending,
        applications_shortlisted: r.applicationsShortlisted,
        applications_rejected: r.applicationsRejected,
        last_applied_at: r.lastAppliedAt,
        last_shortlisted_at: r.lastShortlistedAt,
        last_rejected_at: r.lastRejectedAt,
        openings: r.openings,
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
    schema: { tags: ['aggregator'], querystring: ExportQuery },
    handler: async (request: ExportRequest, reply: FastifyReply) => {
      const acting = request.acting_org;
      if (!acting || acting.org_type !== 'aggregator') {
        return reply.code(403).send({
          error: 'NOT_AGGREGATOR',
          message: 'caller must act on behalf of an aggregator org',
        });
      }

      const configured = await read_configured_domains(acting.org_id);
      if (!configured || configured.length === 0) {
        return reply.code(400).send({
          error: 'NO_DOMAINS_CONFIGURED',
          message:
            'org.metadata.domains is empty — re-upsert with domains array',
        });
      }

      const { domain: requested_domain, status } = request.query;
      let scope = configured;
      if (requested_domain) {
        if (!configured.includes(requested_domain)) {
          return reply.code(400).send({
            error: 'DOMAIN_NOT_CONFIGURED',
            message: `?domain=${requested_domain} is not in org.metadata.domains`,
          });
        }
        scope = [requested_domain];
      }

      // Parallel per-domain staleness — refresh anything stale before
      // streaming. Each (org, domain) takes its own advisory lock.
      await Promise.all(
        scope.map((d) => check_and_refresh_if_stale(acting.org_id, d)),
      );

      const filename = `participants_${acting.org_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${filename}"`,
        );

      return reply.send(
        Readable.from(generate_csv(acting.org_id, scope, status)),
      );
    },
  });
};

export default aggregator_export;
