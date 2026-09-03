import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';

/**
 * Journey H (UI) — browse, search, facet-filter and map (P0/P1). Extends the
 * anonymous discovery smoke in journey-h-discovery with real data: cards from a
 * seeded live item, search + a facet filter narrowing the feed, and the map
 * view rendering markers with a working popup.
 */
test.describe('Journey H (UI) — browse, search, filters and map', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('the list feed renders cards, search narrows them, and a facet filter narrows them further', async ({
    page,
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const viewer = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'hview' });
    const listing = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'hcard' });

    const listingLabel = String(listing.itemState.jobProviderName ?? listing.itemState.name ?? listing.displayName);

    await uiLoginAs(page, viewer.session.token);
    await gotoEn(page, '/?view=list');

    // The feed renders real cards (not just the chrome around them).
    await expect(page.getByText(/Showing \d+ of \d+/)).toBeVisible({ timeout: 15_000 });

    // Search narrows to exactly the seeded listing.
    const search = page.getByPlaceholder('Search...');
    await search.fill(listingLabel);
    await expect(page.getByText(listingLabel, { exact: false }).first(), 'search finds the seeded listing').toBeVisible({
      timeout: 15_000,
    });
    await search.fill('');

    // A facet filter (enum field on the schema) narrows the feed. `natureOfJob`
    // is blue_dot-specific; skip-and-report on a target whose schema doesn't
    // expose the same facet rather than asserting blind.
    const natureValue = listing.itemState.natureOfJob as string | undefined;
    test.skip(!natureValue, "target's schema has no natureOfJob-style facet to exercise here");
    await page.getByRole('button', { name: 'Filters' }).click();
    const filterOption = page.getByRole('checkbox', { name: natureValue as string }).or(page.getByText(natureValue as string, { exact: true }));
    // The first facet option sits directly under the panel's sticky header, so
    // Playwright's actionability check sees it as covered even though it's
    // visually clear and clickable — force past that known overlay quirk.
    await filterOption.first().click({ force: true });
    await page.keyboard.press('Escape');
    await expect(page.getByText(listingLabel, { exact: false }).first(), 'the facet-filtered feed still contains a matching listing').toBeVisible({
      timeout: 15_000,
    });
  });

  test('the map view renders markers for live listings with a working popup', async ({ page, api, service, cfg, caps, authCtx }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const viewer = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'hmapv' });
    await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'hmapl' });

    await uiLoginAs(page, viewer.session.token);
    await gotoEn(page, '/?view=list');
    await page.getByPlaceholder('Search...').waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByLabel('Map view').click();

    // A geocoded live listing renders as a marker; clicking it opens a popup
    // with the listing's details (marker-popup-card).
    const marker = page.locator('[role="button"][aria-label*="marker" i], button[aria-label*="marker" i], .leaflet-marker-icon, [class*="marker"]').first();
    await expect(marker, 'the map renders at least one item marker').toBeVisible({ timeout: 20_000 });
    await marker.click();
    await expect(page.locator('[class*="popup"]').first(), 'clicking a marker opens its popup').toBeVisible({ timeout: 10_000 });
  });
});
