import { test, expect } from '../../src/fixtures.js';
import { gotoEn } from '../../src/ui.js';

/**
 * Journey L (UI) — cross-cutting: language switch + theme toggle (P1 subset).
 * Guards: the language switcher changes the active language; the theme toggle is
 * present and interactive. (Support dialog needs an authed session — next increment.)
 */
test.describe('Journey L (UI) — i18n & theme', () => {
  test('language switcher changes the active language', async ({ page }) => {
    await gotoEn(page, '/');
    const switcher = page.getByRole('combobox', { name: 'Language' });
    await expect(switcher).toBeVisible();
    await expect(switcher, 'pinned via ?lang=en').toContainText('English');

    await switcher.click();
    // Hindi is enabled by default (en,hi) but a deployment may restrict to en only.
    const hindi = page.getByRole('option', { name: 'हिन्दी' });
    const hasHindi = await hindi.isVisible({ timeout: 3000 }).catch(() => false);
    test.skip(!hasHindi, 'target UI offers only one language (Hindi not enabled)');
    await hindi.click();
    // after switching, the combobox aria-label is itself localized, so re-locate
    // by role (the top-bar has one) rather than by the English name.
    await expect(page.getByRole('combobox').first(), 'selecting Hindi updates the switcher').toContainText('हिन्दी');
  });

  test('theme toggle is present and interactive', async ({ page }) => {
    await gotoEn(page, '/');
    const theme = page.getByRole('button', { name: /^Theme:/ });
    await expect(theme).toBeVisible();
    await theme.click();
    await expect(theme, 'toggle remains after switching mode').toBeVisible();
  });
});
