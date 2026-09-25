import { randomUUID } from 'node:crypto';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, {
  ExportActionsBodySchema,
  getExportableStatuses,
  type NetworkConfigDocument,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { bulk_export_audit, pii_reveal_audit } from '@api/db/postgres/schema';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { incrWithinWindow } from '@/utils/rate_window';
import { csvLine } from '@/utils/csv';
import { buildOwnedActionsWhere } from '@/services/actions/owned_actions';
import {
  buildExport,
  type ExportCounts,
  type ExportItem,
  type ExportReveal,
} from '@/services/action_export/build_export';
import { buildExportFilename } from '@/services/action_export/filename';
import { formatIsoInZone } from '@/services/action_export/time';

/**
 * `POST /api/v1/action/export` (#770) — CSV of the caller's engagement
 * COUNTERPARTIES, one counterparty type per file. Thin I/O shell around
 * `buildExport`, which owns the per-row export rules; this handler enforces
 * everything that needs I/O, so no rule depends on the UI:
 *
 * - human callers only (service credentials are refused),
 * - one export at a time per process + a per-user hourly limit across pods,
 * - item ownership, the requester's exportable statuses and domain,
 * - the row cap, and a fail-closed audit (download + one row per reveal).
 *
 * The file is built in memory rather than streamed: the row cap bounds it,
 * and the row/skip counts must be sent as headers before the body.
 */

type ExportRequest = FastifyRequest<{ Body: z.infer<typeof ExportActionsBodySchema> }>;

// Per-process guard against parallel exports by one user; the Redis window
// below is the cross-pod limit.
const inFlight = new Set<string>();

// Excel opens BOM-less UTF-8 CSV as a legacy code page, garbling non-Latin names.
const UTF8_BOM = '﻿';
const RATE_WINDOW_SEC = 3600;
// Keeps each pii_reveal_audit INSERT well under Postgres' 65535-parameter cap.
const REVEAL_AUDIT_BATCH = 1000;

export const export_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/export',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      description:
        'Download the counterparty profiles of the caller’s engagements as CSV (text/csv). ' +
        'Human session only. One counterparty type per file; only statuses the network ' +
        'reveals on are exportable, and private fields are revealed per row under the same ' +
        'gate as contact-details. Row and skip counts are in the X-Export-* response headers.',
      body: ExportActionsBodySchema,
    },
    handler: export_actions_handler,
  });
};

const export_actions_handler = async (request: ExportRequest, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to export actions',
    });
  }
  // An integrating DPG's service identity (x-api-key / client-credentials)
  // owns no engagements of its own; exporting on a provider's behalf is not
  // offered, so refuse it outright rather than serving an empty file.
  if (request.user?.role === 'service') {
    return reply.code(403).send({
      error: 'SERVICE_CALLER_NOT_ALLOWED',
      message: 'Bulk export is available to signed-in participants only',
    });
  }
  if (inFlight.has(userId)) {
    return reply.code(429).send({
      error: 'EXPORT_IN_PROGRESS',
      message: 'An export is already running for this user; try again when it finishes',
    });
  }

  // Cross-pod per-user limit. Fails CLOSED: this route bulk-decrypts PII, so
  // an unavailable limiter must not turn into an unlimited one.
  try {
    const used = await incrWithinWindow(`export:rl:${userId}`, RATE_WINDOW_SEC);
    if (used > apiConfig.export_rate_limit_per_hour) {
      return reply.code(429).send({
        error: 'EXPORT_RATE_LIMITED',
        message: 'Too many exports in the last hour; try again later',
      });
    }
  } catch (err) {
    request.log.error(
      { err, operation: 'action.export', status: 'failure' },
      'export rate-limit check unavailable — refusing export'
    );
    return reply.code(503).send({
      error: 'EXPORT_RATE_LIMIT_UNAVAILABLE',
      message: 'Export is temporarily unavailable; try again shortly',
    });
  }

  inFlight.add(userId);
  const started = Date.now();
  try {
    return await runExport(request, reply, userId, started);
  } catch (err) {
    request.log.error(
      { err, operation: 'action.export', status: 'failure', latency_ms: Date.now() - started },
      'Failed to export actions'
    );
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to export actions',
    });
  } finally {
    inFlight.delete(userId);
  }
};

/**
 * The caller's own profile the export is scoped to: `item_id` when given
 * (must be theirs), otherwise their first profile (one domain per user).
 */
async function resolveRequesterItem(userId: string, itemId: string | undefined) {
  const where = itemId ? eq(items.item_id, itemId) : eq(items.created_by, userId);
  const [row] = await db
    .select({
      item_id: items.item_id,
      created_by: items.created_by,
      item_network: items.item_network,
      item_domain: items.item_domain,
    })
    .from(items)
    .where(where)
    .orderBy(asc(items.created_at))
    .limit(1);
  return row;
}

