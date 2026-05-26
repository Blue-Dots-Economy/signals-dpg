import type {
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { Readable } from 'node:stream';
import { db } from '@api/db/postgres/drizzle_config';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { organization } from '../../../../db/postgres/schema/auth.js';
import { eq, and, inArray, asc, getTableColumns } from 'drizzle-orm';
import { ExportQuery, type ExportQuery as ExportQueryType } from '@dpg/schemas';
import { check_and_refresh_if_stale } from '@/services/metrics/staleness';

const COLUMNS = [
  'item_network',
  'item_domain',
  'item_type',
  'name',
  'onboarded_via',
  'profile_status',
  'profile_completion_pct',
  'profile_created_at',
  'profile_last_updated_at',
  'age_days',
  'count_create',
  'count_accept',
  'count_reject',
  'count_cancel',
  'last_create_at',
  'last_accept_at',
  'last_reject_at',
  'last_cancel_at',
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
    return (meta.domains as unknown[]).filter((x): x is string => typeof x === 'string');
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
    const rows = await db
      .select(getTableColumns(item_metrics))
      .from(item_metrics)
      .where(where!)
      .orderBy(asc(item_metrics.itemDomain), asc(item_metrics.itemId))
      .limit(PAGE_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const r of rows) {
      const projected: Record<(typeof COLUMNS)[number], unknown> = {
        item_network: r.itemNetwork,
        item_domain: r.itemDomain,
        item_type: r.itemType,
        name: r.displayName,
        onboarded_via: r.onboardedVia,
        profile_status: r.profileStatus,
        profile_completion_pct: r.profileCompletionPct,
        profile_created_at: r.profileCreatedAt,
        profile_last_updated_at: r.profileLastUpdatedAt,
        age_days: r.ageDays,
        count_create: r.countCreate,
        count_accept: r.countAccept,
        count_reject: r.countReject,
        count_cancel: r.countCancel,
        last_create_at: r.lastCreateAt,
        last_accept_at: r.lastAcceptAt,
        last_reject_at: r.lastRejectAt,
        last_cancel_at: r.lastCancelAt,
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
          message: 'org.metadata.domains is empty — re-upsert with domains array',
        });
      }

      const { domain: requested_domain, status, refresh } = request.query;
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

      await Promise.all(
        scope.map((d) => check_and_refresh_if_stale(acting.org_id, d, refresh)),
      );

      const filename = `items_${acting.org_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`);

      return reply.send(Readable.from(generate_csv(acting.org_id, scope, status)));
    },
  });
};

export default aggregator_export;
