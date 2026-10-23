import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { organization, member } from '../../db/postgres/schema/auth.js';
import { authConfig } from '@/config';
import { ACTING_ORG_WILDCARD } from '@/utils/keycloak_token';

const ALLOWED_ORG_TYPES = ['aggregator', 'network_service'] as const;
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
 * Reads `x-acting-org-id` (or, under claim enforcement, a single-org grant) and
 * the authenticated `request.user`. Checks the org is inside the token grant
 * when `ACTING_ORG_SOURCE` enforces it, exists, has an assertable type
 * (`aggregator` | `network_service`), and that the user is a member of some
 * org. On success attaches `request.acting_org`; otherwise sends an error
 * reply. It does not check which users the org may reach; routes do that.
 * Design: docs/architecture/api-middleware-acting-org-scope.md.
 *
 * A plain async function rather than `preHandlerAsyncHookHandler` so unit
 * tests can call it without binding a FastifyInstance `this`.
 */
export const acting_org_preHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  /**
   * The header selects the org in every mode; `ACTING_ORG_SOURCE` controls
   * whether it must fall inside the token's `signals_acting_orgs` grant.
   * An `undefined` grant means the token carried no claim; an empty grant
   * authorises nothing.
   */
  const grant = request.acting_org_grant;
  const grant_is_wildcard = grant?.includes(ACTING_ORG_WILDCARD) === true;

  if (authConfig.acting_org_claim_required && grant === undefined) {
    reply.code(403).send({
      error: 'ACTING_ORG_CLAIM_MISSING',
      message:
        'this token carries no acting-org grant; ACTING_ORG_SOURCE=claim_required',
    });
    return;
  }

  let acting_org_id = get_header_value(
    request.headers['x-acting-org-id'] as string | string[] | undefined,
  );

  // A grant naming exactly one org is unambiguous, so the header is optional.
  if (!acting_org_id && authConfig.acting_org_claim_enforced && grant?.length === 1 && !grant_is_wildcard) {
    acting_org_id = grant[0];
  }

  if (!acting_org_id) {
    reply.code(400).send({
      error: 'MISSING_ACTING_ORG',
      message: 'x-acting-org-id header is required',
    });
    return;
  }

  // Under claim enforcement, an asserted org outside the grant is refused.
  if (
    authConfig.acting_org_claim_enforced &&
    grant !== undefined &&
    !grant_is_wildcard &&
    !grant.includes(acting_org_id)
  ) {
    request.log.warn(
      { asserted_org_id: acting_org_id, grant },
      'acting-org assertion refused: outside the token grant',
    );
    reply.code(403).send({
      error: 'ACTING_ORG_NOT_GRANTED',
      message: `this token may not act for org ${acting_org_id}`,
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

  // Org-agnostic: this separates privilege tiers, not tenants. `member` rows
  // come from the service-user seed and from Keycloak provisioning of a token
  // whose grant names one org, so a participant without an org grant is
  // refused here. Tenant reach is decided downstream by the org's type.
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
