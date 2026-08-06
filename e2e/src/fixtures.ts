import { test as base, expect } from '@playwright/test';
import { loadConfig, type E2EConfig } from './config.js';
import { capabilitiesFor, type Capabilities } from './capabilities.js';
import { ApiClient } from './api-client.js';
import { resolveAuthProvider, type AuthContext, type AuthProvider } from './auth.js';
import { Mailpit } from './mailpit.js';

/**
 * Base test with the external-mode fixtures every spec needs:
 *  - cfg      : the resolved target config
 *  - caps     : capability flags (drive skip-and-report)
 *  - api      : an unauthenticated ApiClient bound to the target API
 *  - service  : an ApiClient carrying P5/P6 service-auth headers (if configured)
 *  - authCtx  : what the provider-dispatching signup/login helpers need
 *  - provider : the identity provider the target actually runs ('betterauth' |
 *               'keycloak'), read from GET /api/v1/auth/config unless pinned
 *  - mailpit  : the inbox oracle, or null when no inbox is configured
 *
 * Import `{ test, expect }` from here instead of '@playwright/test'.
 */
export interface E2EFixtures {
  cfg: E2EConfig;
  caps: Capabilities;
  api: ApiClient;
  service: ApiClient;
  authCtx: AuthContext;
  provider: AuthProvider;
  mailpit: Mailpit | null;
}

export const test = base.extend<E2EFixtures>({
  cfg: async ({}, use) => {
    await use(loadConfig());
  },
  caps: async ({ cfg }, use) => {
    await use(capabilitiesFor(cfg));
  },
  api: async ({ request, cfg }, use) => {
    await use(new ApiClient(request, { baseUrl: cfg.apiBaseUrl }));
  },
  service: async ({ request, cfg }, use) => {
    await use(
      new ApiClient(request, {
        baseUrl: cfg.apiBaseUrl,
        apiKey: cfg.auth.serviceApiKey,
        actingOrgId: cfg.auth.actingOrgId,
      }),
    );
  },
  authCtx: async ({ request, cfg }, use) => {
    await use({ cfg, request });
  },
  provider: async ({ api, cfg }, use) => {
    await use(await resolveAuthProvider(api, cfg));
  },
  mailpit: async ({ request, cfg }, use) => {
    await use(cfg.mailpitUrl ? new Mailpit(request, cfg.mailpitUrl) : null);
  },
});

export { expect };
