import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { getCurrentApiBaseUrl, instance } from '@/config';
import {
  buildAuthorizeUrl,
  newPkcePair,
  newStateValue,
} from '@/services/auth/oidc_exchange';
import {
  FLOW_TTL_SECONDS,
  safeAppOrigin,
  safeReturnTo,
  saveFlowState,
  type OidcFlowState,
} from '@/services/auth/oidc_flow_state';

/**
 * The start of a browser login, shared by every route that begins one:
 * `/session/login` (the OTP screen) and `/sso/login` (a partner portal).
 *
 * Both need exactly the same PKCE + state + nonce + browser-binding setup, so
 * it lives once here — a second copy would be the place the binding check or
 * the redirect allowlist quietly drifted.
 */

/**
 * The origin the browser actually reached this API on.
 *
 * `API_DOMAIN` names ONE canonical host, but a single instance is served under
 * several participant hostnames (the per-domain portals), and the whole flow
 * has to stay on the one the browser started from. Sending the callback to the
 * canonical host instead sets the `sid` cookie on THAT origin, and a cookie set
 * on `dev-signals.example` is simply never sent to `portal.example` — the user
 * completes a perfectly good login and lands back unauthenticated.
 *
 * `trustProxy` is enabled (`app.ts`), so `protocol`/`host` reflect the
 * `X-Forwarded-*` headers the edge sets. Those are influenced by the client, so
 * the result is run through the same CORS allowlist `appOrigin` uses and falls
 * back to `API_DOMAIN` when it does not match — an unrecognised Host can
 * therefore never become a redirect target. Keycloak's own registered-redirect
 * check is the second gate.
 */
export function requestOrigin(request: FastifyRequest): string {
  return safeAppOrigin(
    `${request.protocol}://${request.host}`,
    getCurrentApiBaseUrl()
  );
}

/**
 * Ties the authorization response to the browser that began the flow.
 *
 * `state` on its own says nothing about WHICH user agent is redeeming the code.
 * The verifier and nonce live in Redis keyed by `state`, so they attest the
 * SERVER's participation in the flow, not the browser's — PKCE cannot stand in
 * for this. Without a browser-held value, an authorization response obtained in
 * one browser can be redeemed in another, landing that user in a session they
 * did not start.
 *
 * The deleted SPA client had this binding implicitly: `oidc-client-ts` kept its
 * state in that browser's own web storage, so a callback arriving anywhere else
 * had nothing to validate against. Moving the exchange server-side removed it,
 * so it is re-established explicitly here. RFC 9700 §4.4.1.
 */
export const FLOW_COOKIE = 'oidc_flow';

/**
 * Scoped to the session routes, not `/`: the callback is the only reader, and a
 * flow cookie has no business riding along on every API request.
 */
const FLOW_COOKIE_PATH = '/api/v1/auth/session';

export function flowCookieOptions() {
  return {
    httpOnly: true,
    secure: instance.INSTANCE_ENV !== 'development',
    // Lax for the same reason as the session cookie: the callback arrives as a
    // top-level cross-site GET from Keycloak, and `Strict` withholds a cookie
    // on exactly that navigation — which would make every login fail closed.
    sameSite: 'lax' as const,
    path: FLOW_COOKIE_PATH,
    // Matches the flow state's own TTL, so the cookie and the Redis row expire
    // together rather than one outliving the other.
    maxAge: FLOW_TTL_SECONDS,
  };
}

export function clearFlowCookie(reply: FastifyReply): void {
  reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
}


export interface StartLoginFlowInput {
  /** Path within the app to land on. Passed through `safeReturnTo`. */
  returnTo?: string;
  consentAttempt?: string;
  /** The UI's own origin; allowlisted, never trusted. */
  appOrigin?: string;
  /** Keycloak identity provider to go straight to (`kc_idp_hint`). */
  idpHint?: string;
  /** Carried to the callback for an SSO login. See `OidcFlowState.sso`. */
  sso?: OidcFlowState['sso'];
}

/**
 * Save the flow state, set the browser-binding cookie, and return the Keycloak
 * authorize URL to redirect to. The PKCE verifier stays server-side.
 */
export async function startLoginFlow(
  request: FastifyRequest,
  reply: FastifyReply,
  input: StartLoginFlowInput
): Promise<string> {
  const state = newStateValue();
  const nonce = randomBytes(16).toString('base64url');
  const { verifier, challenge } = newPkcePair();
  // Same host the browser is already talking to: it reached this route there,
  // so it serves the callback there too, and the cookie the callback sets will
  // be same-origin with the app.
  const self = requestOrigin(request);
  const redirectUri = `${self}/api/v1/auth/session/callback`;

  await saveFlowState(state, {
    verifier,
    nonce,
    returnTo: safeReturnTo(input.returnTo),
    consentAttempt: input.consentAttempt,
    redirectUri,
    appOrigin: safeAppOrigin(input.appOrigin, self),
    ...(input.sso ? { sso: input.sso } : {}),
  });

  // The browser's half of the binding checked at the callback. Set before the
  // redirect so it is already in place when Keycloak sends the user back,
  // however fast that round-trip is.
  reply.setCookie(FLOW_COOKIE, state, flowCookieOptions());

  return buildAuthorizeUrl({
    redirectUri,
    state,
    nonce,
    challenge,
    idpHint: input.idpHint,
  });
}
