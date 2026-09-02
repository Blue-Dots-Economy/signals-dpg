import { test as base, expect, request as apiRequest } from '@playwright/test';
import { loadConfig, type E2EConfig } from './config.js';
import { capabilitiesFor, type Capabilities } from './capabilities.js';
import { ApiClient } from './api-client.js';
import { resolveAuthProvider, type AuthContext, type AuthProvider } from './auth.js';
import { Mailpit } from './mailpit.js';

/**
 * Base test with the external-mode fixtures every spec needs:
 *  - cfg      : the resolved target config
 *  - caps     : capability flags (drive skip-and-report)
 *  - api      : an ApiClient bound to the target API, built on the test's own
 *               Playwright `request` context — it looks anonymous (no bearer,
 *               no api key) but is NOT: better-auth's `bearer` plugin makes any
 *               login on this context set a session cookie on the shared jar,
 *               which every client built from the same `request` — this one
 *               included — will carry on its next call. Fine for calls meant to
 *               run in whatever session the test is currently in; **never** use
 *               it for an auth-boundary negative (an "unauthenticated caller
 *               must be rejected" assertion). Use `anon` for that.
 *  - anon     : a genuinely unauthenticated ApiClient on its own fresh
 *               `APIRequestContext` (`playwright.request.newContext()`, not the
 *               per-test `request` fixture) — a separate cookie jar that no
 *               login on this test's `request`/`api`/`service` clients ever
 *               touches, so it cannot inherit a session no matter what ran
 *               earlier in the test. Use it for every "the API must reject an
 *               unauthenticated caller" assertion.
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
  anon: ApiClient;
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
  // `playwright.request` (imported above as `apiRequest`) is the top-level
  // APIRequest factory, not the per-test `request` fixture — `newContext()`
  // opens a brand-new APIRequestContext with its own empty cookie jar that no
  // other fixture's `request` ever writes to, so a login anywhere else in the
  // test cannot make this one appear authenticated. `extraHTTPHeaders` mirrors
  // playwright.config's `use` block so a domain-split target still routes the
  // call correctly; everything else (baseURL) is handled by ApiClient itself.
  anon: async ({ cfg }, use) => {
    const ctx = await apiRequest.newContext({
      extraHTTPHeaders: cfg.servedBindingHost ? { Host: cfg.servedBindingHost } : undefined,
    });
    try {
      await use(new ApiClient(ctx, { baseUrl: cfg.apiBaseUrl }));
    } finally {
      await ctx.dispose();
    }
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
