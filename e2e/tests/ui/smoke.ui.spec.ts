import { test, expect } from '../../src/fixtures.js';

/**
 * UI smoke — proves the running UI is served, renders, and reaches the API.
 * Deeper browser journeys (schema-driven profile form, consent/guardian modals,
 * discovery filters, action modal) are the next increment and need selectors
 * hardened against the running build — see docs/testing strategy §4 (G2).
 */
test.describe('UI smoke', () => {
  test('home page renders', async ({ page }) => {
    const resp = await page.goto('/');
    expect(resp?.ok(), `GET ${page.url()} should load`).toBeTruthy();
    await expect(page.locator('body')).toBeVisible();
    // the app mounts into a root node; assert it is non-empty
    await expect(page.locator('#root, #app, main').first()).toBeVisible();
  });

  test('login page presents an entry field', async ({ page }) => {
    await page.goto('/auth/login');
    // `getByRole('textbox')` rather than a plain `input, [role="textbox"], button`
    // selector: the latter's `.first()` resolves in DOM order, which lands on
    // AuthShell's mobile-only language-switcher combobox (a `display:none`
    // responsive twin of the desktop one, rendered first in markup) rather than
    // the visible Mobile-number/Email field the page actually presents.
    await expect(page.getByRole('textbox').first()).toBeVisible();
  });

  test('the UI can reach the API auth config', async ({ page, cfg }) => {
    // hit the API directly from the browser context to prove cross-origin wiring
    const res = await page.request.get(`${cfg.apiBaseUrl}/api/v1/auth/config`);
    test.skip(res.status() === 404, 'target predates GET /api/v1/auth/config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.selfSignupAllowed).toBe('boolean');
  });
});
