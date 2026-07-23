import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { uiLoginAs, gotoEn, initialsFor } from '../../src/ui.js';

/**
 * Journey L (UI) — Support dialog (P1). Completes the UI cross-cutting coverage:
 * a signed-in user opens the support dialog from the avatar menu, fills it, and
 * submits. Asserts a terminal toast (sent, or unavailable when SUPPORT_EMAIL
 * isn't configured) — both prove the form wired to POST /api/v1/support.
 */
test.describe('Journey L (UI) — support dialog', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('a signed-in user can open and submit the support dialog', async ({ page, api, service, cfg, caps }) => {
    const user = await createLiveProfileUser(api, service, cfg, caps, { domainKey: cfg.servedDomains[0], label: 'sup' });
    await uiLoginAs(page, user.session.token);
    await gotoEn(page, '/');

    // open the avatar menu (unlabelled button → target by its initials text) → Contact support
    await page.getByRole('button', { name: initialsFor(user.displayName), exact: true }).click();
    await page.getByRole('button', { name: 'Contact support' }).click();

    // the support dialog
    await expect(page.getByRole('heading', { name: 'Contact support' })).toBeVisible();
    await page.getByLabel('Details', { exact: true }).fill('E2E automated support check — please ignore.');
    await page.getByLabel('Email', { exact: true }).fill('e2e-support@signals-e2e.test');
    // consent checkbox (required before submit)
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // a terminal toast appears — sent, or unavailable/error if SUPPORT_EMAIL unset
    const toast = page.getByText(/Message sent|Support is unavailable|Something went wrong|Couldn't send/i);
    await expect(toast.first()).toBeVisible({ timeout: 15_000 });
  });
});
