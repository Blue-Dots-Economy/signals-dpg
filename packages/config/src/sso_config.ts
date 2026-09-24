import z from '@dpg/schemas';
import { ConfigError } from './config_error.js';
import type { SsoSecretsSchema } from './secrets.js';

/** Providers with an adapter in apps/api/src/services/auth/sso/providers. */
export const KNOWN_SSO_PROVIDERS = ['ncs'] as const;
export type SsoProviderId = (typeof KNOWN_SSO_PROVIDERS)[number];

/**
 * Split, trim, lowercase and de-duplicate SSO_PROVIDERS.
 *
 * An unknown id is a boot failure rather than a silent skip: a typo would
 * otherwise leave the partner's users locked out with nothing in the log.
 */
export function parseSsoProviders(value: string): SsoProviderId[] {
  const ids = [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  for (const id of ids) {
    if (!(KNOWN_SSO_PROVIDERS as readonly string[]).includes(id)) {
      throw new ConfigError(
        `SSO_PROVIDERS contains unknown provider '${id}'. Known: ${KNOWN_SSO_PROVIDERS.join(', ')}.`
      );
    }
  }
  return ids as SsoProviderId[];
}

export const SsoNcsMappingSchema = z.object({
  /** Network the draft profile is created in. Defaults to the domain's served network. */
  network: z.string().optional(),
  item_type: z.string().default('profile_1.0'),
  /** NCS `role` → Signals domain. An unmapped role gets no draft profile. */
  role_to_domain: z.record(z.string(), z.string()).default({}),
  /** NCS `data.*` field → profile `item_state` field. */
  fields: z.record(z.string(), z.string()).default({}),
  /**
   * NCS `featureKey` → UI path. Unknown keys land on `/`. Each value is passed
   * through the API's `safeReturnTo` at use, so an off-origin entry degrades to
   * `/` rather than becoming an open redirect.
   */
  feature_routes: z.record(z.string(), z.string()).default({}),
  /** UI origin to land on; must also be in the CORS allowlist. */
  app_origin: z.string().optional(),
});

export type SsoNcsMapping = z.infer<typeof SsoNcsMappingSchema>;

export function parseSsoNcsMapping(raw: string): SsoNcsMapping {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError('SSO_NCS_MAPPING is not valid JSON.');
  }
  const parsed = SsoNcsMappingSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`SSO_NCS_MAPPING is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Lower bound for secrets we generate ourselves (the NCS one is issued to us). */
const MIN_GENERATED_SECRET_LENGTH = 32;

/**
 * Startup guard: an enabled provider with a missing secret would boot and then
 * fail every login at runtime. Pure, so it is directly unit-testable.
 */
export function assertSsoConfigured(
  authProvider: 'betterauth' | 'keycloak',
  sso: z.infer<typeof SsoSecretsSchema>
): void {
  const providers = parseSsoProviders(sso.SSO_PROVIDERS);
  if (providers.length === 0) return;

  if (authProvider !== 'keycloak') {
    throw new ConfigError(
      'SSO_PROVIDERS is set but AUTH_PROVIDER is not keycloak. SSO logins are ' +
        'issued by Keycloak, so SSO requires AUTH_PROVIDER=keycloak.'
    );
  }

  const missing: string[] = [];
  if (!sso.SSO_OIDC_SIGNING_KEY) missing.push('SSO_OIDC_SIGNING_KEY');
  if (!sso.SSO_OIDC_CLIENT_SECRET) missing.push('SSO_OIDC_CLIENT_SECRET');
  if (providers.includes('ncs')) {
    if (!sso.SSO_NCS_BASE_URL) missing.push('SSO_NCS_BASE_URL');
    if (!sso.SSO_NCS_CLIENT_ID) missing.push('SSO_NCS_CLIENT_ID');
    if (!sso.SSO_NCS_CLIENT_SECRET) missing.push('SSO_NCS_CLIENT_SECRET');
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `SSO_PROVIDERS=${providers.join(',')} requires: ${missing.join(', ')}.`
    );
  }

  if ((sso.SSO_OIDC_CLIENT_SECRET ?? '').length < MIN_GENERATED_SECRET_LENGTH) {
    throw new ConfigError(
      `SSO_OIDC_CLIENT_SECRET must be at least ${MIN_GENERATED_SECRET_LENGTH} characters.`
    );
  }

  if (providers.includes('ncs')) parseSsoNcsMapping(sso.SSO_NCS_MAPPING);
}
