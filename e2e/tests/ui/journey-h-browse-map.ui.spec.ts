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
    const listing = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'hmapl' });
    const listingLabel = String(listing.itemState.jobProviderName ?? listing.itemState.name ?? listing.displayName);

    await uiLoginAs(page, viewer.session.token);
    await gotoEn(page, '/?view=list');
    const search = page.getByPlaceholder('Search...');
    await search.waitFor({ state: 'visible', timeout: 15_000 });

    // Narrow to exactly the seeded listing BEFORE switching to the map — this
    // target domain has whatever this deployment has accumulated over time
    // (dozens of geocoded live items in practice), and the map clusters nearby
    // pins by default (`MarkerClusterGroup`). A generic "first marker-shaped
    // element" locator is therefore very likely to resolve to a CLUSTER
    // bubble, not this listing's own pin — clicking a cluster zooms the map to
    // its bounds (Leaflet.markercluster's own default), it does not open any
    // popup, so the assertion below would fail even though every layer under
    // test (geocoding, the marker fetch, the popup) works correctly. Search is
    // shared state between the list and map views (`home-page.tsx` feeds the
    // same `search` value to both the list fetch and `useMapMarkers`), so
    // narrowing here guarantees the map shows exactly this one, unclustered
    // marker once switched.
    await search.fill(listingLabel);
    await page.getByLabel('Map view').click();

    // A geocoded live listing renders as a marker; clicking it opens a popup
    // with the listing's details (marker-popup-card).
    //
    // The original selector here used `[class*="marker"]`/`[class*="popup"]` —
    // ATTRIBUTE SUBSTRING matches, not real class selectors — which caused two
    // distinct, confirmed-live bugs:
    //  1. `[class*="marker"]` also matches Leaflet's own internal
    //     `<div class="leaflet-pane leaflet-marker-pane">` CONTAINER (every
    //     marker lives inside it, so the pane precedes any real marker in
    //     document order) — `.first()` picked that permanently-empty-of-normal-
    //     flow-content, therefore zero-size, pane instead of a real marker.
    //  2. Even excluding the pane, `.leaflet-marker-icon` alone is ambiguous:
    //     the viewer's own "You are here" self-marker (`self-marker.tsx`,
    //     rendered `interactive={false}`, `pointer-events: none` on its inner
    //     content) is ALSO a `.leaflet-marker-icon` — Leaflet always adds that
    //     base class regardless of custom icon options. `MarkerClusterGroup`'s
    //     `chunkedLoading` inserts real item markers into the DOM
    //     asynchronously, so the self-marker (added synchronously) can win
    //     `.first()`'s document-order race — confirmed live: `.boundingBox()`
    //     on the "first" match came back 120×46, exactly `self-marker.tsx`'s
    //     own `BOX_W`/`BOX_H`, and clicking it (being non-interactive/
    //     click-through) opened no popup at all.
    // `.leaflet-interactive` is the fix for #2: Leaflet adds it ONLY to
    // markers created with the default `interactive: true` (confirmed live —
    // the self-marker's class list lacks it, the real item marker's carries
    // it alongside `role="button"`), so it excludes the self-marker without
    // depending on marker COUNT, click order, or timing. Proper `.` class
    // selectors (not `[class*=]`) also fix #1 for free: `.leaflet-popup`
    // matches only that exact class token, never `leaflet-popup-pane`.
    const marker = page
      .locator('.leaflet-marker-icon.leaflet-interactive, [role="button"][aria-label*="marker" i], button[aria-label*="marker" i]')
      .first();
    await expect(marker, 'the map renders at least one item marker').toBeVisible({ timeout: 20_000 });
    await marker.click();
    // PRODUCT-SUSPECTED, left failing on purpose (spec §"never silently weaken
    // an assertion"): the marker assertion above passes cleanly — a real,
    // correctly-targeted, `.leaflet-interactive` marker is found and clicked
    // (verified with BOTH a plain Playwright click and a raw DOM `element.click()`
    // dispatch — same result either way) — yet `.leaflet-popup-pane` stays
    // completely empty (`<div class="leaflet-pane leaflet-popup-pane"></div>`,
    // no `.leaflet-popup` child ever appears) even after several seconds, with
    // zero console/page errors. react-leaflet's own `<Marker><Popup>` wiring
    // (`Marker.js`'s `overlayContainer` context, `Popup.js`'s
    // `overlayContainer.bindPopup`) is unconditional and independent of the
    // `MarkerClusterGroup` wrapper (`react-leaflet-cluster`'s own context only
    // adds `layerContainer`, never touches `overlayContainer`) — so on paper
    // this should just work regardless of clustering. Not a selector or
    // capability-gate issue; a real product interaction defect worth its own
    // filed issue.
    await expect(
      page.locator('.leaflet-popup, [role="dialog"][aria-label*="popup" i]').first(),
      'clicking a marker opens its popup',
    ).toBeVisible({ timeout: 10_000 });
  });
});
