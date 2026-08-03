/**
 * Client-credentials service auth: resolving a Keycloak service-account token
 * to the integrating DPG's existing service `user` row (§5 of
 * docs/superpowers/plans/2026-07-23-keycloak-migration-design.md).
 *
 * This is the bearer-token replacement for `verifyApiKey`. It changes only how
 * the caller is *identified* — `request.user` comes out the same shape, and
 * `x-acting-org-id` is untouched, because acting-org is orthogonal to
 * authentication. Everything downstream (`acting_org.ts`, the admin routes)
 * cannot tell which credential was used.
 *
 * **The mapping is by convention: Keycloak client id == `organization.slug`.**
 * The service org, its service user and their `member` row already exist —
 * `scripts/seed_service_users.ts` creates them, and the design keeps them
 * local and authoritative (§6.4). So there is no new table and no new claim
 * mapper; the client id is simply looked up as a slug.
 *
 * The resolution is deliberately strict, and fails closed at every step:
 *
 *   - the client must be listed in `KEYCLOAK_SERVICE_CLIENT_IDS`;
 *   - the org must exist and be a type allowed to hold a service identity;
 *   - the org must have a member with `role='service'`.
 *
 * That last one matters. Falling back to "any member of the org" would let a
 * client-credentials token bind to a *human* member's identity, and that human
 * may own domain data. An unseeded service org is an operator error worth
 * failing loudly, not something to paper over.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import {
  member as memberTable,
  organization as organizationTable,
  user as userTable,
} from '@api/db/postgres/schema/auth';
import { keycloakConfig } from '@/config';
import type { KeycloakClaims } from '@/utils/keycloak_token';

/** Org types permitted to own a service identity — mirrors acting_org.ts. */
const SERVICE_ORG_TYPES = ['network_service', 'aggregator', 'voice'];

/** The `member.role` that marks the org's machine identity (see the seed). */
const SERVICE_MEMBER_ROLE = 'service';

export interface ServiceIdentity {
  id: string;
  email: string;
  name: string;
  role?: string | null;
}

export type ServiceAccountErrorCode =
  /** Token has no client id claim — not actually a client-credentials token. */
  | 'SERVICE_CLIENT_UNKNOWN'
  /** Client is not in KEYCLOAK_SERVICE_CLIENT_IDS. */
  | 'SERVICE_CLIENT_NOT_ALLOWED'
  /** No service org / service user seeded for this client. */
  | 'SERVICE_ACCOUNT_NOT_PROVISIONED'
  | 'SERVICE_ACCOUNT_LOOKUP_FAILED';

export type ServiceAccountResult =
  | { ok: true; user: ServiceIdentity }
  | { ok: false; code: ServiceAccountErrorCode; message: string };

/**
 * The client id a service-account token was issued to.
 *
 * Keycloak puts it in `client_id` on client-credentials tokens and in `azp`
 * on all of them; `preferred_username` is the `service-account-<clientId>`
 * fallback for realms that strip the others.
 */
export function serviceClientId(claims: KeycloakClaims): string | null {
  if (typeof claims.client_id === 'string' && claims.client_id) return claims.client_id;
  if (typeof claims.azp === 'string' && claims.azp) return claims.azp;
  if (
    typeof claims.preferred_username === 'string' &&
    claims.preferred_username.startsWith('service-account-')
  ) {
    const derived = claims.preferred_username.slice('service-account-'.length);
    return derived || null;
  }
  return null;
}

export async function resolveServiceAccount(
  claims: KeycloakClaims,
  log: FastifyBaseLogger
): Promise<ServiceAccountResult> {
  const clientId = serviceClientId(claims);

  if (!clientId) {
    return {
      ok: false,
      code: 'SERVICE_CLIENT_UNKNOWN',
      message: 'Token does not identify a client',
    };
  }

  if (!keycloakConfig.service_client_ids.includes(clientId)) {
    // Reached by e.g. the `signals-api` service account, which exists for
    // Admin-REST provisioning and is not an integrating DPG.
    log.warn(
      { client_id: clientId },
      'service auth: client is not allowlisted for service access',
    );
    return {
      ok: false,
      code: 'SERVICE_CLIENT_NOT_ALLOWED',
      message: 'This client is not permitted to call the Signals Stack as a service',
    };
  }

  try {
    const [row] = await db
      .select({
        userId: userTable.id,
        email: userTable.email,
        name: userTable.name,
        role: userTable.role,
        orgType: organizationTable.type,
      })
      .from(organizationTable)
      .innerJoin(
        memberTable,
        and(
          eq(memberTable.organizationId, organizationTable.id),
          eq(memberTable.role, SERVICE_MEMBER_ROLE),
        ),
      )
      .innerJoin(userTable, eq(userTable.id, memberTable.userId))
      .where(eq(organizationTable.slug, clientId))
      .limit(1);

    if (!row) {
      log.error(
        { client_id: clientId },
        'service auth: no service user found for client — is the org seeded ' +
          'with a slug matching the Keycloak client id, and a member with ' +
          "role='service'?",
      );
      return {
        ok: false,
        code: 'SERVICE_ACCOUNT_NOT_PROVISIONED',
        message: 'No service account is provisioned for this client',
      };
    }

    if (!row.orgType || !SERVICE_ORG_TYPES.includes(row.orgType)) {
      log.error(
        { client_id: clientId, org_type: row.orgType },
        'service auth: org matching this client is not a service org type',
      );
      return {
        ok: false,
        code: 'SERVICE_ACCOUNT_NOT_PROVISIONED',
        message: 'No service account is provisioned for this client',
      };
    }

    return {
      ok: true,
      user: {
        id: row.userId,
        email: row.email ?? '',
        name: row.name,
        role: row.role,
      },
    };
  } catch (err) {
    log.error({ err, client_id: clientId }, 'service auth: lookup failed');
    return {
      ok: false,
      code: 'SERVICE_ACCOUNT_LOOKUP_FAILED',
      message: 'Could not resolve the service account',
    };
  }
}
