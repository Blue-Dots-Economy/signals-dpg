import z, {
  FetchItemsQuerySchema,
  ItemResponseSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { fetchLocalItems } from '@/utils/item_fetch_runtime';
import { getCachedLocalItemFetch } from '@/utils/item_fetch_cache';

type FetchItemsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchItemsQuerySchema>;
}>;

export const fetch_items: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      query: FetchItemsQuerySchema,
      response: {
        200: z.object({
          meta: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          items: ItemResponseSchema.array(),
        }),
      },
    },
    handler: fetch_items_handler as any,
  });
};

export const fetch_item = fetch_items;

const fetch_items_handler = async (
  request: FetchItemsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;
  const {
    item_id,
    item_network,
    item_type,
    item_domain,
    item_instance_url,
    item_schema_url,
    item_state,
    item_latitude,
    item_longitude,
    radius_meters,
    limit,
    offset,
  } = request.query;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch items',
    });
  }

  if (!isServedDomainBinding(item_network, item_domain)) {
    return await replyForUnservedDomain(reply, item_network, item_domain);
  }

  try {
    const filters = {
      item_id,
      item_network,
      item_type,
      item_domain,
      created_by: userId,
      item_instance_url,
      item_schema_url,
      item_state,
      item_latitude,
      item_longitude,
      radius_meters,
      limit,
      offset,
      includePrivateState: true,
    };
    const result = await getCachedLocalItemFetch(filters, () =>
      fetchLocalItems(filters)
    );

    return reply.code(200).send(normalizeFetchItemsResponse(result));
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch items');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch items',
    });
  }
};

function normalizeFetchItemsResponse(
  response: Awaited<ReturnType<typeof fetchLocalItems>>
) {
  return {
    ...response,
    items: response.items.map((item) => ({
      ...item,
      created_at:
        item.created_at instanceof Date
          ? item.created_at
          : new Date(item.created_at),
      updated_at:
        item.updated_at instanceof Date
          ? item.updated_at
          : new Date(item.updated_at),
    })),
  };
}
