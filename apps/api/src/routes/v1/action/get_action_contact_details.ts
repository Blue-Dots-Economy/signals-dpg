import { eq } from 'drizzle-orm';
import z, {
  ActionContactDetailsParamsSchema,
  ActionContactDetailsResponseSchema,
  getInteractionPiiRevealStatuses,
} from '@dpg/schemas';
import { item_actions } from '@dpg/database';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { pii_reveal_audit } from '@api/db/postgres/schema';
import { getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import { fetchLocalItems } from '@/utils/item_fetch_runtime';
import { fetchLocalItemSnapshot } from '@/utils/action_event_runtime';

type Params = z.infer<typeof ActionContactDetailsParamsSchema>;

type Req = FastifyRequest<{ Params: Params }>;

export const get_action_contact_details: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/:action_id/contact-details',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      params: ActionContactDetailsParamsSchema,
      response: {
        200: ActionContactDetailsResponseSchema,
      },
    },
    handler: get_action_contact_details_handler,
  });
};

export const get_action_contact_details_handler = async (
  request: Req,
  reply: FastifyReply
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const { action_id } = request.params;

  const [action] = await db
    .select()
    .from(item_actions)
    .where(eq(item_actions.action_id, action_id))
    .limit(1);

  if (!action) {
    return reply.code(404).send({
      error: 'ACTION_NOT_FOUND',
      message: 'Action does not exist on this instance',
    });
  }

  const callerIsSource = action.source_item_owner === userId;
  const callerIsTarget = action.target_item_owner === userId;
  if (!callerIsSource && !callerIsTarget) {
    return reply.code(403).send({
      error: 'NOT_ACTION_PARTICIPANT',
      message: 'Caller is not a participant in this action',
    });
  }

  let revealStatuses: readonly string[];
  try {
    const networkConfig = await getNetworkConfigById(action.target_item_network);
    revealStatuses = getInteractionPiiRevealStatuses(networkConfig, {
      actionType: action.action_type,
      fromNetwork: action.source_item_network,
      fromDomain: action.source_item_domain,
      fromItemType: action.source_item_type,
      toNetwork: action.target_item_network,
      toDomain: action.target_item_domain,
      toItemType: action.target_item_type,
    });
  } catch (err) {
    request.log.error({ err, action_id }, 'Failed to resolve interaction for reveal');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to resolve action interaction',
    });
  }

  if (!revealStatuses.includes(action.action_status)) {
    return reply.code(403).send({
      error: 'PII_NOT_REVEALED',
      message: 'Contact details are not currently available for this action',
    });
  }

  // Spec §12 — reveal requires BOTH endpoints to be 'live' at read time.
  // The caller's side is always local on this instance (contact-details
  // is routed to the actor's home instance); the other side is local iff
  // its instance_url matches getCurrentApiBaseUrl. Remote-other gating is
  // documented as a residual gap (see spec §10/§12 cross-instance notes).
  const callerSnap = await fetchLocalItemSnapshot(db, {
    item_network: callerIsSource ? action.source_item_network : action.target_item_network,
    item_domain: callerIsSource ? action.source_item_domain : action.target_item_domain,
    item_type: callerIsSource ? action.source_item_type : action.target_item_type,
    item_id: callerIsSource ? action.source_item_id : action.target_item_id,
    item_instance_url: callerIsSource ? action.source_item_instance_url : action.target_item_instance_url,
  });
  if (callerSnap && callerSnap.lifecycle_status !== 'live') {
    return reply.code(403).send({
      error: 'PROFILE_NOT_LIVE',
      message: 'Contact details hidden because your own profile is not live',
    });
  }

  const other = callerIsSource
    ? {
        network: action.target_item_network,
        domain: action.target_item_domain,
        type: action.target_item_type,
        id: action.target_item_id,
        instance_url: action.target_item_instance_url,
        owner: action.target_item_owner,
      }
    : {
        network: action.source_item_network,
        domain: action.source_item_domain,
        type: action.source_item_type,
        id: action.source_item_id,
        instance_url: action.source_item_instance_url,
        owner: action.source_item_owner,
      };

  if (other.instance_url !== getCurrentApiBaseUrl()) {
    return reply.code(501).send({
      error: 'CROSS_INSTANCE_REVEAL_NOT_SUPPORTED',
      message: 'Cross-instance contact-detail reveal is not yet supported',
    });
  }

  const result = await fetchLocalItems({
    item_id: other.id,
    item_network: other.network,
    item_domain: other.domain,
    item_type: other.type,
    item_instance_url: other.instance_url,
    limit: 1,
    offset: 0,
    includePrivateState: true,
  });

  const [otherItem] = result.items;
  if (!otherItem) {
    return reply.code(404).send({
      error: 'OTHER_ITEM_NOT_FOUND',
      message: 'Other-actor item missing locally despite same instance',
    });
  }

  const otherLifecycle = (otherItem as { lifecycle_status?: string })
    .lifecycle_status;
  if (otherLifecycle && otherLifecycle !== 'live') {
    return reply.code(403).send({
      error: 'PROFILE_NOT_LIVE',
      message:
        'Contact details hidden because the other actor profile is not live',
    });
  }

  try {
    await db.insert(pii_reveal_audit).values({
      actionId: action.action_id,
      viewerUserId: userId,
      revealedItemId: other.id,
      revealedItemOwner: other.owner ?? otherItem.created_by ?? '',
      revealedActionType: action.action_type,
      revealedActionStatusAtView: action.action_status,
    });
  } catch (err) {
    request.log.error(
      { err, action_id, viewer_user_id: userId, revealed_item_id: other.id },
      'Failed to write pii_reveal_audit row'
    );
  }

  reply.header('Cache-Control', 'no-store');
  return reply.code(200).send({
    action_id: action.action_id,
    action_status: action.action_status,
    other_actor: {
      item: {
        ...otherItem,
        created_at:
          otherItem.created_at instanceof Date
            ? otherItem.created_at
            : new Date(otherItem.created_at),
        updated_at:
          otherItem.updated_at instanceof Date
            ? otherItem.updated_at
            : new Date(otherItem.updated_at),
      },
    },
  });
};
