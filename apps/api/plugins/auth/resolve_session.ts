/**
 * Keycloak session resolution, shared by `auth_middleware.ts` and
 * `resolve_browser_session.ts`. Keycloak is the only identity provider.
 *
 * Bearer tokens are a service channel only (AUTH-VULN-03/04). A human token
 * presented in an `Authorization` header is refused however valid it is: a
 * browser session is the `sid` cookie, resolved by `resolve_browser_session.ts`,
 * which calls `resolveHumanSession` itself.
 *
 * A token that looks Keycloak-issued but fails validation is rejected with its
 * specific code ("expired", "wrong client") rather than a generic 401.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig, keycloakConfig } from '../../src/config';
import {
  actingOrgGrant,
  extractBearerToken,
  hasRealmRole,
  isServiceAccountToken,
  looksLikeKeycloakToken,
  realmRoles,
  verifyKeycloakToken,
  type KeycloakClaims,
  type KeycloakTokenErrorCode,
} from '../../src/utils/keycloak_token';
import { provisionUserFromClaims } from '../../src/services/auth/provisioning';
import type { ProvisioningErrorCode } from '../../src/services/auth/provisioning';
import { resolveServiceAccount } from '../../src/services/auth/service_account';
import type { ServiceAccountErrorCode } from '../../src/services/auth/service_account';

/** Shape every auth failure shares, matching the existing middleware replies. */
export interface AuthFailure {
  status: number;
  code: string;
  error: string;
  message: string;
}

/**
 * Token-validation failures.
 *
 * `KEYCLOAK_UNAVAILABLE` is a 503, not a 401: when Keycloak's JWKS is
 * unreachable we do not know whether the token is good, and answering 401
 * would tell every user their session died during someone else's outage.
 */
export const TOKEN_FAILURES: Record<KeycloakTokenErrorCode, AuthFailure> = {
  TOKEN_EXPIRED: {
    status: 401,
    code: 'TOKEN_EXPIRED',
    error: 'Unauthorized',
    message: 'Access token has expired',
  },
  TOKEN_INVALID: {
    status: 401,
    code: 'UNAUTHORIZED',
    error: 'Unauthorized',
    message: 'Missing or invalid authentication',
  },
  TOKEN_CLIENT_REJECTED: {
    status: 403,
    code: 'TOKEN_CLIENT_REJECTED',
    error: 'Forbidden',
    message: 'This token was not issued for the Signals Stack',
  },
  KEYCLOAK_UNAVAILABLE: {
    status: 503,
    code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    error: 'Service Unavailable',
    message: 'Could not reach the identity provider to verify the session',
  },
  KEYCLOAK_NOT_CONFIGURED: {
    status: 500,
    code: 'IDENTITY_PROVIDER_NOT_CONFIGURED',
    error: 'Internal Server Error',
    message: 'Keycloak is not configured on this instance',
  },
};

/** Provisioning failures. These are about the *account*, not the token. */
const PROVISIONING_FAILURES: Record<ProvisioningErrorCode, AuthFailure> = {
  LOGIN_CHANNEL_DISABLED: {
    status: 403,
    code: 'LOGIN_CHANNEL_DISABLED',
    error: 'Forbidden',
    message: 'Login channel disabled',
  },
  SELF_SIGNUP_DISABLED: {
    status: 403,
    code: 'SELF_SIGNUP_DISABLED',
    error: 'Forbidden',
    message: 'Self sign-up disabled',
  },
  USER_BANNED: {
    status: 403,
    code: 'USER_BANNED',
    error: 'Forbidden',
    message: 'Account suspended',
  },
  IDENTITY_CONFLICT: {
    status: 409,
    code: 'IDENTITY_CONFLICT',
    error: 'Conflict',
    message: 'Identity conflict',
  },
  NO_IDENTIFIER: {
    status: 403,
    code: 'NO_IDENTIFIER',
    error: 'Forbidden',
    message: 'Token carries no usable login identifier',
  },
  PROVISIONING_FAILED: {
    status: 500,
    code: 'PROVISIONING_FAILED',
    error: 'Internal Server Error',
    message: 'Could not resolve the local user record',
  },
};

/** Client-credentials (service) auth failures. */
const SERVICE_FAILURES: Record<ServiceAccountErrorCode, AuthFailure> = {
  SERVICE_CLIENT_UNKNOWN: {
    status: 401,
    code: 'SERVICE_CLIENT_UNKNOWN',
    error: 'Unauthorized',
    message: 'Token does not identify a client',
  },
  SERVICE_CLIENT_NOT_ALLOWED: {
    status: 403,
    code: 'SERVICE_CLIENT_NOT_ALLOWED',
    error: 'Forbidden',
    message: 'This client is not permitted to call the Signals Stack as a service',
  },
  SERVICE_ACCOUNT_NOT_PROVISIONED: {
    status: 403,
    code: 'SERVICE_ACCOUNT_NOT_PROVISIONED',
    error: 'Forbidden',
    message: 'No service account is provisioned for this client',
  },
  SERVICE_ACCOUNT_LOOKUP_FAILED: {
    status: 500,
    code: 'SERVICE_ACCOUNT_LOOKUP_FAILED',
    error: 'Internal Server Error',
    message: 'Could not resolve the service account',
  },
};

