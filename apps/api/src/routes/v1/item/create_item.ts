import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
  BulkCreateItemResponseSchema,
  BulkRequestErrorSchema,
} from '@dpg/schemas';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { createItemInternal, ItemServiceError } from '@/services/item_service';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';
import { apiConfig } from '@/config';

const BulkCreateItemBodySchema = z.array(z.unknown());

type CreateItemRequest = FastifyRequest<{ Body: unknown[] }>;

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: BulkCreateItemBodySchema,
      response: {
        201: BulkCreateItemResponseSchema,
        207: BulkCreateItemResponseSchema,
        422: BulkCreateItemResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: create_item_handler,
  });
};

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply,
) => {
  const callerId = request.user?.id;
  const callerRole = request.user?.role;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  // Admin-on-behalf-of is reserved for api-key callers (see prior single-item
  // contract). Resolved once per request; created_by stays per-element.
  const isApiKeyCaller = Boolean(request.headers['x-api-key']);
  const isAdminApiCaller = isApiKeyCaller && callerRole === 'admin';

  const outcome = await runBulk(
    request.body,
    async (raw, index) => {
      const parsed = CreateItemBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      if (!isAdminApiCaller && body.created_by) {
        throw new BulkItemFailure(
          'FORBIDDEN_CREATED_BY',
          'created_by may only be set by an admin api-key caller',
        );
      }
      if (isAdminApiCaller && !body.created_by) {
        throw new BulkItemFailure(
          'CREATED_BY_REQUIRED',
          'created_by is required when an admin api-key creates an item',
        );
      }
      const userId = isAdminApiCaller ? (body.created_by as string) : callerId;

      if (!isServedDomainBinding(body.item_network, body.item_domain)) {
        throw new BulkItemFailure(
          'UNSERVED_DOMAIN_BINDING',
          `This API instance does not serve "${body.item_network}/${body.item_domain}".`,
        );
      }

      try {
        await ensureItemPartition(db, body.item_network, body.item_domain);
      } catch (err) {
        request.log.error(
          { err, item_network: body.item_network, item_domain: body.item_domain },
          'Failed to ensure item partition',
        );
        throw new BulkItemFailure(
          'PARTITION_SETUP_FAILED',
          'Failed to prepare storage for item type',
        );
      }

      try {
        const created = await createItemInternal(db, {
          item_network: body.item_network,
          item_domain: body.item_domain,
          item_type: body.item_type,
          item_state: body.item_state ?? {},
          item_latitude: body.item_latitude ?? null,
          item_longitude: body.item_longitude ?? null,
          created_by: userId,
        });

        await invalidateItemFetchCache(body.item_network, body.item_domain).catch((err) =>
          request.log.warn({ err }, 'cache invalidation after create failed'),
        );

        return { item_id: created.itemId, item_type: created.itemType };
      } catch (err) {
        if (err instanceof ItemServiceError) {
          throw new BulkItemFailure(err.errorCode, err.message);
        }
        if (err instanceof DrizzleQueryError && err.cause instanceof DatabaseError) {
          if (err.cause.code === '23505') {
            throw new BulkItemFailure(
              'ITEM_ALREADY_EXISTS',
              'An item with the same type and id already exists',
            );
          }
          if (err.cause.code === '23503') {
            throw new BulkItemFailure(
              'INVALID_REFERENCE',
              'One or more referenced entities do not exist, including the authenticated user',
            );
          }
        }
        request.log.error({ err, index }, 'Failed to create item');
        throw new BulkItemFailure('INTERNAL_SERVER_ERROR', 'Failed to create item');
      }
    },
    {
      okStatus: 201,
      maxItems: apiConfig.bulk_max_items,
      onUnexpectedError: (err, index) =>
        request.log.error({ err, index }, 'bulk create item unexpected error'),
    },
  );

  if (outcome.requestError) {
    return reply.code(400).send({
      error: outcome.requestError.code,
      message: outcome.requestError.message,
    });
  }

  return reply.code(outcome.httpStatus!).send({
    results: outcome.results,
    summary: outcome.summary,
  });
};
