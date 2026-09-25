import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getCurrentApiBaseUrl, ssoConfig } from '@/config';
import { public_rate_limit } from '@/middleware/public_rate_limit';
import { startLoginFlow } from '@/routes/v1/auth/login_flow';
import {
  ErrorResponseSchema,
  hardenResponse,
  RedirectResponse,
  SSO_HANDLE_COOKIE,
  ssoAppOrigin,
  ssoEnabled,
  ssoErrorRedirect,
  ssoHandleCookieOptions,
  ssoNotEnabled,
} from '@/routes/v1/auth/sso/sso_http';
import { endBrowserSessionEverywhere } from '@/services/auth/end_browser_session';
import { getKeycloakAdminClient } from '@/services/auth/keycloak_admin_instance';
import { resolveAccountLink } from '@/services/auth/sso/link_resolver';
import { getActiveSsoProvider } from '@/services/auth/sso/registry';
import { saveEntry } from '@/services/auth/sso/sso_store';
import { maskPhone } from '@/utils/pii_log';
import {
  clearSessionCookie,
  SESSION_COOKIE,
} from '@api/plugins/auth/resolve_browser_session';

/**
 * `GET /api/v1/auth/sso/login` — where a partner portal sends a logged-in
 * user. The URL names no partner; the instance's SSO_PROVIDERS decides.
 *
 * Public by necessity (the browser arrives straight from the partner), so the
 * protection is the link itself: the provider verifies it completely here,
 * before anything is stored or Keycloak is involved. Then:
 *
 *   1. decide which Keycloak account this person becomes (phone-based)
 *   2. end any session already in this browser — a different person may have
 *      been logged in, and Keycloak refuses to switch users inside a session
 *   3. stash the verified identity under a one-time handle (cookie `sso_h`)
 *   4. start the normal login flow, pointed straight at the `signals-sso`
 *      identity provider — which is this API's /sso/oidc endpoints
 *
 * Every refusal lands on the UI's `/auth/sso/error?reason=…`. Nothing from the
 * request is echoed, and the partner token is never logged (the request log
 * drops auth query strings — `utils/log_redaction`).
 *
 * Runs on the canonical API host only. The `sso_h` cookie set here is read
 * by /sso/oidc/authorize, which Keycloak always calls on API_BASE_URL, so a
 * link that reached this API under another hostname is first redirected
 * there, query string intact.
 */

/**
 * Well above one person clicking a link, low enough to blunt a flood. Many
 * partner users share an IP (carrier-grade NAT, service centres), so this is
 * sized for a crowd behind one address, not for one browser.
 */
const SSO_LOGIN_PER_IP_PER_MINUTE = 120;

const SSO_LOGIN_PATH = '/api/v1/auth/sso/login';

/**
 * This request's URL on the canonical API host, or null when it already
 * arrived there. Compares the host only: the scheme behind a proxy that sets no
 * X-Forwarded-Proto reads as `http`, and comparing it would redirect forever.
 * The target is always the configured API_BASE_URL, never the request's Host.
 */
function canonicalRedirect(request: FastifyRequest): string | null {
  const canonical = new URL(getCurrentApiBaseUrl());
  if (request.host === canonical.host) return null;
  // Fixed path + the query string only: nothing from the request's path can
  // steer the target (a `//host` path would, through URL resolution).
  const q = request.url.indexOf('?');
  return `${canonical.origin}${SSO_LOGIN_PATH}${q >= 0 ? request.url.slice(q) : ''}`;
}
export const auth_sso_login: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/login',
    method: 'GET',
    // A browser navigation, so a limited request gets the error page (retry
    // later), not a JSON 429.
    preHandler: public_rate_limit(
      'auth_sso_login',
      SSO_LOGIN_PER_IP_PER_MINUTE,
      60,
      (request, reply) => {
        hardenResponse(reply);
        return ssoErrorRedirect(
          reply,
          ssoAppOrigin(request, ssoEnabled() ? getActiveSsoProvider() : null),
          'provider-unavailable'
        );
      }
    ),
    schema: {
      tags: ['auth'],
      summary: 'Partner-portal SSO entry point',
      querystring: z.record(z.string(), z.unknown()),
      response: { 302: RedirectResponse, 404: ErrorResponseSchema },
    },
    handler: async (request, reply) => {
      hardenResponse(reply);
      const provider = ssoEnabled() ? getActiveSsoProvider() : null;
      if (!provider) return ssoNotEnabled(reply);

      const canonical = canonicalRedirect(request);
      if (canonical) return reply.redirect(canonical);

      const origin = ssoAppOrigin(request, provider);

      const verified = await provider.verify(request.query);
      if (!verified.ok) {
        request.log.warn(
          { provider: provider.id, reason: verified.reason, detail: verified.detail },
          'sso: partner link refused'
        );
        return ssoErrorRedirect(reply, origin, verified.reason);
      }
      const { identity, returnTo, appOrigin } = verified.value;

      const link = await resolveAccountLink(identity, {
        admin: getKeycloakAdminClient(),
        idpAlias: ssoConfig.oidc.kc_alias,
      });
      if (!link.ok) {
        request.log.warn(
          {
            provider: provider.id,
            reason: link.reason,
            detail: link.detail,
            phone: maskPhone(identity.phone),
          },
          'sso: account link refused'
        );
        return ssoErrorRedirect(reply, origin, link.reason);
      }

      // Last, so a partner or Keycloak outage above never burns the link.
      if (!(await verified.value.claim())) {
        request.log.warn({ provider: provider.id }, 'sso: partner link reused');
        return ssoErrorRedirect(reply, origin, 'link-reused');
      }

      const existingSession = request.cookies?.[SESSION_COOKIE];
      if (existingSession) {
        await endBrowserSessionEverywhere(existingSession, request.log);
        clearSessionCookie(reply);
      }

      const handle = randomBytes(32).toString('base64url');
      await saveEntry(handle, { identity, preferredUsername: link.value.preferredUsername });
      reply.setCookie(SSO_HANDLE_COOKIE, handle, ssoHandleCookieOptions());

      return reply.redirect(
        await startLoginFlow(request, reply, {
          returnTo,
          appOrigin,
          idpHint: ssoConfig.oidc.kc_alias,
          sso: { provider: provider.id, handle },
        })
      );
    },
  });
};
