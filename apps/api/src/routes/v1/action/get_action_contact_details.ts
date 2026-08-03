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

  // Fetch the masked (public) view of the counterparty first. It always exists
  // locally and carries lifecycle_status; private state is only decrypted later
  // (a second fetch) once we know a reveal is allowed. Retired items are
  // included here (the owner-list exclusion is opt-in) so we can message the
  // counterparty rather than 404/500.
  const maskedResult = await fetchLocalItems({
    item_id: other.id,
    item_network: other.network,
    item_domain: other.domain,
    item_type: other.type,
    item_instance_url: other.instance_url,
    limit: 1,
    offset: 0,
    includePrivateState: false,
  });

  const [maskedItem] = maskedResult.items;
  if (!maskedItem) {
    return reply.code(404).send({
      error: 'OTHER_ITEM_NOT_FOUND',
      message: 'Other-actor item missing locally despite same instance',
    });
  }

  const normalizeDates = <T extends { created_at: unknown; updated_at: unknown }>(item: T) => ({
    ...item,
    created_at: item.created_at instanceof Date ? item.created_at : new Date(item.created_at as string),
    updated_at: item.updated_at instanceof Date ? item.updated_at : new Date(item.updated_at as string),
  });

  // Counterparty retired their profile (#347): PII is wiped and the connection
  // was cancelled. Short-circuit to a clear "retired" state (masked public
  // view, revealed:false) instead of the PII_NOT_REVEALED / error path — this
  // must run BEFORE the reveal-status gate, since the action is now cancelled.
  if (maskedItem.lifecycle_status === 'retired') {
    reply.header('Cache-Control', 'no-store');
    return reply.code(200).send({
      action_id: action.action_id,
      action_status: action.action_status,
      revealed: false,
      reveal_blocked_reason: 'retired',
      other_actor: { item: normalizeDates(maskedItem) },
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

  // Gate: caller's own item must be live. The target is always local (this is the target side);
  // gating the source is only possible when it is also local.
  const callerItem = callerIsSource
    ? {
        item_network: action.source_item_network,
        item_domain: action.source_item_domain,
        item_type: action.source_item_type,
        item_id: action.source_item_id,
        item_instance_url: action.source_item_instance_url,
      }
    : {
        item_network: action.target_item_network,
        item_domain: action.target_item_domain,
        item_type: action.target_item_type,
        item_id: action.target_item_id,
        item_instance_url: action.target_item_instance_url,
      };

  const callerSnapshot = await fetchLocalItemSnapshot(db, callerItem);
  // A null snapshot (caller item not local) is treated as live — the gate can
  // only apply to a locally-resolvable profile.
  const callerLive = callerSnapshot ? callerSnapshot.lifecycle_status === 'live' : true;

  const revealAllowed = callerLive && maskedItem.lifecycle_status === 'live';
  // Why the reveal is blocked, so the client can say whose profile is the
  // reason: `self` = the viewer's own profile isn't live (resume it to see
  // details); `other` = the counterparty's profile isn't live. Self takes
  // precedence — it's the one the viewer can act on.
  const revealBlockedReason: 'self' | 'other' | undefined = revealAllowed
    ? undefined
    : !callerLive
      ? 'self'
      : 'other';
  let otherItem = maskedItem;

  // Audit only an actual PII reveal — the masked view discloses nothing.
  if (revealAllowed) {
    const revealedResult = await fetchLocalItems({
      item_id: other.id,
      item_network: other.network,
      item_domain: other.domain,
      item_type: other.type,
      item_instance_url: other.instance_url,
      limit: 1,
      offset: 0,
      includePrivateState: true,
    });
    otherItem = revealedResult.items[0] ?? maskedItem;
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
  }

  reply.header('Cache-Control', 'no-store');
  return reply.code(200).send({
    action_id: action.action_id,
    action_status: action.action_status,
    revealed: revealAllowed,
    reveal_blocked_reason: revealBlockedReason,
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
