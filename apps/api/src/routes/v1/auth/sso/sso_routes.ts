import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_sso_login } from '@/routes/v1/auth/sso/sso_login';
import { auth_sso_oidc } from '@/routes/v1/auth/sso/oidc_routes';

/**
 * Partner-portal SSO, mounted at `/api/v1/auth/sso`:
 *   GET  /login                           partner redirect lands here
 *   GET  /oidc/.well-known/openid-configuration
 *   GET  /oidc/jwks
 *   GET  /oidc/authorize                  browser, via Keycloak
 *   POST /oidc/token                      Keycloak, server-to-server
 * All answer 404 unless SSO_PROVIDERS is set and AUTH_PROVIDER=keycloak.
 */
export const auth_sso: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(auth_sso_login);
  fastify.register(auth_sso_oidc, { prefix: '/oidc' });
};
