import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions, items } from '@dpg/database';
import z, {
  FetchOwnedActionsQuerySchema,
  OwnedItemActionSchema,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigById } from '@/network_configs';
import { resolve_display_name } from '@/services/metrics/resolve_display_name';

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

  if (action_id) {
    conditions.push(eq(item_actions.action_id, action_id));
  }

  if (action_type) {
    conditions.push(eq(item_actions.action_type, action_type));
  }

  if (action_status) {
    conditions.push(eq(item_actions.action_status, action_status));
  }

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
      .select({
        count: sql<number>`count(*)`,
      })
      .from(item_actions)
      .where(whereClause);

    const rows = await db
      .select()
      .from(item_actions)
      .where(whereClause)
      .orderBy(desc(item_actions.updated_at), desc(item_actions.created_at))
      .limit(limit)
      .offset(offset);

    // Resolve a display name for every source + target item on the page.
    // Public names (e.g. a provider's organisation_name) come back as-is.
    // Private names (e.g. a seeker's beneficiary_name, PII) come back with a
    // flag so we can mask them until the action is accepted.
    const nameById = await resolveItemNames(rows);

    // Once a connection is accepted/completed, both parties have consented to
    // the reveal, so the private counterparty name is shown unmasked.
    const isRevealed = (s: string) => s === 'accepted' || s === 'completed';
    const displayName = (id: string, actionStatus: string): string | null => {
      const entry = nameById.get(id);
      if (!entry) return null;
      if (entry.isPrivate && !isRevealed(actionStatus)) return maskName(entry.value);
      return entry.value;
    };

    return reply.code(200).send({
      meta: {
        total: Number(count),
        limit,
        offset,
      },
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
        source_item_name: displayName(row.source_item_id, row.action_status),
        target_item_name: displayName(row.target_item_id, row.action_status),
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

type ResolvedName = { value: string; isPrivate: boolean };

// Common name-bearing property keys to fall back on when a schema declares no
// public `display_name_field` (e.g. a seeker whose name is PII). Checked
// against the merged private state; any hit is flagged private so the caller
// masks it until the action is accepted.
const PRIVATE_NAME_FIELDS = [
  'beneficiary_name',
  'full_name',
  'name',
  'contact_name',
];

/** Mask a name for pre-acceptance display: keep the first 2 letters of each
 *  word, replace the rest with asterisks (capped) → "Ab**** Ga***". */
function maskName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) =>
      w.length <= 2 ? w : w.slice(0, 2) + '*'.repeat(Math.min(w.length - 2, 4))
    )
    .join(' ');
}

/**
 * Batch-resolves display names for every source + target item referenced by
 * the action rows. One `items` query for the whole page. A public
 * `display_name_field` (e.g. provider organisation_name) resolves to a clean
 * name. When absent, falls back to a private name field (seeker PII) flagged
 * `isPrivate` so the handler can mask it until the connection is accepted.
 * Network config lookups are memoised; best-effort on any failure.
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

    // 1. Public display name (provider org name etc.) — never masked.
    const publicName = resolve_display_name({
      schema: schema ?? {},
      item_state: publicState,
      item_id: item.item_id,
    });
    if (publicName !== item.item_id) {
      result.set(item.item_id, { value: publicName, isPrivate: false });
      continue;
    }

    // 2. Private name fallback (seeker PII) — flagged for masking.
    const merged = {
      ...publicState,
      ...((item.item_private_state ?? {}) as Record<string, unknown>),
    };
    let privateName: string | null = null;
    for (const field of PRIVATE_NAME_FIELDS) {
      const raw = merged[field];
      if (typeof raw === 'string' && raw.trim().length > 0) {
        privateName = raw.trim();
        break;
      }
    }
    if (privateName) {
      result.set(item.item_id, { value: privateName, isPrivate: true });
    }
  }

  return result;
}
