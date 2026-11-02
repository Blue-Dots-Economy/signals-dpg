/**
 * Keycloak access-token validation against the realm JWKS.
 *
 * The client check is a real control: signals shares one realm with
 * aggregator, so an aggregator token has the same keys and `iss`. Every token
 * must also name a client in `accepted_client_ids`.
 *
 * Nothing here throws; failures are returned as values for the caller to map
 * to a status code.
 */

import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { keycloakConfig } from '@/config';

/**
 * The subset of Keycloak access-token claims signals reads: what provisioning
 * maps onto the local `user` mirror, plus the claims that tell a human session
 * from a client-credentials service call.
 */
export interface KeycloakClaims {
  /** Realm-unique subject; equals the signals `user.id`. */
  sub: string;
  iss: string;
  aud: string[];
  /** Authorized party — the client the token was actually issued to. */
  azp?: string;
  exp: number;
  iat?: number;
  jti?: string;
  email?: string;
  email_verified?: boolean;
  /** Mapped from the `phoneNumber` user attribute by the realm's mapper. */
  phone_number?: string;
  preferred_username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
  /** Present on client-credentials (service-account) tokens. */
  client_id?: string;
  [claim: string]: unknown;
}

export type KeycloakTokenErrorCode =
  /** Malformed, wrong signature, wrong issuer, or otherwise unusable. */
  | 'TOKEN_INVALID'
  /** Well-formed and correctly signed, but past `exp` (or before `nbf`). */
  | 'TOKEN_EXPIRED'
  /** Valid realm token, but issued to a client signals does not serve. */
  | 'TOKEN_CLIENT_REJECTED'
  /** JWKS could not be fetched — Keycloak down or unreachable. Retryable. */
  | 'KEYCLOAK_UNAVAILABLE'
  /** No Keycloak issuer/JWKS URI is configured. */
  | 'KEYCLOAK_NOT_CONFIGURED';

export type KeycloakTokenResult =
  | { ok: true; claims: KeycloakClaims }
  | { ok: false; code: KeycloakTokenErrorCode; message: string };

/**
 * One JWKS set per URL: jose's caching and rate-limited refetch only work
 * when the instance is reused.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string) {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), {
      cacheMaxAge: keycloakConfig.jwks_cache_max_age_ms,
      // Floor between refetches when an unknown `kid` arrives, so a burst of
      // bogus tokens cannot turn into a burst of requests to Keycloak.
      cooldownDuration: 30_000,
    });
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/** Test seam: drop the memoised JWKS sets. Not used in normal operation. */
export function resetKeycloakJwksCache(): void {
  jwksCache.clear();
}

/** Node socket-level failures that mean "Keycloak was unreachable". */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

/**
 * Distinguishes "could not fetch the key set" from "the token is bad", so a
 * Keycloak outage does not look like every token going invalid at once. jose
 * reports a JWKS non-200 as a plain `JOSEError` and an unreachable host as a
 * Node system error, so an `instanceof JWKSTimeout` check alone misses both.
 * `JWKSNoMatchingKey` is not an outage: the set was fetched, the `kid` is
 * just unknown.
 */
