import { and, desc, eq, or, sql } from 'drizzle-orm';
import { action_events } from '@dpg/database';
import z, {
  FetchOwnedEventsQuerySchema,
  OwnedActionEventSchema,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { db } from '@api/db/postgres/drizzle_config';

type FetchOwnedEventsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedEventsQuerySchema>;
}>;

const FetchOwnedEventsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  events: OwnedActionEventSchema.array(),
});

export const fetch_events: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['event'],
      query: FetchOwnedEventsQuerySchema,
      response: {
        200: FetchOwnedEventsResponseSchema,
      },
    },
    handler: fetch_events_handler,
  });
};

const fetch_events_handler = async (
  request: FetchOwnedEventsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch events',
    });
  }

  const {
    action_id,
    action_type,
    action_status,
    item_id,
    update_count,
    ownership_role,
    limit,
    offset,
  } = request.query;

  const conditions = [];

  if (action_id) {
    conditions.push(eq(action_events.action_id, action_id));
  }

  if (action_type) {
    conditions.push(eq(action_events.action_type, action_type));
  }

  if (action_status) {
    conditions.push(eq(action_events.action_status, action_status));
  }

  if (update_count !== undefined) {
    conditions.push(eq(action_events.update_count, update_count));
  }

  if (item_id) {
    if (ownership_role === 'initiated') {
      conditions.push(eq(action_events.source_item_id, item_id));
    } else if (ownership_role === 'received') {
      conditions.push(eq(action_events.target_item_id, item_id));
    } else {
      conditions.push(
        or(
          eq(action_events.source_item_id, item_id),
          eq(action_events.target_item_id, item_id)
        )
      );
    }
  }

  if (ownership_role === 'initiated') {
    conditions.push(eq(action_events.source_item_owner, userId));
  } else if (ownership_role === 'received') {
    conditions.push(eq(action_events.target_item_owner, userId));
  } else {
    conditions.push(
      or(
        eq(action_events.source_item_owner, userId),
        eq(action_events.target_item_owner, userId)
      )
    );
  }

  const whereClause = conditions.length ? and(...conditions) : undefined;

  try {
    const [{ count }] = await db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(action_events)
      .where(whereClause);

    const rows = await db
      .select()
      .from(action_events)
      .where(whereClause)
      .orderBy(desc(action_events.created_at))
      .limit(limit)
      .offset(offset);

    return reply.code(200).send({
      meta: {
        total: Number(count),
        limit,
        offset,
      },
      events: rows.map((row) => ({
        ...row,
        created_at:
          row.created_at instanceof Date
            ? row.created_at
            : new Date(row.created_at),
        ownership_roles: [
          ...(row.source_item_owner === userId ? (['initiated'] as const) : []),
          ...(row.target_item_owner === userId ? (['received'] as const) : []),
        ],
      })),
    });
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch events');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch events',
    });
  }
};
