/**
 * Session resolution, shared by `auth_middleware.ts` and `validate_session.ts`
 * so the two cannot drift.
 *
 * Which provider runs is decided entirely by `AUTH_PROVIDER`:
 *
 *   betterauth  the Keycloak branch is not reached at all; the caller falls
 *               through to better-auth's own session handling.
 *   keycloak    Keycloak only. There is no better-auth fallback — a request that
 *               carries no usable Keycloak token is simply unauthenticated.
 *
 * A token that *looks* Keycloak-issued but fails validation is rejected outright
 * rather than passed on. That mattered when a fallback existed (it would have
 * turned a precise failure — "expired", "wrong client" — into a generic 401, and
 * let a rejected token get a second evaluation by another code path), and it is
 * retained now because the precise failure is still the more useful answer.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import {
  actingOrgGrant,
  extractBearerToken,
  isServiceAccountToken,
  looksLikeKeycloakToken,
  verifyKeycloakToken,
  type KeycloakTokenErrorCode,
} from '../../src/utils/keycloak_token';
import { provisionUserFromClaims } from '../../src/services/auth/provisioning';
import type { ProvisioningErrorCode } from '../../src/services/auth/provisioning';
import { resolveServiceAccount } from '../../src/services/auth/service_account';
import type { ServiceAccountErrorCode } from '../../src/services/auth/service_account';
import { keycloakConfig } from '../../src/config';

/** Shape every auth failure shares, matching the existing middleware replies. */
interface AuthFailure {
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
const TOKEN_FAILURES: Record<KeycloakTokenErrorCode, AuthFailure> = {
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
  /** Not a Keycloak token; the caller should try better-auth. */
  | { ok: false; fallthrough: true };

/**
 * Try to resolve the request against Keycloak, populating `request.user` from
 * the local mirror on success.
 *
 * Returns `fallthrough` only under `AUTH_PROVIDER=betterauth`, meaning the caller
 * should hand the request to better-auth. Under `keycloak` this either resolves
 * the request or fails it — there is no second provider to defer to, so a request
 * with no usable Keycloak token is unauthenticated rather than passed on.
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
    if (verified.code === 'KEYCLOAK_UNAVAILABLE' || verified.code === 'KEYCLOAK_NOT_CONFIGURED') {
      request.log.error(
        { code: verified.code, reason: verified.message },
        'keycloak token verification could not complete',
      );
    } else {
      request.log.warn(
        { code: verified.code, reason: verified.message },
        'keycloak token rejected',
      );
    }
    return { ok: false, failure: TOKEN_FAILURES[verified.code] };
  }

  const { claims } = verified;
  const azp = typeof claims.azp === 'string' ? claims.azp : undefined;

  /**
   * Fork on what kind of caller this is. The audience gate in
   * `verifyKeycloakToken` has already confirmed the client is one signals
   * serves at all; this decides which of the two paths it may take.
   *
   * Both directions are checked, because conflating them is the actual risk:
   * a service token must never be run through human provisioning (it has no
   * email or phone, and would otherwise try to mint a user mirror), and a
   * token from the public `signals-ui` client must never be honoured as an
   * integrating DPG's service identity.
   */
  if (isServiceAccountToken(claims)) {
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
    // Acting-org grant (§5.1). Carried to acting_org.ts, which decides whether
    // to enforce it based on ACTING_ORG_SOURCE.
    request.acting_org_grant = actingOrgGrant(claims);
    return { ok: true };
  }

  if (azp !== undefined && !keycloakConfig.session_client_ids.includes(azp)) {
    request.log.warn(
      { azp },
      'keycloak token rejected: client may not use the human session path',
    );
    return { ok: false, failure: WRONG_PATH_FOR_CLIENT };
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
