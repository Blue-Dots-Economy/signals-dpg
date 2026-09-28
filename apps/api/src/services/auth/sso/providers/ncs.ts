import { decodeJwt } from 'jose';
import type { SsoNcsMapping } from '@dpg/config';
import { safeReturnTo } from '@/services/auth/oidc_flow_state';
import type { NcsClient, NcsUser } from '@/services/auth/sso/ncs_client';
import { claimPartnerToken } from '@/services/auth/sso/sso_store';
import type {
  SsoIdentity,
  SsoProvider,
  SsoResult,
  SsoVerifiedLink,
} from '@/services/auth/sso/types';
import { normalizeIndianMobile } from '@/utils/phone';

/**
 * National Career Service (NCS) partner link.
 *
 * NCS redirects the browser with
 *   ?token=<JWT>&clientId=<our client id>[&featureKey=<key>]
 *
 * The token is opaque to us. NCS signs it with a key of its own that we do not
 * hold, so its signature is not checked here: NCS validate-token (called with
 * an HMAC keyed by our Client Secret) is the authentication. The JWT is only
 * decoded, unverified, to turn away an obviously dead link before calling NCS.
 *
 * Checks, cheapest first:
 *   1. shape + length, clientId is ours   (link-invalid)
 *   2. decodes as a JWT with exp and iat  (link-invalid / link-expired)
 *   3. NCS validate-token                 (link-invalid / provider-unavailable)
 *   4. account ACTIVE, usable mobile      (account-inactive / link-invalid)
 *
 * So a forged link does reach NCS; the per-IP rate limit on /sso/login and the
 * NCS client's circuit breaker bound that. The link lifetime is whatever NCS
 * puts in `exp` (1 day in production); there is deliberately no cap of our
 * own, and single use bounds a leaked link to one login.
 *
 * Single use (link-reused) is not checked here: `verify` returns a `claim()`
 * that /sso/login calls last, after the Keycloak account lookup too. So if NCS
 * or Keycloak is briefly down, the user can retry the same link instead of
 * being told it was already used.
 */

export const NCS_PROVIDER_ID = 'ncs';

/** No partner parameter legitimately comes close to this. */
const MAX_PARAM_LENGTH = 4096;
/** Allowed clock skew between NCS and us. */
const CLOCK_TOLERANCE_SECONDS = 30;

export interface NcsProviderDeps {
  clientId: string;
  client: NcsClient;
  mapping: SsoNcsMapping;
  /** Clock seam for tests. */
  nowSeconds?: () => number;
}

function stringParam(query: Record<string, unknown>, name: string): string | null {
  const value = query[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PARAM_LENGTH) {
    return null;
  }
  return value;
}

const invalid = (detail: string): SsoResult<never> => ({
  ok: false,
  reason: 'link-invalid',
  detail,
});

export function createNcsProvider(deps: NcsProviderDeps): SsoProvider {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  /**
   * Unverified read of exp/iat. Only a pre-filter and the single-use TTL; the
   * claim is reached only after NCS has accepted the token, so by then these
   * are NCS's own values.
   */
  function readJwtTimes(token: string): SsoResult<{ exp: number }> {
    let payload: ReturnType<typeof decodeJwt>;
    try {
      payload = decodeJwt(token);
    } catch {
      return invalid('token is not a JWT');
    }
    const { exp, iat } = payload;
    if (typeof exp !== 'number' || typeof iat !== 'number') {
      return invalid('JWT has no exp or iat');
    }
    const nowS = now();
    if (exp < nowS - CLOCK_TOLERANCE_SECONDS) return { ok: false, reason: 'link-expired' };
    if (iat > nowS + CLOCK_TOLERANCE_SECONDS) return invalid('JWT issued in the future');
    return { ok: true, value: { exp } };
  }

  function toIdentity(user: NcsUser, phone: string): SsoIdentity {
    return {
      provider: NCS_PROVIDER_ID,
      providerUserId: user.userId,
      subject: `${NCS_PROVIDER_ID}:${user.userId}`,
      fullName: user.fullName?.trim() || null,
      phone,
      phoneVerified: user.isMobileVerified === true,
      email: user.email?.trim().toLowerCase() || null,
      emailVerified: user.isEmailVerified === true,
      role: user.role ?? null,
      attributes: user,
    };
  }

  return {
    id: NCS_PROVIDER_ID,
    appOrigin: deps.mapping.app_origin,

    async verify(query) {
      const token = stringParam(query, 'token');
      if (!token) return invalid('missing or malformed token parameter');
      // Optional on the link; when present it must name us, so a link NCS
      // minted for another partner is refused before it reaches NCS.
      if (query.clientId !== undefined && query.clientId !== deps.clientId) {
        return invalid('clientId does not match');
      }

      const jwt = readJwtTimes(token);
      if (!jwt.ok) return jwt;

      const validated = await deps.client.validateToken(token);
      if (!validated.ok) return validated;

      const user = validated.value;
      if (user.status !== 'ACTIVE') {
        return { ok: false, reason: 'account-inactive', detail: `NCS status ${user.status}` };
      }

      const phone = normalizeIndianMobile(user.mobileNumber);
      if (!phone) return invalid('NCS returned no usable mobile number');

      const featureKey = typeof query.featureKey === 'string' ? query.featureKey : '';
      const route = Object.hasOwn(deps.mapping.feature_routes, featureKey)
        ? deps.mapping.feature_routes[featureKey]
        : undefined;

      const link: SsoVerifiedLink = {
        identity: toIdentity(user, phone),
        returnTo: safeReturnTo(route),
        ...(deps.mapping.app_origin ? { appOrigin: deps.mapping.app_origin } : {}),
        // Remembered until the link could no longer verify anyway.
        claim: () =>
          claimPartnerToken(
            NCS_PROVIDER_ID,
            token,
            Math.max(1, jwt.value.exp - now() + CLOCK_TOLERANCE_SECONDS)
          ),
      };
      return { ok: true, value: link };
    },
  };
}
