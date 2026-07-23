import { test as base, expect } from '@playwright/test';
import { loadConfig, type E2EConfig } from './config.js';
import { capabilitiesFor, type Capabilities } from './capabilities.js';
import { ApiClient } from './api-client.js';

/**
 * Base test with the external-mode fixtures every spec needs:
 *  - cfg  : the resolved target config
 *  - caps : capability flags (drive skip-and-report)
 *  - api  : an unauthenticated ApiClient bound to the target API
 *  - service : an ApiClient carrying P5/P6 service-auth headers (if configured)
 *
 * Import `{ test, expect }` from here instead of '@playwright/test'.
 */
export interface E2EFixtures {
  cfg: E2EConfig;
  caps: Capabilities;
  api: ApiClient;
  service: ApiClient;
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
});

export { expect };
