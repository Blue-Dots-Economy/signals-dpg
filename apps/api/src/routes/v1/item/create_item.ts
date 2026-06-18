import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError, and, eq } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition, items } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';
import { createItemInternal, ItemServiceError } from '@/services/item_service';
import { resolveLocationsForCreate } from '@/services/geocoding/resolve_locations_for_create';
import { resolveDomainLock } from './resolve_domain_lock';

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

  // Single-domain lock: a user may only create items in the one domain they
  // already hold within this network. The lock is derived live from the items
  // table (no membership column). Admin api-key callers bypass — they act on
  // behalf of a user with explicit intent. Empty set => not yet locked, so any
  // served domain is allowed; deleting all their items releases the lock.
  if (!isAdminApiCaller) {
    const heldRows = await db
      .selectDistinct({ item_domain: items.item_domain })
      .from(items)
      .where(
        and(
          eq(items.created_by, userId),
          eq(items.item_network, body.item_network),
        ),
      );

    const lock = resolveDomainLock(
      heldRows.map((r) => r.item_domain),
      body.item_domain,
    );

    if (!lock.allowed) {
      return reply.code(403).send({
        error: 'DOMAIN_LOCKED',
        message: `You are registered as "${lock.lockedDomain}" in "${body.item_network}" and cannot create items under "${body.item_domain}".`,
        locked_domain: lock.lockedDomain,
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

  // Backend geocoding: resolve coordinates from the schema's location field when
  // the client supplied none. Shared with the admin-participant onboarding path
  // (create_profile_item) so both store item_locations identically.
  const item_locations = await resolveLocationsForCreate({
    item_network: body.item_network,
    item_domain: body.item_domain,
    item_type: body.item_type,
    item_state: body.item_state ?? {},
    provided: body.item_locations,
    log: request.log,
  });

  try {
    const created = await createItemInternal(db, {
      item_network: body.item_network,
      item_domain: body.item_domain,
      item_type: body.item_type,
      item_state: body.item_state ?? {},
      item_locations,
      created_by: userId,
    });

    await publishItemEvent(
      {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_id: created.itemId,
        op: 'upsert',
      },
      request.log,
    );

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
