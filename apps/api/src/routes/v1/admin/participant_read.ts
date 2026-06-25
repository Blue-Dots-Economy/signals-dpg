import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import z, {
  GetParticipantRequest as GetParticipantRequestSchema,
  GetParticipantResponse,
  type GetParticipantRequest as GetParticipantQueryType,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/**
 * GET /api/v1/admin/participant
 *
 * Read-only lookup endpoint for both network_service and aggregator acting orgs.
 * Accepts email or phone_number (mutually optional at request level, one required
 * via schema refine). Returns user_id and items if found, filtered by org ownership.
 *
 * For network_service: returns user_id + all items if user exists.
 * For aggregator: returns user_id + items only if user was onboarded by this aggregator,
 *                otherwise returns items: [].
 * For either tier: returns { user_id: null } if user not found.
 */

type GetParticipantRequestType = FastifyRequest<{ Querystring: GetParticipantQueryType }>;

export const participant_read: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'GET',
    schema: {
      tags: ['admin'],
      querystring: GetParticipantRequestSchema,
      response: { 200: GetParticipantResponse },
    },
    handler: participant_read_handler,
  });
};

export const participant_read_handler = async (
  request: GetParticipantRequestType,
  reply: FastifyReply,
) => {
  const body = request.query;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  // Stored phone numbers are canonical E.164 ("+91..."). Callers may send the
  // number without the leading "+" (e.g. "919876543210"), so prepend it before
  // the exact-match lookup; otherwise an existing user would silently miss.
  const phone_trimmed = body.phone_number?.trim();
  const phone_norm = phone_trimmed
    ? phone_trimmed.startsWith('+')
      ? phone_trimmed
      : `+${phone_trimmed}`
    : null;

  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  if (!request.acting_org) {
    return reply.code(403).send({
      error: 'INVALID_ACTING_ORG',
      message: 'acting_org is required for /admin/participant',
    });
  }

  if (
    request.acting_org.org_type !== 'aggregator' &&
    request.acting_org.org_type !== 'network_service'
  ) {
    return reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: 'only aggregator or network_service acting orgs are allowed',
    });
  }

  // Look up existing user
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const existingRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  const existing = existingRows[0] ?? null;

  // User not found
  if (!existing) {
    return reply.code(200).send({
      user_id: null,
      items: [],
    });
  }

  // User exists — check ownership rules
  const acting_org_id = request.acting_org.org_id;
  let itemsList: Awaited<ReturnType<typeof readItemsForUser>> = [];

  if (request.acting_org.org_type === 'aggregator') {
    const isOwn = existing.onboardedByOrgId === acting_org_id;
    if (isOwn) {
      itemsList = await readItemsForUser(existing.id);
    }
    // If not owned by this aggregator, itemsList remains []
  } else {
    // network_service can always read items
    itemsList = await readItemsForUser(existing.id);
  }

  return reply.code(200).send({
    user_id: existing.id,
    items: itemsList,
  });
};

// --- helpers ---

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

async function readItemsForUser(user_id: string) {
  const networks = servedNetworks();
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_state: items.item_state,
      item_locations: items.item_locations,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
    })
    .from(items)
    .where(
      networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(items.created_at);

  return rows.map((r) => {
    const { item_private_state: _drop, ...rest } = r;
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return {
      ...rest,
      item_state: mergedState,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });
}

export default participant_read;
