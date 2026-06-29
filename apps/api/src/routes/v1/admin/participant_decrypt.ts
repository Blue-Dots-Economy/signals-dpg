import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { item_metrics } from '../../../../db/postgres/schema/metrics.js';
import { user } from '../../../../db/postgres/schema/auth.js';
import {
  DecryptParticipantRequest as DecryptParticipantRequestSchema,
  DecryptParticipantResponse,
  type DecryptParticipantRequest as DecryptParticipantRequestType,
  type DecryptedProfileSnapshot,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/**
 * POST /api/v1/admin/participant/decrypt
 *
 * Returns DECRYPTED profile item_state for a set of item_ids (now) or a
 * user_id (future UI). Scoping:
 *  - aggregator: only items it onboarded survive (item_ids mode scopes on
 *    item_metrics.onboarded_by_org_id; user_id mode on user.onboarded_by_org_id).
 *  - network_service: all items.
 * Requested ids that are not found / not in a served network / not owned land
 * in `skipped` with no distinction (no existence leak).
 */

type DecryptRequestType = FastifyRequest<{ Body: DecryptParticipantRequestType }>;

export const participant_decrypt: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant/decrypt',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: DecryptParticipantRequestSchema,
      response: { 200: DecryptParticipantResponse },
    },
    handler: participant_decrypt_handler,
  });
};

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

type DecryptableRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: unknown;
  item_private_state: string;
  created_at: Date;
  updated_at: Date;
};

const toSnapshot = (r: DecryptableRow): DecryptedProfileSnapshot => {
  const { mergedState } = decryptItemPrivate({
    item_state: r.item_state as Record<string, unknown>,
    item_private_state: r.item_private_state,
  });
  return {
    item_id: r.item_id,
    item_network: r.item_network,
    item_domain: r.item_domain,
    item_type: r.item_type,
    item_state: mergedState,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
};

export const participant_decrypt_handler = async (
  request: DecryptRequestType,
  reply: FastifyReply,
) => {
  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant/decrypt',
    });
  }
  const acting = request.acting_org;
  if (acting.org_type !== 'aggregator' && acting.org_type !== 'network_service') {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service acting orgs are allowed',
    });
  }

  const isAgg = acting.org_type === 'aggregator';
  const networks = servedNetworks();
  const body = request.body;

  let profiles: DecryptedProfileSnapshot[] = [];
  let skipped: string[] = [];
  let mode: 'item_ids' | 'user_id';

  if (body.item_ids) {
    mode = 'item_ids';
    const requested = Array.from(new Set(body.item_ids));
    const rows = (await db
      .select({
        item_id: items.item_id,
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_state: items.item_state,
        item_private_state: items.item_private_state,
        created_at: items.created_at,
        updated_at: items.updated_at,
      })
      .from(items)
      .innerJoin(item_metrics, eq(item_metrics.itemId, items.item_id))
      .where(
        and(
          inArray(items.item_id, requested),
          networks.length > 0 ? inArray(items.item_network, networks) : undefined,
          isAgg ? eq(item_metrics.onboardedByOrgId, acting.org_id) : undefined,
        ),
      )) as DecryptableRow[];

    profiles = rows.map(toSnapshot);
    const found = new Set(profiles.map((p) => p.item_id));
    skipped = requested.filter((id) => !found.has(id));
  } else {
    mode = 'user_id';
    const userId = body.user_id!;
    const existingRows = await db
      .select({ id: user.id, onboardedByOrgId: user.onboardedByOrgId })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const existing = existingRows[0] ?? null;

    const entitled = existing !== null && (!isAgg || existing.onboardedByOrgId === acting.org_id);
    if (entitled) {
      const rows = (await db
        .select({
          item_id: items.item_id,
          item_network: items.item_network,
          item_domain: items.item_domain,
          item_type: items.item_type,
          item_state: items.item_state,
          item_private_state: items.item_private_state,
          created_at: items.created_at,
          updated_at: items.updated_at,
        })
        .from(items)
        .where(
          networks.length > 0
            ? and(eq(items.created_by, existing.id), inArray(items.item_network, networks))
            : eq(items.created_by, existing.id),
        )
        .orderBy(items.created_at)) as DecryptableRow[];
      profiles = rows.map(toSnapshot);
    }
    skipped = [];
  }

  // Audit: this endpoint returns decrypted PII to the caller, so every call is
  // recorded. The log entry itself carries counts only — never item_state values.
  request.log.info({
    operation: 'admin.participant.decrypt',
    acting_org_id: acting.org_id,
    org_type: acting.org_type,
    mode,
    requested_count: body.item_ids ? new Set(body.item_ids).size : 1,
    returned_count: profiles.length,
    skipped_count: skipped.length,
  });

  return reply.code(200).send({ profiles, skipped });
};

export default participant_decrypt;
