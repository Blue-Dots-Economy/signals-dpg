import { test, expect } from '../../src/fixtures.js';
import { uiSignupAdult, gotoEn } from '../../src/ui.js';

/**
 * Journey A (UI) — Adult self-signup through the real browser flow (P0).
 * Drives the login page (channel toggle, two-step signup form), the terms/privacy
 * consent modal, and the 6-box OTP screen, ending signed-in on home. This is the
 * highest-value UI-orchestration path.
 */
test.describe('Journey A (UI) — self-signup through the browser', () => {
  test.skip(({ cfg }) => cfg.selfSignupMode !== 'allowed', 'target is not self-signup allowed');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP (OTP fixed to 000000) on the target');

  test('a new adult signs up, passes the consent gate, verifies OTP, and lands on home', async ({ page, cfg, api }) => {
    // This drives the current signup form (channel toggle → name + domain → consent → OTP).
    // Targets that predate it (no /api/v1/auth/config) have a structurally different form.
    const acfg = await api.get('/api/v1/auth/config');
    test.skip(acfg.status === 404, 'target predates the current signup UI flow (no /api/v1/auth/config)');

    const { identifierLabel } = await uiSignupAdult(page, { cfg, domainKey: cfg.servedDomains[0] });

    // landed on home, signed in
    expect(new URL(page.url()).pathname).toBe('/');
    // the identifier we signed up with is not shown on the login screen anymore
    expect(page.url()).not.toContain('/auth/login');
    expect(identifierLabel).toBeTruthy();
  });

  test('the login page reflects the target self-signup config (channels render)', async ({ page, cfg }) => {
    await gotoEn(page, '/auth/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // the configured login channel control is present
    const channel = cfg.loginChannels.includes('phone') ? 'Mobile number' : 'Email';
    await expect(page.getByLabel(channel, { exact: true })).toBeVisible();
  });
});
