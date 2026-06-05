import { sql } from 'drizzle-orm';
import z, { MirrorActionRowBodySchema } from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureActionPartition, item_actions } from '@dpg/database';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';

/**
 * Public, server-to-server endpoint. The target instance (where an action is
 * authoritative) calls this on the source item's home instance to mirror the
 * item_actions row, so the initiator can read their own actions locally
 * instead of fanning out to peers.
 *
 * Upserts on the action's primary key. Fired on create and on every status
 * change, so a later update simply overwrites the earlier copy. A stale
 * (lower update_count) push is ignored to guard against out-of-order delivery.
 *
 * No auth: the caller is a trusted peer instance, the same model as
 * item fetch_local / count_local and the event mirror.
 */
type StoreLocalActionRequest = FastifyRequest<{
  Body: z.infer<typeof MirrorActionRowBodySchema>;
}>;

const StoreLocalActionResponseSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

export const store_local_action: FastifyPluginAsyncZod = async function (
  fastify
) {
  fastify.route({
    url: '/action/store_local',
    method: 'POST',
    schema: {
      tags: ['network'],
      body: MirrorActionRowBodySchema,
      response: {
        200: StoreLocalActionResponseSchema,
      },
    },
    handler: store_local_action_handler,
  });
};

export const store_local_action_handler = async (
  request: StoreLocalActionRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  // This instance is the source item's home; it must serve that binding.
  if (
    !isServedDomainBinding(body.source_item_network, body.source_item_domain)
  ) {
    return await replyForUnservedDomain(
      reply,
      body.source_item_network,
      body.source_item_domain
    );
  }

  try {
    await ensureActionPartition(db, body.partition_network, body.action_type);
  } catch (err) {
    request.log.error(
      { err, action_id: body.action_id, action_type: body.action_type },
      'Failed to ensure action partition for mirrored row'
    );
    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for mirrored action row',
    });
  }

  try {
    await db
      .insert(item_actions)
      .values({
        action_type: body.action_type,
        partition_network: body.partition_network,
        action_id: body.action_id,
        action_status: body.action_status,
        update_count: body.update_count,
        source_item_network: body.source_item_network,
        source_item_domain: body.source_item_domain,
        source_item_type: body.source_item_type,
        source_item_id: body.source_item_id,
        source_item_instance_url: body.source_item_instance_url,
        source_item_owner: body.source_item_owner ?? null,
        target_item_network: body.target_item_network,
        target_item_domain: body.target_item_domain,
        target_item_type: body.target_item_type,
        target_item_id: body.target_item_id,
        target_item_instance_url: body.target_item_instance_url,
        target_item_owner: body.target_item_owner ?? null,
        performed_by_org_id: body.performed_by_org_id ?? null,
        performed_by_service_user_id: body.performed_by_service_user_id ?? null,
        requirements_snapshot: body.requirements_snapshot,
        remarks: body.remarks ?? null,
        created_at: body.created_at,
        updated_at: body.updated_at,
      })
      .onConflictDoUpdate({
        target: [
          item_actions.partition_network,
          item_actions.action_type,
          item_actions.action_id,
        ],
        set: {
          action_status: body.action_status,
          update_count: body.update_count,
          source_item_owner: body.source_item_owner ?? null,
          target_item_owner: body.target_item_owner ?? null,
          requirements_snapshot: body.requirements_snapshot,
          remarks: body.remarks ?? null,
          updated_at: body.updated_at,
        },
        // Ignore stale, out-of-order pushes.
        setWhere: sql`${item_actions.update_count} <= ${body.update_count}`,
      });
  } catch (err) {
    request.log.error(
      { err, action_id: body.action_id },
      'Failed to upsert mirrored action row'
    );
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to store mirrored action row',
    });
  }

  return reply.code(200).send({
    action_id: body.action_id,
    action_type: body.action_type,
    action_status: body.action_status,
    update_count: body.update_count,
  });
};
