import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, { ExportActionsBodySchema, type NetworkConfigDocument } from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { bulk_export_audit } from '@api/db/postgres/schema';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { buildOwnedActionsWhere } from '@/services/actions/owned_actions';
import { buildExport, type ExportItem } from '@/services/action_export/build_export';
import { csvLine } from '@/services/action_export/csv';
import { buildExportFilename } from '@/services/action_export/filename';
import { formatIsoInZone } from '@/services/action_export/time';

/**
 * `POST /api/v1/action/export` (#770) — CSV of the caller's engagement
 * COUNTERPARTIES, one counterparty type per file. Thin I/O shell around
 * `buildExport`, which owns the export rules; this handler adds auth, item
 * ownership, the row cap, one-export-at-a-time, the audit row and the
 * response.
 *
 * The file is built in memory rather than streamed: the row cap bounds it,
 * and the row/skip counts must be sent as headers before the body.
 */

type ExportRequest = FastifyRequest<{ Body: z.infer<typeof ExportActionsBodySchema> }>;

// Per-process guard: bulk decrypt is expensive and the obvious scraping route.
// Best-effort across pods — each process enforces its own.
const inFlight = new Set<string>();

// Excel opens BOM-less UTF-8 CSV as a legacy code page, garbling non-Latin names.
const UTF8_BOM = '﻿';

export const export_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/export',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      description:
        'Download the counterparty profiles of the caller’s engagements as CSV (text/csv). ' +
        'One counterparty type per file; private fields are revealed per row under the same ' +
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
  if (inFlight.has(userId)) {
    return reply.code(429).send({
      error: 'EXPORT_IN_PROGRESS',
      message: 'An export is already running for this user; try again when it finishes',
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

async function runExport(
  request: ExportRequest,
  reply: FastifyReply,
  userId: string,
  started: number
) {
  const { filters, projection, include, format } = request.body;

  // Same loud ownership check as fetch_actions: a foreign or missing item_id
  // gets an identical 403, never an empty-but-200 file.
  if (filters.item_id) {
    const [owned] = await db
      .select({ created_by: items.created_by })
      .from(items)
      .where(eq(items.item_id, filters.item_id))
      .limit(1);
    if (owned?.created_by !== userId) {
      return reply.code(403).send({
        error: 'FORBIDDEN_ITEM',
        message: 'item_id is not owned by the caller',
      });
    }
  }

  const maxRows = apiConfig.export_max_rows;
  const rows = await db
    .select()
    .from(item_actions)
    .where(
      buildOwnedActionsWhere(userId, {
        action_ids: filters.action_ids,
        action_type: filters.action_type,
        action_status: filters.action_status,
        item_id: filters.item_id,
        ownership_role: filters.ownership_role,
        updated_from: filters.updated_from,
        updated_to: filters.updated_to,
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

  // Resolve every network config up front so buildExport stays synchronous.
  const networks = new Set<string>([
    ...rows.map((r) => r.target_item_network),
    ...itemRows.map((it) => it.item_network),
  ]);
  const configs = new Map<string, NetworkConfigDocument | null>();
  for (const network of networks) {
    try {
      configs.set(network, await getNetworkConfigById(network));
    } catch (err) {
      request.log.warn({ err, network }, 'network config unavailable for export — rows not exportable');
      configs.set(network, null);
    }
  }

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
    await db.insert(bulk_export_audit).values({
      exportId,
      requesterUserId: userId,
      requesterItemId: filters.item_id ?? null,
      filters,
      projection,
      format,
      rowCount: counts.row_count,
      revealedCount: counts.revealed_count,
      maskedCount: counts.masked_count,
      skippedCrossInstance: counts.skipped_cross_instance,
      skippedMissing: counts.skipped_missing,
      skippedSelf: counts.skipped_self,
      skippedNotEnabled: counts.skipped_not_enabled,
    });
  } catch (err) {
    request.log.error(
      { err, operation: 'action.export', status: 'failure', export_id: exportId },
      'Failed to write bulk_export_audit row — export refused'
    );
    return reply.code(500).send({
      error: 'EXPORT_AUDIT_FAILED',
      message: 'The export could not be recorded, so it was not served',
    });
  }

  // Dates, filename and generated-at in EXPORT_TIMEZONE (default IST), each
  // with its offset. The audit row stays in UTC.
  const timeZone = apiConfig.export_timezone;
  const formatDate = (d: Date) => formatIsoInZone(d, timeZone);
  const body =
    UTF8_BOM +
    csvLine(result.header, formatDate) +
    result.records.map((rec) => csvLine(rec, formatDate)).join('');
  const filename = buildExportFilename({
    network: result.counterparty?.network,
    counterpartyDomain: result.counterparty?.domain,
    statuses: filters.action_status,
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
