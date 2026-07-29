import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, {
  FetchOwnedActionsQuerySchema,
  OwnedItemActionSchema,
  getInteractionPiiRevealStatuses,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigById } from '@/network_configs';
import { resolve_display_name } from '@/services/metrics/resolve_display_name';
import { decryptItemPrivate } from '@/utils/item_decrypt';

type FetchOwnedActionsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedActionsQuerySchema>;
}>;

const FetchOwnedActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  actions: OwnedItemActionSchema.array(),
});

export const fetch_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      query: FetchOwnedActionsQuerySchema,
      response: {
        200: FetchOwnedActionsResponseSchema,
      },
    },
    handler: fetch_actions_handler,
  });
};

const fetch_actions_handler = async (
  request: FetchOwnedActionsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch actions',
    });
  }

  const {
    action_id,
    action_type,
    action_status,
    item_id,
    ownership_role,
    limit,
    offset,
  } = request.query;

  const conditions = [];

  if (action_id) conditions.push(eq(item_actions.action_id, action_id));
  if (action_type) conditions.push(eq(item_actions.action_type, action_type));
  if (action_status) conditions.push(eq(item_actions.action_status, action_status));

  if (item_id) {
    if (ownership_role === 'initiated') {
      conditions.push(eq(item_actions.source_item_id, item_id));
    } else if (ownership_role === 'received') {
      conditions.push(eq(item_actions.target_item_id, item_id));
    } else {
      conditions.push(
        or(
          eq(item_actions.source_item_id, item_id),
          eq(item_actions.target_item_id, item_id)
        )
      );
    }
  }

  if (ownership_role === 'initiated') {
    conditions.push(eq(item_actions.source_item_owner, userId));
  } else if (ownership_role === 'received') {
    conditions.push(eq(item_actions.target_item_owner, userId));
  } else {
    conditions.push(
      or(
        eq(item_actions.source_item_owner, userId),
        eq(item_actions.target_item_owner, userId)
      )
    );
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(item_actions)
      .where(whereClause);

    const rows = await db
      .select()
      .from(item_actions)
      .where(whereClause)
      .orderBy(desc(item_actions.updated_at), desc(item_actions.created_at))
      .limit(limit)
      .offset(offset);

    // Resolve a name for every source + target item on the page:
    // - Public display_name_field (e.g. provider organisation_name) → returned
    //   as-is, never masked.
    // - Private name (e.g. seeker beneficiary_name) → the schema-aware mask
    //   already lives in item_state (written via maskPrivateState at item
    //   create time, e.g. "M***"). Per-action consent gating happens below:
    //   reveal the real value only when action_status is in the network's
    //   schema-declared reveals_pii_on_status for this interaction; otherwise
    //   the already-masked value is used.
    const resolvedNames = await resolveItemNames(rows);

    // Pre-resolve reveals_pii_on_status per action row. Mirrors the gate used
    // by /api/v1/action/:id/contact-details so the list view never reveals a
    // status the contact-detail reveal would refuse. Resolution failures fall
    // back to an empty set (mask), matching the contact-details fail-closed
    // posture.
    const networkConfigCache = new Map<
      string,
      Awaited<ReturnType<typeof getNetworkConfigById>> | null
    >();
    const getNetworkConfigCached = async (network: string) => {
      if (networkConfigCache.has(network)) {
        return networkConfigCache.get(network) ?? null;
      }
      try {
        const cfg = await getNetworkConfigById(network);
        networkConfigCache.set(network, cfg);
        return cfg;
      } catch {
        networkConfigCache.set(network, null);
        return null;
      }
    };
    const revealStatusesByAction = new Map<string, readonly string[]>();
    for (const row of rows) {
      if (revealStatusesByAction.has(row.action_id)) continue;
      let statuses: readonly string[] = [];
      try {
        const cfg = await getNetworkConfigCached(row.target_item_network);
        if (cfg) {
          statuses = getInteractionPiiRevealStatuses(cfg, {
            actionType: row.action_type,
            fromNetwork: row.source_item_network,
            fromDomain: row.source_item_domain,
            fromItemType: row.source_item_type,
            toNetwork: row.target_item_network,
            toDomain: row.target_item_domain,
            toItemType: row.target_item_type,
          });
        }
      } catch (err) {
        request.log.warn(
          { err, action_id: row.action_id, action_type: row.action_type },
          'pii reveal-status resolution failed in fetch_actions — defaulting to masked',
        );
      }
      revealStatusesByAction.set(row.action_id, statuses);
    }
    // Memoise decrypts per item — the same item can appear on multiple rows
    // (source on one action, target on another) and we only want to pay the
    // crypto cost once per page.
    const unmaskedCache = new Map<string, string | null>();
    const unmask = (id: string): string | null => {
      if (unmaskedCache.has(id)) return unmaskedCache.get(id) ?? null;
      const entry = resolvedNames.get(id);
      if (!entry || entry.kind !== 'private') {
        unmaskedCache.set(id, null);
        return null;
      }
      let value: string | null = null;
      try {
        const { mergedState } = decryptItemPrivate({
          item_state: entry.publicState,
          item_private_state: entry.encrypted,
        });
        const raw = mergedState[entry.fieldName];
        if (typeof raw === 'string' && raw.trim().length > 0) value = raw.trim();
      } catch (err) {
        request.log.warn(
          { err, item_id: id, field: entry.fieldName },
          'pii decrypt failed in fetch_actions — falling back to mask',
        );
      }
      unmaskedCache.set(id, value);
      return value;
    };

    const displayName = (
      id: string,
      actionId: string,
      status: string,
    ): string | null => {
      const entry = resolvedNames.get(id);
      if (!entry) return null;
      if (entry.kind === 'public') return entry.value;
      // Private field: schema-aware mask sits in item_state already; reveal
      // the real value only when this action's status is in the network's
      // schema-declared reveals_pii_on_status AND the named profile is live.
      // A paused/draft profile keeps its name masked even on an accepted
      // action — mirrors the contact-details reveal gate (#273).
      const revealStatuses = revealStatusesByAction.get(actionId) ?? [];
      if (revealStatuses.includes(status) && entry.lifecycle_status === 'live') {
        return unmask(id) ?? entry.masked;
      }
      return entry.masked;
    };

    return reply.code(200).send({
      meta: { total: Number(count), limit, offset },
      actions: rows.map((row) => ({
        ...row,
        created_at:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(row.created_at),
        updated_at:
          row.updated_at instanceof Date
            ? row.updated_at
            : new Date(row.updated_at),
        source_item_name: displayName(
          row.source_item_id,
          row.action_id,
          row.action_status,
        ),
        target_item_name: displayName(
          row.target_item_id,
          row.action_id,
          row.action_status,
        ),
        ownership_roles: [
          ...(row.source_item_owner === userId ? (['initiated'] as const) : []),
          ...(row.target_item_owner === userId ? (['received'] as const) : []),
        ],
      })),
    });
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch actions');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch actions',
    });
  }
};

