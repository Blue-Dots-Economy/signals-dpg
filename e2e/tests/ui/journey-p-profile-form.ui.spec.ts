import { test, expect } from '../../src/fixtures.js';
import { provisioningMethod, freshIdentity } from '../../src/flows.js';
import { signup, acceptCoreConsent, resolveAuthProvider } from '../../src/auth.js';
import { newName } from '../../src/identities.js';
import { resolveBinding, buildMinimalItemState, getNetworkConfig, type Binding } from '../../src/schema.js';
import { uiLoginAs, gotoEn, formatDomainLabel } from '../../src/ui.js';
import type { ApiClient } from '../../src/api-client.js';
import type { E2EConfig } from '../../src/config.js';
import type { AuthContext } from '../../src/auth.js';
import type { Capabilities } from '../../src/capabilities.js';

/**
 * Journey P (UI) — create a profile through the real schema-driven form (P0).
 * `apps/ui`'s /profile/new renders its fields straight off the served
 * network.json schema, so this is where schema drift shows up first. The spec
 * resolves the schema itself (never hardcodes a field list) and fills whatever
 * comes back, then asserts the item goes LIVE and is visible in the owner's own
 * "My Profile(s)" list.
 *
 * Only the create-profile flow goes through the browser: the session used to
 * drive it is minted via the API (signup + core consent + adult DOB) rather
 * than replaying journey A's UI signup — that flow is covered on its own.
 */
test.describe('Journey P (UI) — create a profile via the schema-driven form', () => {
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'requires self-signup to mint a bare (no-item) session');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  /** A fresh adult session with NO item yet — the thing the form is about to create. */
  async function createBareAdultSession(
    api: ApiClient,
    cfg: E2EConfig,
    caps: Capabilities,
    authCtx: AuthContext,
    label: string,
  ) {
    const method = provisioningMethod(cfg, caps);
    if (method !== 'signup') {
      throw new Error('[e2e] this spec needs the self-signup path to get a session with no item yet');
    }
    const provider = await resolveAuthProvider(api, cfg);
    const identity = freshIdentity(cfg, label, { provider });
    const displayName = newName(label);
    const session = await signup(api, identity, displayName, authCtx);
    await acceptCoreConsent(session, cfg.network, 'signup');
    // Adult DOB snapshot so a guardian-gated domain can still promote to live.
    await session.client.post('/api/v1/consent/u18/dob', { network: cfg.network, age: 35 });
    return { session, displayName };
  }

  /** Fill every required field of `binding.schema` on the currently-rendered form, generically. */
  async function fillRequiredFields(
    page: import('@playwright/test').Page,
    binding: Binding,
  ): Promise<Record<string, unknown>> {
    const state = buildMinimalItemState(binding.schema);
    const props = binding.schema.properties ?? {};
    for (const key of binding.schema.required ?? []) {
      const propSchema = props[key];
      const value = state[key];
      if (!propSchema || value === undefined) continue;
      const field = page.locator(`#root_${key}`);
      await field.waitFor({ state: 'visible', timeout: 10_000 });
      if (propSchema.enum && propSchema.enum.length > 0) {
        await field.click();
        await page.getByRole('option', { name: String(value), exact: true }).click();
      } else {
        await field.fill(String(value));
      }
    }
    return state;
  }

  test('picking a role, filling the form and saving promotes the profile to live and lists it', async ({
    page,
    api,
    cfg,
    caps,
    authCtx,
  }) => {
    const { session } = await createBareAdultSession(api, cfg, caps, authCtx, 'pform');
    const domainKey = cfg.servedDomains[0];
    const [network, domainId] = domainKey.includes('/') ? domainKey.split('/') : [cfg.network, domainKey];
    const binding = await resolveBinding(api, domainKey);
    const { domains } = await getNetworkConfig(api, network);
    const roleLabel = formatDomainLabel(domainId, domains);

    await uiLoginAs(page, session.token);
    await gotoEn(page, '/profile/new');

    // Role picker (RoleCard) — pick the domain under test. Its accessible name
    // includes the description text too, so match by substring rather than exact.
    await page.locator('button').filter({ hasText: roleLabel }).first().click();

    const state = await fillRequiredFields(page, binding);
    // Whatever value landed in the schema's first required (identifying) field
    // is what the "My Profile(s)" row will show — resolved from the schema, not
    // hardcoded, so this still works if the property is renamed.
    const identifyingKey = binding.schema.required?.[0];
    const identifyingValue = identifyingKey ? String(state[identifyingKey]) : undefined;

    // In-form consent gate before create/publish (distinct from the legal
    // consent-reader gate — a plain checkbox here).
    const consentBox = page.locator('#consent-acknowledge');
    if (await consentBox.isVisible({ timeout: 3000 }).catch(() => false)) {
      await consentBox.click();
    }

    const submit = page.locator('button[type="submit"][form="profile-form"]');
    await expect(submit, 'all required fields resolved to a valid value').toBeEnabled({ timeout: 10_000 });
    await submit.click();

    // Submit navigates away from the create form on success.
    await page.waitForURL((url) => !url.pathname.startsWith('/profile/new'), { timeout: 20_000 });

    // Authoritative check: the item the form created is live.
    let item: { lifecycle_status?: string } | undefined;
    for (let i = 0; i < 6; i++) {
      const res = await session.client.get<{ items: Array<{ lifecycle_status?: string }> }>(
        `/api/v1/item/fetch?item_network=${binding.network}&item_domain=${binding.domain}&item_type=${binding.item_type}&created_by_me=true&limit=10`,
      );
      item = res.body?.items?.[0];
      if (item?.lifecycle_status === 'live') break;
      await page.waitForTimeout(1200);
    }
    expect(item?.lifecycle_status, 'the profile created through the form goes live').toBe('live');

    // Visible in the owner's own list — the sidebar "My Profile(s)"/"My Jobs"
    // group, keyed off the identifying field's value via its title attr.
    expect(identifyingValue, 'schema declares at least one required field to identify the row by').toBeTruthy();
    await gotoEn(page, '/?view=list');
    await expect(page.locator(`[title="${identifyingValue}"]`).first()).toBeVisible({ timeout: 15_000 });
  });
});