async function runExport(
  request: ExportRequest,
  reply: FastifyReply,
  userId: string,
  started: number
) {
  const { filters, projection, include, format } = request.body;
  const maxRows = apiConfig.export_max_rows;

  if ((filters.action_ids?.length ?? 0) > maxRows) {
    return reply.code(413).send({
      error: 'EXPORT_TOO_LARGE',
      message: `At most ${maxRows} engagements can be exported at once`,
      details: { max_rows: maxRows },
    });
  }

  const scope = await resolveExportScope(request, userId);
  if (!scope.ok) return reply.code(scope.status).send(scope.body);
  const { requester, requesterConfig, statuses } = scope;

  const rows = await db
    .select()
    .from(item_actions)
    .where(
      buildOwnedActionsWhere(userId, {
        action_ids: filters.action_ids,
        action_type: filters.action_type,
        action_status: statuses,
        item_id: filters.item_id,
        ownership_role: filters.ownership_role,
        updated_from: filters.updated_from,
        updated_to: filters.updated_to,
        counterparty_domain: filters.counterparty_domain,
        counterparty_item_type: filters.counterparty_item_type,
      })
    )
    .orderBy(desc(item_actions.updated_at), desc(item_actions.created_at))
    .limit(maxRows + 1);

  if (rows.length > maxRows) {
    return reply.code(413).send({
      error: 'EXPORT_TOO_LARGE',
      message: `More than ${maxRows} engagements match; narrow the filters or selection`,
      details: { max_rows: maxRows },
    });
  }

  const itemIds = [...new Set(rows.flatMap((r) => [r.source_item_id, r.target_item_id]))];
  const itemRows = itemIds.length
    ? await db
        .select({
          item_id: items.item_id,
          item_network: items.item_network,
          item_domain: items.item_domain,
          item_type: items.item_type,
          item_state: items.item_state,
          item_private_state: items.item_private_state,
          lifecycle_status: items.lifecycle_status,
        })
        .from(items)
        .where(inArray(items.item_id, itemIds))
    : [];
  const itemMap = new Map<string, ExportItem>(
    itemRows.map((it) => [
      it.item_id,
      { ...it, item_state: (it.item_state ?? {}) as Record<string, unknown> },
    ])
  );

  const configs = await loadNetworkConfigs(
    request,
    [...rows.map((r) => r.target_item_network), ...itemRows.map((it) => it.item_network)],
    requester.item_network,
    requesterConfig
  );

  const result = buildExport({
    userId,
    currentInstanceUrl: getCurrentApiBaseUrl(),
    rows,
    items: itemMap,
    getNetworkConfig: (id) => configs.get(id) ?? null,
    filters,
    projection,
    include,
    decrypt: (it) =>
      decryptItemPrivate({ item_state: it.item_state, item_private_state: it.item_private_state })
        .mergedState,
    onDecryptError: (err, itemId) =>
      request.log.warn({ err, item_id: itemId }, 'pii decrypt failed in export — row exported masked'),
    onRuleError: (err, ref) =>
      request.log.warn({ err, ref }, 'export rule could not be resolved — treated as not exportable'),
  });

  if (!result.ok) {
    return reply.code(result.status).send({
      error: result.error,
      message: result.message,
      ...(result.details ? { details: result.details } : {}),
    });
  }

  const exportId = randomUUID();
  const now = new Date();
  const { counts } = result;

  // Fail closed: an export that cannot be audited is not served (#639 Q5).
  try {
    await writeExportAudit({
      exportId,
      userId,
      requesterItemId: filters.item_id ?? requester.item_id,
      filters: { ...filters, action_status: statuses },
      projection,
      format,
      counts,
      reveals: result.reveals,
    });
  } catch (err) {
    request.log.error(
      { err, operation: 'action.export', status: 'failure', export_id: exportId },
      'Failed to write export audit — export refused'
    );
    return reply.code(500).send({
      error: 'EXPORT_AUDIT_FAILED',
      message: 'The export could not be recorded, so it was not served',
    });
  }

  // Dates, filename and generated-at in EXPORT_TIMEZONE (default IST), each
  // with its offset. The audit rows stay in UTC.
  const timeZone = apiConfig.export_timezone;
  const formatDate = (d: Date) => formatIsoInZone(d, timeZone);
  const body =
    UTF8_BOM +
    csvLine(result.header, formatDate) +
    result.records.map((rec) => csvLine(rec, formatDate)).join('');
  const filename = buildExportFilename({
    network: result.counterparty?.network,
    counterpartyDomain: result.counterparty?.domain,
    statuses,
    exportId,
    now,
    timeZone,
  });

  request.log.info(
    {
      operation: 'action.export',
      status: 'success',
      export_id: exportId,
      latency_ms: Date.now() - started,
      counterparty_domain: result.counterparty?.domain,
      ...counts,
    },
    'engagement export served'
  );

  return reply
    .code(200)
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Cache-Control', 'no-store')
    .header('X-Export-Id', exportId)
    .header('X-Export-Generated-At', formatDate(now))
    .header('X-Export-Row-Count', String(counts.row_count))
    .header('X-Export-Skipped-Cross-Instance', String(counts.skipped_cross_instance))
    .header('X-Export-Skipped-Missing', String(counts.skipped_missing))
    .header('X-Export-Skipped-Self', String(counts.skipped_self))
    .header('X-Export-Skipped-Not-Enabled', String(counts.skipped_not_enabled))
    .send(body);
}