/**
 * A human token from a client that is only allowed on the service path (or the
 * reverse). Separate from TOKEN_CLIENT_REJECTED so logs distinguish "wrong
 * realm client" from "right client, wrong path".
 */
const WRONG_PATH_FOR_CLIENT: AuthFailure = {
  status: 403,
  code: 'TOKEN_CLIENT_REJECTED',
  error: 'Forbidden',
  message: 'This token was not issued for this kind of access',
};

/**
 * A human token presented as `Authorization: Bearer` (AUTH-VULN-03/04).
 *
 * Human sessions authenticate with the httpOnly `sid` cookie, which is worth
 * nothing while a script-readable credential is still accepted for the same
 * identity. A human client that cannot hold a cookie (e.g. a native app) needs
 * a channel of its own, not this one reopened.
 */
const BEARER_NOT_A_SESSION: AuthFailure = {
  status: 401,
  code: 'BEARER_SESSION_NOT_SUPPORTED',
  error: 'Unauthorized',
  message: 'User sessions authenticate with the session cookie, not a bearer token',
};

/**
 * A realm-valid token for an accepted client that carries none of the signals
 * realm roles (`KEYCLOAK_REQUIRED_REALM_ROLES`).
 *
 * The second gate around the shared realm. The client allowlist alone rests on
 * `azp`/`aud`, and an aggregator client given an `aud` mapper that names
 * `signals-ui` would satisfy it; a role the signals provisioning paths stamp and
 * aggregator's do not is not spoofable from the client side.
 */
const MISSING_REALM_ROLE: AuthFailure = {
  status: 403,
  code: 'TOKEN_ROLE_REJECTED',
  error: 'Forbidden',
  message: 'This account is not a participant of the Signals Stack',
};

/**
 * A realm-valid token that belongs to the aggregator portal, not to signals.
 *
 * Same rejection as `MISSING_REALM_ROLE`, but it names the account the caller is
 * signed in as: both apps share one realm, so an aggregator login leaves an SSO
 * session that Keycloak silently reuses here.
 *
 * Recognised positively from `aggregator_id` / the `org_owner` realm role, not
 * inferred from the absence of signals roles.
 */
const AGGREGATOR_ACCOUNT: AuthFailure = {
  status: 403,
  code: 'TOKEN_AGGREGATOR_ACCOUNT',
  error: 'Forbidden',
  message:
    'You are signed in as an aggregator account. Signals needs a participant account — sign in with a different account.',
};

export const UNAUTHORIZED: AuthFailure = {
  status: 401,
  code: 'UNAUTHORIZED',
  error: 'Unauthorized',
  message: 'Missing or invalid authentication',
};

export type SessionResolution =
  | { ok: true }
  /** Handled by the Keycloak path and failed — reply and stop. */
  | { ok: false; failure: AuthFailure }
  /** Not resolved here; the caller tries its next channel or answers 401. */
  | { ok: false; fallthrough: true };

/**
 * Resolve a service bearer token, populating `request.user` from the service
 * account on success. A request with no usable Keycloak token is
 * unauthenticated.
 *
 * The `keycloak_enabled` guard below is unreachable: `keycloak_enabled` is a
 * constant `true`.
 */
export async function resolveKeycloakSession(
  request: FastifyRequest
): Promise<SessionResolution> {
  if (!authConfig.keycloak_enabled) return { ok: false, fallthrough: true };

  const token = extractBearerToken(request.headers.authorization);

  if (!token || !looksLikeKeycloakToken(token)) {
    return { ok: false, failure: UNAUTHORIZED };
  }

  const verified = await verifyKeycloakToken(token);
  if (!verified.ok) {
    logTokenFailure(request, verified.code, verified.message);
    return { ok: false, failure: TOKEN_FAILURES[verified.code] };
  }

  /**
   * Only an integrating DPG's client-credentials token may authenticate with a
   * bearer token; a human token gets `BEARER_NOT_A_SESSION`.
   *
   * The fork is on `isServiceAccountToken`, not the client allowlist, so a
   * service token is never run through human provisioning.
   */
  if (!isServiceAccountToken(verified.claims)) {
    const azp = typeof verified.claims.azp === 'string' ? verified.claims.azp : null;
    request.log.warn(
      { azp },
      'rejected a user bearer token: user sessions authenticate with the session cookie'
    );
    return { ok: false, failure: BEARER_NOT_A_SESSION };
  }

  return resolveServiceSession(verified.claims, request);
}

