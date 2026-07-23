import { test, expect } from '../../src/fixtures.js';
import { gotoEn } from '../../src/ui.js';

/**
 * Journey H (UI) — Discovery surface for an anonymous visitor (P0 subset).
 * Asserts the discovery top-bar renders (search + map/list toggle) so a visitor
 * can browse without signing in. Seeded-data assertions live in the API journey.
 */
test.describe('Journey H (UI) — anonymous discovery', () => {
  test('the discovery top-bar renders for an anonymous visitor', async ({ page }) => {
    await gotoEn(page, '/');

    // search
    const search = page.getByPlaceholder('Search...');
    await expect(search).toBeVisible();
    await search.fill('teacher');
    await expect(search).toHaveValue('teacher');

    // map / list view toggle
    await expect(page.getByLabel('Map view')).toBeVisible();
    await expect(page.getByLabel('List view')).toBeVisible();
  });
});
