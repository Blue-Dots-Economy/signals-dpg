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

    // Resolve a public display name (via display_name_field) for every source
    // + target item on the page. Private-name handling / consent gating lives
    // elsewhere — this route just surfaces the value as-is.
    const nameById = await resolveItemNames(rows);

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
        source_item_name: nameById.get(row.source_item_id) ?? null,
        target_item_name: nameById.get(row.target_item_id) ?? null,
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

/**
 * Batch-resolves a public display name for every source + target item on the
 * page using each item's `display_name_field` (via resolve_display_name).
 * One `items` query for the whole batch; network config lookups memoised.
 * Items without a public display name are simply absent from the map (the UI
 * shows a role-based fallback). Private-name handling lives elsewhere.
 */
async function resolveItemNames(
  rows: ActionRow[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
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
    const name = resolve_display_name({
      schema: schema ?? {},
      item_state: (item.item_state ?? null) as Record<string, unknown> | null,
      item_id: item.item_id,
    });
    if (name !== item.item_id) result.set(item.item_id, name);
  }

  return result;
}
