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
   * The instance's identity provider, so the UI can pick a login screen at
   * RUNTIME instead of having it compiled into the bundle. See the note below.
   */
  authProvider: z.enum(['betterauth', 'dual', 'keycloak']),
  /**
   * OIDC connection details, or null when this instance isn't running Keycloak.
   * All three values are public by nature for a public OIDC client (the realm's
   * own `/.well-known/openid-configuration` is unauthenticated too).
   */
  keycloak: KeycloakPublicConfig.nullable(),
});

/**
 * Public, unauthenticated. Surfaces the instance's auth-flow configuration to
 * the UI. Server env remains the single source of truth (see
 * apps/api/src/config.ts) — the UI reads this, it never decides for itself.
 *
 * **Why `authProvider` and `keycloak` are served from here rather than baked
 * into the UI build.** They were originally `VITE_*` build args, which meant
 * the login screen was compiled into the image: flipping providers required a
 * rebuild, and — worse — the UI could silently disagree with the API. A bundle
 * built with `keycloak` while the API ran `betterauth` sent every user to an
 * OIDC redirect the API knew nothing about, and the OTP endpoints were never
 * called. Serving both from the API makes that mismatch impossible by
 * construction and removes the rebuild.
 *
 * Serving the Keycloak URL/realm from here has a second benefit: the issuer the
 * UI redirects to is derived from the same config the API validates `iss`
 * against, so the two cannot drift apart.
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
        // Only advertise Keycloak once this instance is actually configured for
        // it; a half-configured instance must not send the UI somewhere broken.
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
