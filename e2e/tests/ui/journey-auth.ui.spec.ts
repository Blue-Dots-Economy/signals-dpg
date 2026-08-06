import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';

/**
 * Authenticated UI enabler (P1). On a gated instance the UI self-signup path is
 * disabled, so we provision a user via API and inject their session token into
 * the browser (`uiLoginAs`) to drive authenticated flows. This proves that
 * mechanism works end-to-end through the real UI via a RequireAuth route.
 */
test.describe('Authenticated UI (provision + token injection)', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('an injected session passes RequireAuth (profile-form loads, no login redirect)', async ({ page, api, service, cfg, caps, authCtx }) => {
    const user = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'uiauth' });
    await uiLoginAs(page, user.session.token);

    // /profile/new is behind RequireAuth — an unauthenticated visit redirects to
    // /auth/login. A successful injected session stays on the profile route.
    await gotoEn(page, '/profile/new');
    await expect(page, 'authenticated user is not redirected to login').not.toHaveURL(/\/auth\/login/);
    await expect(page.locator('#root, #app, main').first()).toBeVisible();
  });

  test('an anonymous visit to a protected route redirects to login (control)', async ({ page }) => {
    await gotoEn(page, '/profile/new');
    await expect(page, 'anonymous is gated to login').toHaveURL(/\/auth\/login/);
  });
});
