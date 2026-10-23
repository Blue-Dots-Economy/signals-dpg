import z from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { randomBytes } from 'node:crypto';
import { authConfig, getCurrentApiBaseUrl, instance } from '@/config';
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  idTokenNonce,
  newPkcePair,
  newStateValue,
  OidcExchangeError,
} from '@/services/auth/oidc_exchange';
import {
  consumeFlowState,
  FLOW_TTL_SECONDS,
  safeAppOrigin,
  safeReturnTo,
  saveFlowState,
} from '@/services/auth/oidc_flow_state';
import {
  createSession,
  destroySession,
  newCsrfToken,
  newSessionId,
  readSession,
  safeEqual,
  SESSION_TTL_SECONDS,
} from '@/services/auth/browser_session';
import {
  clearSessionCookie,
  SESSION_COOKIE,
} from '@api/plugins/auth/resolve_browser_session';
import { public_rate_limit } from '@/middleware/public_rate_limit';

/**
 * Browser login, run server-side (AUTH-VULN-03/04).
 *
 * The browser only ever holds an opaque httpOnly `sid` cookie; the OIDC code
 * exchange happens here and tokens live in Redis, so no script on the origin
 * can read a token.
 *
 * The API and the UI are not assumed to share an origin (locally :2742 and
 * :3000). The browser origin is carried through the flow and validated against
 * the CORS allowlist (`safeAppOrigin`) before anything is redirected to it.
 * Keycloak must list the API's callback URL as a valid redirect URI for
 * `signals-ui`.
 */

/**
 * Declared so the committed spec matches reality: the two browser-facing
 * routes only ever redirect, and a generated client must not model a 200 body.
 */
const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
});

/** A redirect carries no body; declared so the status itself is documented. */
const RedirectResponse = z.null().describe('Redirect (Location header).');

const SessionResponse = z.object({
  authenticated: z.boolean(),
  /** Present only when authenticated; the UI sends it back as `x-csrf-token`. */
  csrfToken: z.string().optional(),
});

const LogoutResponse = z.object({
  /** Where the UI should send the browser to end the Keycloak session too. */
  endSessionUrl: z.string(),
});

/**
 * The origin the browser actually reached this API on.
 *
 * One instance is served under several participant hostnames, and the flow has
 * to stay on the one the browser started from: a `sid` cookie set on the
 * canonical `API_DOMAIN` host is never sent to another portal host.
 *
 * With `trustProxy`, `protocol`/`host` come from client-influenced
 * `X-Forwarded-*` headers, so the result goes through the CORS allowlist and
 * falls back to `API_DOMAIN`; an unrecognised Host never becomes a redirect
 * target. Keycloak's registered-redirect check is the second gate.
 */
function requestOrigin(request: FastifyRequest): string {
  return safeAppOrigin(
    `${request.protocol}://${request.host}`,
    getCurrentApiBaseUrl()
  );
}

/** Unreachable while `keycloak_enabled` is a constant `true`. */
function notEnabled(reply: FastifyReply) {
  return reply.code(404).send({
    error: 'NOT_ENABLED',
    message: 'Browser sessions require AUTH_PROVIDER=keycloak',
  });
}

/**
 * Ties the authorization response to the browser that began the flow
 * (RFC 9700 §4.4.1).
 *
 * The verifier and nonce live in Redis keyed by `state`, so they attest the
 * server's participation, not the browser's; PKCE cannot stand in for this.
 * Without a browser-held value, an authorization response obtained in one
 * browser could be redeemed in another, landing that user in a session they
 * did not start.
 */
const FLOW_COOKIE = 'oidc_flow';

/** Scoped to the session routes: the callback is the only reader. */
const FLOW_COOKIE_PATH = '/api/v1/auth/session';