type ActionRow = {
  source_item_id: string;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  target_item_id: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
};

type ResolvedName =
  | { kind: 'public'; value: string }
  | {
      kind: 'private';
      masked: string;
      fieldName: string;
      encrypted: string;
      publicState: Record<string, unknown>;
      // Reveal the real name only when this item is live. A paused/draft
      // profile keeps its name masked even on an accepted action (#273).
      lifecycle_status: string;
    };

// Conventional name properties to surface when an item schema declares no
// public `display_name_field`. The schema-aware mask in
// packages/schemas/item_state_masking applies to these at item-create time,
// so item_state already carries the masked value (e.g. "M***").
const PRIVATE_NAME_FIELDS = [
  'beneficiary_name',
  'full_name',
  'name',
  'contact_name',
];

/**
 * Batch-resolves a display name for every source + target item on the page in
 * one `items` query. Returns either a public name (rendered as-is) or a
 * private-name reference carrying the masked value + the encrypted blob, so
 * the handler can lazily decrypt only the rows whose action_status warrants a
 * reveal. Items with no resolvable name are absent from the map; UI then
 * renders the role-based fallback.
 */
async function resolveItemNames(
  rows: ActionRow[]
): Promise<Map<string, ResolvedName>> {
  const result = new Map<string, ResolvedName>();
  if (rows.length === 0) return result;

  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.source_item_id);
    ids.add(r.target_item_id);
  }

  const itemRows = await db
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
    .where(inArray(items.item_id, [...ids]));

  const configCache = new Map<
    string,
    Awaited<ReturnType<typeof getNetworkConfigById>> | null
  >();
  const getConfig = async (network: string) => {
    if (configCache.has(network)) return configCache.get(network) ?? null;
    try {
      const cfg = await getNetworkConfigById(network);
      configCache.set(network, cfg);
      return cfg;
    } catch {
      configCache.set(network, null);
      return null;
    }
  };

  for (const item of itemRows) {
    const cfg = await getConfig(item.item_network);
    const domain = cfg?.domains.find((d) => d.id === item.item_domain);
    const schema = domain?.item_schemas?.[item.item_type] as
      | { display_name_field?: string; properties?: Record<string, unknown> }
      | undefined;
    const publicState = (item.item_state ?? {}) as Record<string, unknown>;

    // 1. Public display name (provider org name etc.). Never masked.
    const publicName = resolve_display_name({
      schema: schema ?? {},
      item_state: publicState,
      item_id: item.item_id,
    });
    if (publicName !== item.item_id) {
      result.set(item.item_id, { kind: 'public', value: publicName });
      continue;
    }

    // 2. Private name — pulled from item_state, where maskPrivateState has
    //    already pre-masked private fields (e.g. "M***"). Keep a reference to
    //    the encrypted blob so the handler can reveal post-accept.
    let masked: string | null = null;
    let fieldName: string | null = null;
    for (const f of PRIVATE_NAME_FIELDS) {
      const v = publicState[f];
      if (typeof v === 'string' && v.trim().length > 0) {
        masked = v.trim();
        fieldName = f;
        break;
      }
    }
    if (!masked || !fieldName) continue;

    const encrypted = item.item_private_state;
    if (typeof encrypted !== 'string' || encrypted.length === 0) {
      // No ciphertext (legacy row?) — surface the masked value only.
      result.set(item.item_id, {
        kind: 'private',
        masked,
        fieldName,
        encrypted: '',
        publicState,
        lifecycle_status: item.lifecycle_status,
      });
      continue;
    }
    result.set(item.item_id, {
      kind: 'private',
      masked,
      fieldName,
      encrypted,
      publicState,
      lifecycle_status: item.lifecycle_status,
    });
  }

  return result;
}
