import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { FastifyReply, FastifyRequest } from 'fastify';
import z from '@dpg/schemas';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { fetchLocalItems } from '@/utils/item_fetch_runtime';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';

const AdminListItemsQuerySchema = z.object({
  aggregator_id: z.string().uuid().optional(),
  item_network: z.string().min(1),
  item_domain: z.string().min(1),
  item_type: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type AdminListItemsRequest = FastifyRequest<{
  Querystring: z.infer<typeof AdminListItemsQuerySchema>;
}>;

export const list_items: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    method: 'GET',
    url: '/items',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['admin'],
      querystring: AdminListItemsQuerySchema,
    },
    handler: list_items_handler,
  });
};

export const list_items_handler = async (
  request: AdminListItemsRequest,
  reply: FastifyReply
) => {
  if (request.user?.role !== 'admin') {
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'Admin role required',
    });
  }

  const {
    aggregator_id,
    item_network,
    item_domain,
    item_type,
    limit,
    offset,
  } = request.query;

  if (!isServedDomainBinding(item_network, item_domain)) {
    return await replyForUnservedDomain(reply, item_network, item_domain);
  }

  try {
    const result = await fetchLocalItems({
      item_network,
      item_domain,
      item_type,
      aggregator_id,
      limit,
      offset,
      includePrivateState: false,
    });
    return reply.code(200).send(result);
  } catch (err) {
    request.log.error(
      { err, query: request.query },
      'Admin list_items failed'
    );
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to list items',
    });
  }
};
