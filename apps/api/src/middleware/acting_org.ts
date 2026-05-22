import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization, member } from '../../db/postgres/schema/auth.js';

const ALLOWED_ORG_TYPES = ['aggregator', 'voice', 'network_service'] as const;
type AllowedOrgType = (typeof ALLOWED_ORG_TYPES)[number];

const get_header_value = (raw: string | string[] | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Fastify preHandler that resolves the acting org for a request.
 *
 * Reads the `x-acting-org-id` header and the apikey-bound user (set upstream
 * by the apikey auth path), validates that the org exists and is one of the
 * types allowed to be asserted as an acting org (`aggregator` | `voice` |
 * `network_service`), and that the service user is a registered member of
 * some org in Signals. On success, attaches `request.acting_org` and resolves.
 *
 * Each error branch responds via the reply and returns early; the request
 * lifecycle is terminated by Fastify when the reply is sent.
 *
 * The signature is declared as a plain async function (rather than typed via
 * Fastify's `preHandlerAsyncHookHandler`) so unit tests can invoke it without
 * binding a FastifyInstance `this`. The runtime shape still satisfies the
 * Fastify preHandler contract.
 */
export const acting_org_preHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const acting_org_id = get_header_value(
    request.headers['x-acting-org-id'] as string | string[] | undefined,
  );
  if (!acting_org_id) {
    reply.code(400).send({
      error: 'MISSING_ACTING_ORG',
      message: 'x-acting-org-id header is required',
    });
    return;
  }

  const service_user_id = (request.user as { id?: string } | undefined)?.id;
  if (!service_user_id) {
    reply.code(401).send({
      error: 'UNAUTHENTICATED',
      message: 'service apikey is required',
    });
    return;
  }

  const org_rows = await db
    .select({ id: organization.id, type: organization.type })
    .from(organization)
    .where(eq(organization.id, acting_org_id))
    .limit(1);
  const org_row = org_rows[0];

  if (!org_row) {
    reply.code(404).send({
      error: 'ACTING_ORG_NOT_FOUND',
      message: `org ${acting_org_id} does not exist`,
    });
    return;
  }

  const org_type_raw = org_row.type;
  if (
    org_type_raw === null ||
    org_type_raw === undefined ||
    !(ALLOWED_ORG_TYPES as readonly string[]).includes(org_type_raw)
  ) {
    reply.code(403).send({
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
      message: `org type ${org_type_raw} cannot be asserted as acting org`,
    });
    return;
  }

  const member_rows = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, service_user_id))
    .limit(1);

  if (member_rows.length === 0) {
    reply.code(403).send({
      error: 'SERVICE_USER_NOT_REGISTERED',
      message: 'service user is not a member of any org',
    });
    return;
  }

  request.acting_org = {
    org_id: org_row.id,
    org_type: org_type_raw as AllowedOrgType,
    service_user_id,
  };
};