function logTokenFailure(
  request: FastifyRequest,
  code: KeycloakTokenErrorCode,
  reason: string,
) {
  if (code === 'KEYCLOAK_UNAVAILABLE' || code === 'KEYCLOAK_NOT_CONFIGURED') {
    request.log.error({ code, reason }, 'keycloak token verification could not complete');
  } else {
    request.log.warn({ code, reason }, 'keycloak token rejected');
  }
}

/** Client-credentials path: an integrating DPG's service identity. */
async function resolveServiceSession(
  claims: KeycloakClaims,
  request: FastifyRequest,
): Promise<SessionResolution> {
  const service = await resolveServiceAccount(claims, request.log);
  if (!service.ok) {
    return { ok: false, failure: SERVICE_FAILURES[service.code] };
  }
  request.user = {
    id: service.user.id,
    email: service.user.email,
    name: service.user.name,
    role: service.user.role,
  };
  // Which integrating DPG this is: every service org is `network_service`, so
  // only the client id separates e.g. the voice bot from aggregator-dpg. Audit
  // only, never authorization. Bound onto the request logger so every later
  // line for this request carries it.
  request.service_client_id = service.client_id;
  request.log = request.log.child({ service_client_id: service.client_id });
  // Acting-org grant, enforced (or not) by acting_org.ts per ACTING_ORG_SOURCE.
  request.acting_org_grant = actingOrgGrant(claims);
  return { ok: true };
}

/**
 * Human path: named-client and realm-role gates, then the local user mirror.
 * Reached only from the cookie path (`resolve_browser_session.ts`).
 *
 * A missing `azp` is a rejection, not a pass: `verifyKeycloakToken` accepts on
 * an `aud` match alone, so a token with no `azp` would otherwise skip the client
 * check and reach provisioning unattributed. Keycloak always emits `azp`.
 */
export async function resolveHumanSession(
  claims: KeycloakClaims,
  request: FastifyRequest,
): Promise<SessionResolution> {
  const azp = typeof claims.azp === 'string' ? claims.azp : undefined;

  if (azp === undefined || !keycloakConfig.session_client_ids.includes(azp)) {
    request.log.warn(
      { azp: azp ?? null, aud: claims.aud },
      azp === undefined
        ? 'keycloak token rejected: no azp claim, so the human session path cannot attribute it to a client'
        : 'keycloak token rejected: client may not use the human session path',
    );
    return { ok: false, failure: WRONG_PATH_FOR_CLIENT };
  }

  // Second gate on the shared realm (defence in depth). Skipped only when an
  // operator has emptied KEYCLOAK_REQUIRED_REALM_ROLES.
  const required = keycloakConfig.required_realm_roles;
  if (required.length > 0 && !required.some((role) => hasRealmRole(claims, role))) {
    // Same rejection either way; only the explanation differs. An aggregator
    // token here means the shared-realm SSO session was reused silently, which
    // the caller cannot tell from a broken account unless we say so.
    const isAggregatorAccount =
      typeof claims['aggregator_id'] === 'string' || hasRealmRole(claims, 'org_owner');
    request.log.warn(
      { azp, roles: realmRoles(claims), required, aggregator_account: isAggregatorAccount },
      isAggregatorAccount
        ? 'keycloak token rejected: aggregator account reached signals via the shared realm SSO session'
        : 'keycloak token rejected: carries none of the required signals realm roles ' +
            '(check the client\'s `roles` scope and that migration assigned the role)',
    );
    return { ok: false, failure: isAggregatorAccount ? AGGREGATOR_ACCOUNT : MISSING_REALM_ROLE };
  }

  const provisioned = await provisionUserFromClaims(claims, request.log);
  if (!provisioned.ok) {
    return {
      ok: false,
      failure: {
        ...PROVISIONING_FAILURES[provisioned.code],
        // Provisioning writes a user-facing message per case; prefer it over
        // the generic one, except for the 500 (which must not leak detail).
        message:
          provisioned.code === 'PROVISIONING_FAILED'
            ? PROVISIONING_FAILURES.PROVISIONING_FAILED.message
            : provisioned.message,
      },
    };
  }

  if (provisioned.created) {
    request.log.info(
      { user_id: provisioned.user.id },
      'provisioned a new local user mirror from a Keycloak token',
    );
  }

  request.user = {
    id: provisioned.user.id,
    email: provisioned.user.email,
    name: provisioned.user.name,
    role: provisioned.user.role,
  };
  request.acting_org_grant = actingOrgGrant(claims);

  return { ok: true };
}

/** Send an auth failure using the shape the rest of the API already returns. */
export function sendAuthFailure(reply: FastifyReply, failure: AuthFailure) {
  return reply.status(failure.status).send({
    code: failure.code,
    error: failure.error,
    message: failure.message,
  });
}
