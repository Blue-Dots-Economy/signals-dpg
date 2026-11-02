import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { authConfig, keycloakConfig } from '@/config';

const KeycloakPublicConfig = z.object({
  /** Browser-facing Keycloak base URL. */
  url: z.string(),
  realm: z.string(),
  /** Public OIDC client the UI authenticates with. */
  clientId: z.string(),
});

const AuthConfigResponse = z.object({
  selfSignupAllowed: z.boolean(),
  loginChannels: z.array(z.enum(['email', 'phone'])),
  /**
   * The instance's identity provider, so the UI picks its login screen at
   * runtime rather than at build time. Keycloak is the only provider.
   */
  authProvider: z.enum(['keycloak']),
  /**
   * OIDC connection details, or null when Keycloak is not configured. All three
   * values are public for a public OIDC client.
   */
  keycloak: KeycloakPublicConfig.nullable(),
});

/**
 * Public, unauthenticated. Surfaces the instance's auth-flow configuration to
 * the UI. Server env remains the single source of truth (apps/api/src/config.ts);
 * the UI never decides for itself.
 *
 * Served at runtime rather than baked into the UI build so the UI cannot
 * disagree with the API, and so the issuer the UI uses comes from the same
 * config the API validates `iss` against.
 */
export const auth_config: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/config',
    method: 'GET',
    schema: {
      tags: ['auth'],
      response: { 200: AuthConfigResponse },
    },
    handler: async (_request, reply) => {
      return reply.code(200).send({
        selfSignupAllowed: authConfig.allow_self_signup,
        loginChannels: authConfig.login_channels,
        authProvider: authConfig.provider,
        // A half-configured instance must not send the UI somewhere broken.
        keycloak:
          authConfig.keycloak_enabled && keycloakConfig.base_url
            ? {
                url: keycloakConfig.base_url,
                realm: keycloakConfig.realm,
                clientId: keycloakConfig.ui_client_id,
              }
            : null,
      });
    },
  });
};
