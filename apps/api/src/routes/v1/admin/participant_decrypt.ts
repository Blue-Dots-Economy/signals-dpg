import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import {
  DecryptParticipantRequest as DecryptParticipantRequestSchema,
  DecryptParticipantResponse,
  type DecryptParticipantRequest as DecryptParticipantRequestType,
  type DecryptedProfileSnapshot,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { selectRequestedFields, type DomainContactContext } from '@/utils/contact_fields';

/**
 * POST /api/v1/admin/participant/decrypt
 *
 * Returns DECRYPTED profile item_state for a set of item_ids (now) or a
 * user_id (future UI). Ownership is keyed, in BOTH modes, on the always-present
 * `user.onboarded_by_org_id` of the item's creator (joined via
 * `items.created_by`) — NOT on `item_metrics`, which is a lazily-materialized
 * analytics cache (populated only when an aggregator views its dashboard/export)
 * and would silently drop items that have never been dashboarded.
 *  - aggregator: only items whose creator it onboarded.
 *  - network_service: all items in served networks.
 * Requested ids that are not found / not in a served network / not owned / fail
 * to decrypt land in `skipped` with no distinction (no existence leak).
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

const ITEM_COLUMNS = {
  item_id: items.item_id,
  item_network: items.item_network,
  item_domain: items.item_domain,
  item_type: items.item_type,
  item_state: items.item_state,
  item_private_state: items.item_private_state,
  created_at: items.created_at,
  updated_at: items.updated_at,
} as const;

// #237: the creator's account contact, selected alongside the item columns so
// canonical name/email/phone selection can fall back to it when the domain's
// item_state has no value for the mapped field (or no mapping at all).
const SELECT_COLUMNS = {
  ...ITEM_COLUMNS,
  user_name: user.name,
  user_email: user.email,
  user_phone: user.phoneNumber,
} as const;

type DecryptableRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: unknown;
  item_private_state: string;
  created_at: Date;
  updated_at: Date;
  user_name: string | null;
  user_email: string | null;
  user_phone: string | null;
};

/**
 * Decrypts one row to a snapshot, isolating failures: a corrupt or wrong-key
 * `item_private_state` returns null (the id is reported as skipped) instead of
 * throwing and 500-ing the whole batch.
 */
const toSnapshotSafe = (
  r: DecryptableRow,
  log: FastifyRequest['log'],
): DecryptedProfileSnapshot | null => {
  try {
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
  } catch (err) {
    log.error(
      { operation: 'admin.participant.decrypt.row_failed', item_id: r.item_id, err },
      'failed to decrypt item_private_state; excluding item from results',
    );
    return null;
  }
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
  const fields = body.fields;

  // #237: per-network config cache for the lifetime of this request — a batch
  // of item_ids commonly spans a handful of networks/domains, not one per row.
  const cfgCache = new Map<string, ReturnType<typeof getNetworkConfigById>>();
  const getCfg = (network: string) => {
    let cfg = cfgCache.get(network);
    if (!cfg) {
      cfg = getNetworkConfigById(network);
      cfgCache.set(network, cfg);
    }
    return cfg;
  };

  /** Resolves the per-row domain contact-field context (name fallback =
   * item-type display_name_field -> domain card.title_field). */
  const contextFor = async (r: DecryptableRow): Promise<DomainContactContext> => {
    const cfg = await getCfg(r.item_network);
    const domainCfg = cfg.domains.find((d) => d.id === r.item_domain);
    const schema = domainCfg?.item_schemas?.[r.item_type] as
      | { display_name_field?: unknown }
      | undefined;
    const nameFallbackField =
      (typeof schema?.display_name_field === 'string' ? schema.display_name_field : undefined) ??
      domainCfg?.card?.title_field;
    return {
      network: r.item_network,
      domain: r.item_domain,
      itemType: r.item_type,
      contactFields: domainCfg?.contact_fields,
      ...(nameFallbackField ? { nameFallbackField } : {}),
    };
  };

  /** When `fields` is requested, replaces the snapshot's item_state with the
   * resolver's filtered output; a no-op (byte-for-byte unchanged path)
   * otherwise. */
  const applyFieldSelection = async (
    snapshot: DecryptedProfileSnapshot,
    r: DecryptableRow,
  ): Promise<void> => {
    if (!fields) return;
    snapshot.item_state = selectRequestedFields(
      snapshot.item_state as Record<string, unknown>,
      { name: r.user_name, email: r.user_email, phone: r.user_phone },
      fields,
      await contextFor(r),
      request.log,
    );
  };

  const profiles: DecryptedProfileSnapshot[] = [];
  let skipped: string[] = [];
  let mode: 'item_ids' | 'user_id';

  if (body.item_ids) {
    mode = 'item_ids';
    const requested = Array.from(new Set(body.item_ids));
    const rows = (await db
      .select(SELECT_COLUMNS)
      .from(items)
      .innerJoin(user, eq(user.id, items.created_by))
      .where(
        and(
          inArray(items.item_id, requested),
          networks.length > 0 ? inArray(items.item_network, networks) : undefined,
          isAgg ? eq(user.onboardedByOrgId, acting.org_id) : undefined,
        ),
      )) as DecryptableRow[];

    for (const r of rows) {
      const snapshot = toSnapshotSafe(r, request.log);
      if (snapshot) {
        await applyFieldSelection(snapshot, r);
        profiles.push(snapshot);
      }
    }
    // Not found, not owned, not in a served network, OR failed to decrypt — all
    // land in skipped, undifferentiated, so the response never leaks existence.
    const found = new Set(profiles.map((p) => p.item_id));
    skipped = requested.filter((id) => !found.has(id));
  } else {
    mode = 'user_id';
    const userId = body.user_id!;
    const rows = (await db
      .select(SELECT_COLUMNS)
      .from(items)
      .innerJoin(user, eq(user.id, items.created_by))
      .where(
        and(
          eq(items.created_by, userId),
          networks.length > 0 ? inArray(items.item_network, networks) : undefined,
          isAgg ? eq(user.onboardedByOrgId, acting.org_id) : undefined,
        ),
      )
      .orderBy(items.created_at)) as DecryptableRow[];

    for (const r of rows) {
      const snapshot = toSnapshotSafe(r, request.log);
      if (snapshot) {
        await applyFieldSelection(snapshot, r);
        profiles.push(snapshot);
      } else {
        skipped.push(r.item_id);
      }
    }
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
    fields_requested: fields?.length,
  });

  return reply.code(200).send({ profiles, skipped });
};

export default participant_decrypt;