function isJwksRetrievalFailure(err: unknown): boolean {
  if (err instanceof joseErrors.JWKSTimeout || err instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  if (
    err instanceof joseErrors.JOSEError &&
    err.code === 'ERR_JOSE_GENERIC' &&
    err.message.includes('JSON Web Key Set')
  ) {
    return true;
  }
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/** Normalise the `aud` claim, which Keycloak emits as a string or an array. */
function toAudienceList(aud: JWTPayload['aud']): string[] {
  if (!aud) return [];
  return Array.isArray(aud) ? aud : [aud];
}

/**
 * Pull the bearer token out of an Authorization header. Returns undefined for
 * a missing or non-bearer header rather than throwing.
 */
export function extractBearerToken(
  authorization: string | string[] | undefined
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return undefined;
  const trimmed = header.trim();
  // Match only the scheme prefix and slice the rest: a `(.+)$` capture after
  // `\s+` is ambiguous (both match spaces) and backtracks super-linearly.
  const scheme = /^Bearer\s+/i.exec(trimmed);
  if (!scheme) return undefined;
  return trimmed.slice(scheme[0].length).trim() || undefined;
}

/**
 * Unverified pre-check that the token is a JWT from our realm issuer. It
 * reads the payload without checking the signature, so it may only be used to
 * reject early, never to admit.
 */
export function looksLikeKeycloakToken(token: string): boolean {
  if (!keycloakConfig.issuer) return false;
  if (token.split('.').length !== 3) return false;
  try {
    return decodeJwt(token).iss === keycloakConfig.issuer;
  } catch {
    return false;
  }
}

/**
 * Verify a Keycloak access token: signature against the realm JWKS, `iss`,
 * `exp`/`nbf`, and — the part that matters in a shared realm — that the token
 * was issued to a client signals serves.
 *
 * Keycloak puts the requesting client in `azp` and typically only `account` in
 * `aud`, so `azp` is checked first and `aud` is accepted as a fallback for
 * tokens shaped by an explicit audience mapper. Either must intersect
 * `keycloakConfig.accepted_client_ids`; neither matching is a rejection.
 */
export async function verifyKeycloakToken(
  token: string
): Promise<KeycloakTokenResult> {
  if (!keycloakConfig.issuer || !keycloakConfig.jwks_uri) {
    return {
      ok: false,
      code: 'KEYCLOAK_NOT_CONFIGURED',
      message: 'Keycloak issuer is not configured (KEYCLOAK_BASE_URL unset)',
    };
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(keycloakConfig.jwks_uri), {
      issuer: keycloakConfig.issuer,
      clockTolerance: keycloakConfig.clock_tolerance_seconds,
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'Access token has expired' };
    }
    // Infrastructure failure, not an auth failure: log as such; retryable.
    if (isJwksRetrievalFailure(err)) {
      return {
        ok: false,
        code: 'KEYCLOAK_UNAVAILABLE',
        message: 'Could not fetch the Keycloak JWKS to verify the token',
      };
    }
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message: err instanceof Error ? err.message : 'Access token is not valid',
    };
  }

  if (typeof payload.sub !== 'string' || !payload.sub) {
    return {
      ok: false,
      code: 'TOKEN_INVALID',
      message: 'Access token has no subject (sub) claim',
    };
  }

  const audiences = toAudienceList(payload.aud);
  const azp = typeof payload.azp === 'string' ? payload.azp : undefined;
  const accepted = keycloakConfig.accepted_client_ids;
  const clientIsAccepted =
    (azp !== undefined && accepted.includes(azp)) ||
    audiences.some((aud) => accepted.includes(aud));

  if (!clientIsAccepted) {
    const named = azp ?? (audiences.join(',') || 'unknown');
    return {
      ok: false,
      code: 'TOKEN_CLIENT_REJECTED',
      message: `Token was issued to client '${named}', which signals does not serve`,
    };
  }

  return {
    ok: true,
    claims: { ...payload, sub: payload.sub, aud: audiences } as KeycloakClaims,
  };
}

/** Claim carrying the signals organizations a caller may act for. */
export const ACTING_ORG_CLAIM = 'signals_acting_orgs';

/** Grant value meaning "any org". */
export const ACTING_ORG_WILDCARD = '*';

/**
 * The acting-org grant, or undefined when the claim is absent. Absent means
 * fall back to the header (`claim_preferred`); an empty array is a grant of
 * nothing and must authorise nothing.
 *
 * Accepts a JSON array (multivalued mapper) or a comma-separated string
 * (hardcoded-claim mapper without `jsonType.label` set to JSON).
 */
export function actingOrgGrant(claims: KeycloakClaims): string[] | undefined {
  const raw = claims[ACTING_ORG_CLAIM];
  if (raw === undefined || raw === null) return undefined;

  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    values = raw.split(',');
  } else {
    return undefined;
  }

  return values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** True when the grant permits acting for any org. */
export function grantIsWildcard(grant: string[] | undefined): boolean {
  return grant !== undefined && grant.includes(ACTING_ORG_WILDCARD);
}

/** Realm roles carried by the token, or an empty array. */
export function realmRoles(claims: KeycloakClaims): string[] {
  return claims.realm_access?.roles ?? [];
}

/**
 * Second gate on the human path (`KEYCLOAK_REQUIRED_REALM_ROLES`, checked in
 * `resolve_session.ts`). A realm role is assigned by the realm, not named by
 * the client, so a misconfigured audience mapper cannot undo it.
 */
export function hasRealmRole(claims: KeycloakClaims, role: string): boolean {
  return realmRoles(claims).includes(role);
}

/**
 * True for a client-credentials (service-account) token. Any one signal
 * suffices: `azp` in `service_client_ids`, a `client_id` claim, or a
 * `service-account-` username. `azp` matters because the other two are
 * optional (no `client_id` mapper on the bundled realm's service clients;
 * `preferred_username` needs the `profile` scope), and misclassifying a
 * service client as human locks it out with `BEARER_SESSION_NOT_SUPPORTED`.
 *
 * Not an authorization by itself: the caller must still resolve to a service
 * account, and `service_client_ids` is empty by default.
 */
export function isServiceAccountToken(claims: KeycloakClaims): boolean {
  return (
    (typeof claims.azp === 'string' &&
      keycloakConfig.service_client_ids.includes(claims.azp)) ||
    typeof claims.client_id === 'string' ||
    (typeof claims.preferred_username === 'string' &&
      claims.preferred_username.startsWith('service-account-'))
  );
}
