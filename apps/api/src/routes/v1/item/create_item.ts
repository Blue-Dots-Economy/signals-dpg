import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, { CreateItemBodySchema } from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError, eq } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { createItemInternal, ItemServiceError } from '@/services/item_service';
import { user } from '@api/db/postgres/schema/auth';

type CreateItemRequest = FastifyRequest<{
  Body: z.infer<typeof CreateItemBodySchema>;
}>;

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: CreateItemBodySchema,
      response: {
        201: z.object({
          item_type: z.string(),
          item_id: z.string(),
        }),
      },
    },
    handler: create_item_handler,
  });
};

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply
) => {
  const callerId = request.user?.id;
  const callerRole = request.user?.role;
  const body = request.body;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  // The "admin acting on behalf of another user" flow is reserved for
  // server-to-server callers identified by an api-key. UI sessions — even
  // when the logged-in user happens to carry an admin role — should behave
  // like a normal user and own the items they create. Distinguishing on
  // the api-key header keeps that contract explicit and avoids confusing
  // signed-in admins with a CREATED_BY_REQUIRED error when they create
  // their own profile.
  const isApiKeyCaller = Boolean(request.headers['x-api-key']);
  const isAdminApiCaller = isApiKeyCaller && callerRole === 'admin';

  if (!isAdminApiCaller && body.created_by) {
    return reply.code(403).send({
      error: 'FORBIDDEN_CREATED_BY',
      message: 'created_by may only be set by an admin api-key caller',
    });
  }

  if (isAdminApiCaller && !body.created_by) {
    return reply.code(400).send({
      error: 'CREATED_BY_REQUIRED',
      message: 'created_by is required when an admin api-key creates an item',
    });
  }

  const userId = isAdminApiCaller ? (body.created_by as string) : callerId;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  // Membership check: user.domains is a text[] of "network/domain". A user
  // can hold only one domain per network (app-enforced). Reject creates
  // when this network is absent from the user's domains, and reject when
  // present under a different domain. Admin api-key callers bypass —
  // they're acting on behalf of the user with explicit intent.
  if (!isAdminApiCaller) {
    const userRows = await db
      .select({ domains: user.domains })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    const userDomains = userRows[0]?.domains ?? [];
    const networkPrefix = `${body.item_network}/`;
    const matched = userDomains.find((d) => d.startsWith(networkPrefix));
    const requestedBinding = `${body.item_network}/${body.item_domain}`;

    if (!matched) {
      return reply.code(403).send({
        error: 'NO_NETWORK_MEMBERSHIP',
        message: `user is not a member of network "${body.item_network}"`,
      });
    }
    if (matched !== requestedBinding) {
      const registeredDomain = matched.slice(networkPrefix.length);
      return reply.code(403).send({
        error: 'DOMAIN_MISMATCH',
        message: `user is registered as "${registeredDomain}" in "${body.item_network}"; cannot create items under "${body.item_domain}"`,
        registered_domain: registeredDomain,
        requested_domain: body.item_domain,
      });
    }
  }

  try {
    await ensureItemPartition(
      db,
      body.item_network,
      body.item_domain
    );
  } catch (err) {
    request.log.error(
      {
        err,
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
      },
      'Failed to ensure item partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for item type',
    });
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

    return reply.code(201).send({
      item_type: created.itemType,
      item_id: created.itemId,
    });
  } catch (err) {
    if (err instanceof ItemServiceError) {
      return reply.code(err.statusCode).send({
        error: err.errorCode,
        message: err.message,
      });
    }
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;

      if (cause instanceof DatabaseError) {
        // 23505 = unique_violation (fallback safety)
        if (cause.code === '23505') {
          return reply.code(409).send({
            error: 'ITEM_ALREADY_EXISTS',
            message: 'An item with the same type and id already exists',
          });
        }

        // 23503 = foreign_key_violation
        if (cause.code === '23503') {
          return reply.code(400).send({
            error: 'INVALID_REFERENCE',
            message:
              'One or more referenced entities do not exist, including the authenticated user',
          });
        }
      }
    }

    request.log.error({ err, body }, 'Failed to create item');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to create item',
    });
  }
};
