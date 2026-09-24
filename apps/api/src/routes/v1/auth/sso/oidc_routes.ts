import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ssoConfig } from '@/config';
import {
  ErrorResponseSchema,
  hardenResponse,
  keycloakBrokerRedirectUri,
  RedirectResponse,
  SSO_HANDLE_COOKIE,
  ssoAppOrigin,
  ssoEnabled,
  ssoErrorRedirect,
  ssoHandleCookieOptions,
  ssoIssuer,
  ssoNotEnabled,
} from '@/routes/v1/auth/sso/sso_http';
import { getActiveSsoProvider, getSsoOidcKeys } from '@/services/auth/sso/registry';
import { peekEntry, saveCode, takeCode } from '@/services/auth/sso/sso_store';
import type { SsoIdentity } from '@/services/auth/sso/types';
import { safeEqual } from '@/utils/secure_crypto';

/**
 * `/api/v1/auth/sso/oidc/*` — the minimal OpenID Provider the realm's
 * `signals-sso` identity provider talks to. Keycloak treats this API like any
 * "Log in with X" provider; behind it, the partner link was already verified
 * by /sso/login.
 *
 * Only the authorization-code flow, only one client (Keycloak's broker), only
 * one redirect_uri (Keycloak's broker endpoint). Anything else is refused
 * rather than redirected — this is not a general-purpose OP.
 *
 *   jwks        the public key Keycloak verifies our id_tokens with
 *   authorize   browser → one-time code, bound to the sso_h cookie
 *   token       Keycloak, server-to-server → signed id_token
 *
 * No discovery document: the realm's identity provider is configured with
 * these URLs directly (infra/keycloak/init/apply-sso-idp.sh).
 */

const ID_TOKEN_TTL_SECONDS = 60;

const TokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

function tokenError(
  reply: FastifyReply,
  status: 400 | 401,
  error: string,
  description: string
) {
  return reply.code(status).send({ error, error_description: description });
}

/** `client_secret_post` or `client_secret_basic`; constant-time compare. */
function clientAuthenticated(request: FastifyRequest, body: Record<string, string>): boolean {
  let clientId = body.client_id;
  let clientSecret = body.client_secret;

  const header = request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep > 0) {
      // RFC 6749 §2.3.1 form-encodes both parts; a malformed escape (`%zz`)
      // is a failed authentication, not a server error.
      try {
        clientId = decodeURIComponent(decoded.slice(0, sep));
        clientSecret = decodeURIComponent(decoded.slice(sep + 1));
      } catch {
        return false;
      }
    }
  }

  return (
    typeof clientId === 'string' &&
    typeof clientSecret === 'string' &&
    safeEqual(clientId, ssoConfig.oidc.client_id) &&
    safeEqual(clientSecret, ssoConfig.oidc.client_secret)
  );
}

/** Keycloak maps given/family name onto firstName/lastName. */
function splitName(fullName: string | null): { given_name?: string; family_name?: string } {
  if (!fullName) return {};
  const [given, ...rest] = fullName.split(/\s+/);
  return { given_name: given, ...(rest.length ? { family_name: rest.join(' ') } : {}) };
}

/**
 * Claims Keycloak imports. Deliberately no `email`: partner emails are not
 * reliably verified, and an `email` claim would make Keycloak match and
 * link accounts on it (spec §6 rule 3).
 */
function idTokenClaims(identity: SsoIdentity, preferredUsername: string, nonce: string | null) {
  return {
    ...(nonce ? { nonce } : {}),
    preferred_username: preferredUsername,
    ...(identity.fullName ? { name: identity.fullName } : {}),
    ...splitName(identity.fullName),
    phone_number: identity.phone,
    phone_number_verified: identity.phoneVerified,
    sso_provider: identity.provider,
  };
}

