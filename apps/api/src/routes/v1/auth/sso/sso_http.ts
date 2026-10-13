import type { FastifyReply, FastifyRequest } from 'fastify';
import z from '@dpg/schemas';
import { authConfig, getCurrentApiBaseUrl, instance, keycloakConfig, ssoConfig } from '@/config';
import { requestOrigin } from '@/routes/v1/auth/login_flow';
import { safeAppOrigin } from '@/services/auth/oidc_flow_state';
import { SSO_ENTRY_TTL_SECONDS } from '@/services/auth/sso/sso_store';
import type { SsoFailureReason, SsoProvider } from '@/services/auth/sso/types';

/**
 * Shared plumbing for the SSO routes (`/api/v1/auth/sso/*`): the enable
 * check, response hardening, the error-page redirect and the URLs the
 * Keycloak identity provider and this API have to agree on.
 */

export const SSO_OIDC_PATH = '/api/v1/auth/sso/oidc';

/** Carries the SSO handle from /sso/login to /sso/oidc/authorize only. */
export const SSO_HANDLE_COOKIE = 'sso_h';

export const ErrorResponseSchema = z.object({ error: z.string(), message: z.string() });
export const RedirectResponse = z.null().describe('Redirect (Location header).');

/** SSO needs a provider AND Keycloak; either missing ⇒ every SSO route 404s. */
export function ssoEnabled(): boolean {
  return ssoConfig.enabled && authConfig.keycloak_enabled;
}

export function ssoNotEnabled(reply: FastifyReply) {
  return reply.code(404).send({ error: 'NOT_ENABLED', message: 'SSO is not enabled' });
}

/**
 * Nothing an SSO response carries may be cached, and the partner token that
 * arrived in the URL must not leak onward in a Referer header.
 */
export function hardenResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Referrer-Policy', 'no-referrer');
}

export function ssoHandleCookieOptions() {
  return {
    httpOnly: true,
    secure: instance.INSTANCE_ENV !== 'development',
    // Lax: the authorize request arrives as a top-level redirect from Keycloak.
    sameSite: 'lax' as const,
    path: SSO_OIDC_PATH,
    maxAge: SSO_ENTRY_TTL_SECONDS,
  };
}

/** UI origin for this SSO login: the provider's, if allowlisted, else ours. */
export function ssoAppOrigin(request: FastifyRequest, provider: SsoProvider | null): string {
  return safeAppOrigin(provider?.appOrigin, requestOrigin(request));
}

/** Send the browser to the UI's SSO error page. Only a fixed reason code travels. */
export function ssoErrorRedirect(reply: FastifyReply, origin: string, reason: SsoFailureReason) {
  const url = new URL('/auth/sso/error', origin);
  url.searchParams.set('reason', reason);
  return reply.redirect(url.toString());
}

/** `iss` of our id_tokens; the realm's identity provider is configured with it. */
export function ssoIssuer(): string {
  return `${getCurrentApiBaseUrl()}${SSO_OIDC_PATH}`;
}

/** The only redirect_uri /sso/oidc/authorize will send a code to. */
export function keycloakBrokerRedirectUri(): string {
  return `${keycloakConfig.base_url}/realms/${keycloakConfig.realm}/broker/${ssoConfig.oidc.kc_alias}/endpoint`;
}