type ScopeResult =
  | {
      ok: true;
      requester: NonNullable<Awaited<ReturnType<typeof resolveRequesterItem>>>;
      requesterConfig: NetworkConfigDocument;
      statuses: string[];
    }
  | { ok: false; status: 400 | 403 | 500; body: Record<string, unknown> };

const NOT_ENABLED = {
  error: 'EXPORT_NOT_ENABLED',
  message: 'Bulk export is not enabled for your profile type',
};

/**
 * Who is exporting and which statuses they may export — all enforced here,
 * not in the UI. Same loud ownership check as fetch_actions (a foreign or
 * missing item_id is an identical 403). The exportable statuses come from
 * config (the reveal statuses of the interactions the requester's domain can
 * export); asking for anything else is refused rather than served masked.
 */
async function resolveExportScope(request: ExportRequest, userId: string): Promise<ScopeResult> {
  const { filters } = request.body;
  const requester = await resolveRequesterItem(userId, filters.item_id);
  if (filters.item_id && requester?.created_by !== userId) {
    return {
      ok: false,
      status: 403,
      body: { error: 'FORBIDDEN_ITEM', message: 'item_id is not owned by the caller' },
    };
  }
  if (!requester) return { ok: false, status: 403, body: NOT_ENABLED };

  let requesterConfig: NetworkConfigDocument;
  try {
    requesterConfig = await getNetworkConfigById(requester.item_network);
  } catch (err) {
    request.log.error({ err, network: requester.item_network }, 'network config unavailable for export');
    return {
      ok: false,
      status: 500,
      body: {
        error: 'NETWORK_CONFIG_UNAVAILABLE',
        message: 'A network configuration could not be loaded; try again shortly',
      },
    };
  }

  const exportable = getExportableStatuses(requesterConfig, requester.item_domain);
  if (exportable.length === 0) return { ok: false, status: 403, body: NOT_ENABLED };

  const notExportable = (filters.action_status ?? []).filter((s) => !exportable.includes(s));
  if (notExportable.length > 0) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'STATUS_NOT_EXPORTABLE',
        message: `Only these statuses can be exported: ${exportable.join(', ')}`,
        details: { not_exportable: notExportable, allowed: exportable },
      },
    };
  }
  const statuses = filters.action_status?.length ? filters.action_status : exportable;
  return { ok: true, requester, requesterConfig, statuses };
}

/**
 * Every network config the export touches, resolved up front so buildExport
 * stays synchronous. A failed load is recorded as null — buildExport turns
 * that into a 500, never a "not enabled".
 */
async function loadNetworkConfigs(
  request: ExportRequest,
  networkIds: readonly string[],
  knownId: string,
  knownConfig: NetworkConfigDocument
): Promise<Map<string, NetworkConfigDocument | null>> {
  const configs = new Map<string, NetworkConfigDocument | null>([[knownId, knownConfig]]);
  for (const network of new Set(networkIds)) {
    if (configs.has(network)) continue;
    try {
      configs.set(network, await getNetworkConfigById(network));
    } catch (err) {
      request.log.error({ err, network }, 'network config unavailable for export');
      configs.set(network, null);
    }
  }
  return configs;
}

/**
 * The download row and one pii_reveal_audit row per revealed counterparty,
 * in one transaction — both or neither — so "who has seen this person's
 * data" covers bulk exports exactly as it covers contact-details.
 *
 * @throws when the transaction fails; the caller refuses the export.
 */
async function writeExportAudit(input: {
  exportId: string;
  userId: string;
  requesterItemId: string;
  filters: Record<string, unknown>;
  projection: unknown;
  format: string;
  counts: ExportCounts;
  reveals: readonly ExportReveal[];
}): Promise<void> {
  const { counts } = input;
  await db.transaction(async (tx) => {
    await tx.insert(bulk_export_audit).values({
      exportId: input.exportId,
      requesterUserId: input.userId,
      requesterItemId: input.requesterItemId,
      filters: input.filters,
      projection: input.projection,
      format: input.format,
      rowCount: counts.row_count,
      revealedCount: counts.revealed_count,
      maskedCount: counts.masked_count,
      skippedCrossInstance: counts.skipped_cross_instance,
      skippedMissing: counts.skipped_missing,
      skippedSelf: counts.skipped_self,
      skippedNotEnabled: counts.skipped_not_enabled,
    });
    for (let i = 0; i < input.reveals.length; i += REVEAL_AUDIT_BATCH) {
      await tx
        .insert(pii_reveal_audit)
        .values(
          input.reveals.slice(i, i + REVEAL_AUDIT_BATCH).map((r) => revealAuditRow(r, input.userId))
        );
    }
  });
}

/** A per-subject reveal record, the same shape contact-details writes. */
function revealAuditRow(r: ExportReveal, viewerUserId: string) {
  return {
    actionId: r.action_id,
    viewerUserId,
    revealedItemId: r.item_id,
    revealedItemOwner: r.item_owner ?? '',
    revealedActionType: r.action_type,
    revealedActionStatusAtView: r.action_status,
  };
}
