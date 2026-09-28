import { errors as joseErrors, jwtVerify } from 'jose';
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
 *   ?token=<JWT HS256>&clientId=<our client id>[&featureKey=<key>]
 * where the JWT is keyed with the Client Secret NCS issued us.
 *
 * Checks run cheapest first, so a forged link costs microseconds and never
 * reaches NCS or Redis:
 *   1. shape + length, clientId is ours   (link-invalid)
 *   2. JWT signature, exp, iat            (link-invalid / link-expired)
 *   3. NCS validate-token                 (link-invalid / provider-unavailable)
 *   4. account ACTIVE, usable mobile      (account-inactive / link-invalid)
 *
 * The link lifetime is whatever NCS puts in `exp` (currently days, not
 * minutes). There is deliberately no cap of our own: validate-token is the
 * authoritative check, and single use bounds a leaked link to one login.
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
  clientSecret: string;
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
  const secretKey = new TextEncoder().encode(deps.clientSecret);

  async function verifyJwt(
    token: string
  ): Promise<SsoResult<{ exp: number }>> {
    const nowS = now();
    try {
      const { payload } = await jwtVerify(token, secretKey, {
        algorithms: ['HS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(nowS * 1000),
        requiredClaims: ['exp', 'iat'],
      });
      const exp = payload.exp as number;
      const iat = payload.iat as number;
      if (iat > nowS + CLOCK_TOLERANCE_SECONDS) return invalid('JWT issued in the future');
      return { ok: true, value: { exp } };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        return { ok: false, reason: 'link-expired' };
      }
      return invalid(err instanceof Error ? err.message : 'JWT verification failed');
    }
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

      const jwt = await verifyJwt(token);
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