function flowCookieOptions() {
  return {
    httpOnly: true,
    secure: instance.INSTANCE_ENV !== 'development',
    // Lax: the callback is a top-level cross-site GET from Keycloak, which
    // `Strict` would withhold the cookie from.
    sameSite: 'lax' as const,
    path: FLOW_COOKIE_PATH,
    // Matches the flow state's TTL, so cookie and Redis row expire together.
    maxAge: FLOW_TTL_SECONDS,
  };
}

function clearFlowCookie(reply: FastifyReply): void {
  reply.clearCookie(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
}

function cookieOptions() {
  return {
    httpOnly: true,
    // `secure` is not hardcoded: local dev is plain http, and a Secure cookie
    // is silently dropped there, which presents as "login does nothing".
    secure: instance.INSTANCE_ENV !== 'development',
    // Lax, not Strict: login returns from Keycloak via a top-level cross-site
    // GET, and Strict would land the user back logged out. Lax still withholds
    // it from cross-site POSTs; the CSRF token covers the rest.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export const auth_session: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Starts a login. Redirects to Keycloak; the PKCE verifier stays server-side.
   */
  fastify.route({
    url: '/session/login',
    method: 'GET',
    // Unauthenticated, and each call writes a flow-state key into the shared
    // Redis. Generous enough that a human retrying a login never notices.
    preHandler: public_rate_limit('auth_session_login', 60),
    schema: {
      tags: ['auth'],
      querystring: z.object({
        returnTo: z.string().optional(),
        consentAttempt: z.string().optional(),
        /** The UI's own `window.location.origin`; allowlisted, never trusted. */
        appOrigin: z.string().optional(),
      }),
      response: { 302: RedirectResponse, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);

      const state = newStateValue();
      const nonce = randomBytes(16).toString('base64url');
      const { verifier, challenge } = newPkcePair();
      // The callback stays on the host the browser is already talking to, so
      // the cookie it sets is same-origin with the app.
      const self = requestOrigin(request);
      const redirectUri = `${self}/api/v1/auth/session/callback`;

      await saveFlowState(state, {
        verifier,
        nonce,
        returnTo: safeReturnTo(request.query.returnTo),
        consentAttempt: request.query.consentAttempt,
        redirectUri,
        appOrigin: safeAppOrigin(request.query.appOrigin, self),
      });

      // The browser's half of the binding checked at the callback.
      reply.setCookie(FLOW_COOKIE, state, flowCookieOptions());

      return reply.redirect(
        buildAuthorizeUrl({ redirectUri, state, nonce, challenge })
      );
    },
  });

  /**
   * Keycloak sends the browser back here. Exchanges the code, opens a session,
   * and redirects to the app — the browser never sees a token.
   */
  fastify.route({
    url: '/session/callback',
    method: 'GET',
    schema: {
      tags: ['auth'],
      querystring: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
      response: { 302: RedirectResponse, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);
      const { code, state, error } = request.query;
      // Failed logins land on the sign-in screen, which surfaces `auth_error`.
      // Before the flow is loaded there is no validated app origin, so callers
      // pass `requestOrigin` (allowlisted), never a raw request value.
      const authError = (origin: string) => {
        // The flow cookie is single-use, so every failure exit drops it.
        clearFlowCookie(reply);
        return reply.redirect(`${origin}/auth/login?auth_error=1`);
      };

      // Keycloak reports failures on the redirect rather than as a status, so
      // this is the normal "user cancelled" path, not an exception.
      if (error || !code || !state) {
        request.log.warn({ oidcError: error ?? 'missing code/state' }, 'OIDC callback rejected');
        return authError(requestOrigin(request));
      }

      // Checked before `consumeFlowState`: the flow state is single-use, so a
      // forged callback must not burn a legitimate login still in flight.
      const flowCookie = request.cookies?.[FLOW_COOKIE];
      if (!flowCookie || !safeEqual(flowCookie, state)) {
        request.log.warn(
          { hasFlowCookie: Boolean(flowCookie) },
          'OIDC callback rejected: not bound to the browser that started the flow'
        );
        return authError(requestOrigin(request));
      }

      const flow = await consumeFlowState(state);
      if (!flow) {
        // Unknown or already-used state: an expired flow, or a replayed
        // callback trying to mint a second session from one authorization.
        request.log.warn('OIDC callback with unknown or replayed state');
        return authError(requestOrigin(request));
      }

      let tokens;
      try {
        tokens = await exchangeCode({
          code,
          redirectUri: flow.redirectUri,
          verifier: flow.verifier,
        });
      } catch (err) {
        request.log.error(
          { err: err instanceof OidcExchangeError ? err.message : 'exchange failed' },
          'OIDC code exchange failed'
        );
        return authError(flow.appOrigin);
      }

      // The nonce binds this id token to our authorize request. A missing
      // nonce is a failure, not a pass: we always send one, so `null` means
      // the claim is absent or the token did not parse.
      const returnedNonce = idTokenNonce(tokens.idToken);
      if (returnedNonce === null || returnedNonce !== flow.nonce) {
        request.log.error('OIDC callback: id token nonce did not match the flow');
        return authError(flow.appOrigin);
      }

      const sessionId = newSessionId();
      await createSession(sessionId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExp: tokens.accessTokenExp,
        refreshTokenExp: tokens.refreshTokenExp,
        idToken: tokens.idToken,
        csrfToken: newCsrfToken(),
        appOrigin: flow.appOrigin,
        createdAt: Date.now(),
      });

      reply.setCookie(SESSION_COOKIE, sessionId, cookieOptions());
      // The binding has done its job; the flow it pointed at is consumed.
      clearFlowCookie(reply);

      // The UI's callback page owns everything after a session exists:
      // consent resume, wrong-portal detection, first-login landing.
      const landing = new URL('/auth/callback', flow.appOrigin);
      landing.searchParams.set('returnTo', flow.returnTo);
      if (flow.consentAttempt) {
        landing.searchParams.set('consentAttempt', flow.consentAttempt);
      }
      return reply.redirect(landing.toString());
    },
  });

  /**
   * "Am I logged in, and what CSRF token should I send?" — the UI's replacement
   * for reading a token out of storage.
   */
  fastify.route({
    url: '/session',
    method: 'GET',
    schema: {
      tags: ['auth'],
      response: { 200: SessionResponse, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);
      const sessionId = request.cookies?.[SESSION_COOKIE];
      if (!sessionId) return reply.send({ authenticated: false });

      const session = await readSession(sessionId);
      if (!session) {
        clearSessionCookie(reply);
        return reply.send({ authenticated: false });
      }

      return reply.send({ authenticated: true, csrfToken: session.csrfToken });
    },
  });

  /**
   * Ends the local session and hands back the Keycloak end-session URL, so the
   * SSO session goes too rather than silently logging the user back in.
   */
  fastify.route({
    url: '/session/logout',
    method: 'POST',
    schema: {
      tags: ['auth'],
      response: { 200: LogoutResponse, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      if (!authConfig.keycloak_enabled) return notEnabled(reply);
      const sessionId = request.cookies?.[SESSION_COOKIE];
      // Read before destroying: the session records which app origin opened it,
      // and that is where Keycloak has to send the user afterwards.
      const session = sessionId ? await readSession(sessionId) : null;
      if (sessionId) await destroySession(sessionId);
      clearSessionCookie(reply);

      return reply.send({
        endSessionUrl: buildEndSessionUrl({
          // Names the session being ended, so Keycloak logs the user out
          // straight away instead of asking them to confirm.
          idToken: session?.idToken,
          // Must be a post-logout URL the realm registers for `signals-ui`;
          // Keycloak matches exactly and refuses anything else.
          postLogoutRedirectUri: `${session?.appOrigin ?? requestOrigin(request)}/auth/login`,
        }),
      });
    },
  });
};