export const auth_sso_oidc: FastifyPluginAsyncZod = async (fastify) => {
  // Keycloak posts the token request as a form. Scoped to this plugin, so no
  // other route starts accepting form bodies.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    }
  );

  fastify.route({
    url: '/jwks',
    method: 'GET',
    schema: { tags: ['auth'], hide: true },
    handler: async (_request, reply) => {
      if (!ssoEnabled()) return ssoNotEnabled(reply);
      return reply.send(await getSsoOidcKeys().jwks());
    },
  });

  fastify.route({
    url: '/authorize',
    method: 'GET',
    schema: {
      tags: ['auth'],
      hide: true,
      querystring: z.object({
        client_id: z.string().optional(),
        redirect_uri: z.string().optional(),
        response_type: z.string().optional(),
        state: z.string().optional(),
        nonce: z.string().optional(),
      }),
      response: { 302: RedirectResponse, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      hardenResponse(reply);
      if (!ssoEnabled()) return ssoNotEnabled(reply);
      const { client_id, redirect_uri, response_type, state, nonce } = request.query;

      // Refused outright, never redirected: an unvalidated redirect_uri is
      // exactly what must not receive a code.
      if (
        client_id !== ssoConfig.oidc.client_id ||
        redirect_uri !== keycloakBrokerRedirectUri() ||
        response_type !== 'code' ||
        !state
      ) {
        return reply.code(400).send({
          error: 'INVALID_AUTHORIZE_REQUEST',
          message: 'unknown client, redirect_uri or response_type',
        });
      }

      const handle = request.cookies?.[SSO_HANDLE_COOKIE];
      const entry = handle ? await peekEntry(handle) : null;
      // The handle is single-browser and single-login; without it there is no
      // verified partner identity to vouch for. Send the user to the error
      // page rather than back into Keycloak.
      reply.clearCookie(SSO_HANDLE_COOKIE, { path: ssoHandleCookieOptions().path });
      if (!handle || !entry) {
        request.log.warn({ hasHandle: Boolean(handle) }, 'sso: authorize without a live entry');
        return ssoErrorRedirect(reply, ssoAppOrigin(request, getActiveSsoProvider()), 'session-expired');
      }

      const code = randomBytes(32).toString('base64url');
      await saveCode(code, { handle, nonce: nonce ?? null, redirectUri: redirect_uri });

      const target = new URL(redirect_uri);
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
      return reply.redirect(target.toString());
    },
  });

  fastify.route({
    url: '/token',
    method: 'POST',
    schema: {
      tags: ['auth'],
      hide: true,
      body: z.record(z.string(), z.string()),
      response: {
        200: z.object({
          access_token: z.string(),
          token_type: z.literal('Bearer'),
          expires_in: z.number(),
          id_token: z.string(),
        }),
        400: TokenErrorSchema,
        401: TokenErrorSchema,
        404: ErrorResponseSchema,
      },
    },
    handler: async (request, reply) => {
      hardenResponse(reply);
      if (!ssoEnabled()) return ssoNotEnabled(reply);
      const body = request.body;

      if (!clientAuthenticated(request, body)) {
        return tokenError(reply, 401, 'invalid_client', 'client authentication failed');
      }
      if (body.grant_type !== 'authorization_code') {
        return tokenError(reply, 400, 'unsupported_grant_type', 'only authorization_code');
      }
      if (!body.code) {
        return tokenError(reply, 400, 'invalid_request', 'code is required');
      }

      // Single use: consumed whether or not the rest of the request is valid.
      const grant = await takeCode(body.code);
      if (!grant || grant.redirectUri !== body.redirect_uri) {
        return tokenError(reply, 400, 'invalid_grant', 'unknown, used or mismatched code');
      }
      const entry = await peekEntry(grant.handle);
      if (!entry) {
        return tokenError(reply, 400, 'invalid_grant', 'the login this code belongs to expired');
      }

      const idToken = await getSsoOidcKeys().signIdToken({
        issuer: ssoIssuer(),
        audience: ssoConfig.oidc.client_id,
        subject: entry.identity.subject,
        ttlSeconds: ID_TOKEN_TTL_SECONDS,
        claims: idTokenClaims(entry.identity, entry.preferredUsername, grant.nonce),
      });

      return reply.send({
        // Keycloak is configured not to call userinfo, so this is never used;
        // OAuth still requires one in the response.
        access_token: randomBytes(32).toString('base64url'),
        token_type: 'Bearer' as const,
        expires_in: ID_TOKEN_TTL_SECONDS,
        id_token: idToken,
      });
    },
  });
};

