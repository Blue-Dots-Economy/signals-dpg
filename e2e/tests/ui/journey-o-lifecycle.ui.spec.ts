import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { resolveBinding } from '../../src/schema.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';

/**
 * Journey O (UI) — pause → resume → retire, driven from the "My Profiles" row
 * (P1). Pausing must pull the item out of discovery; resuming must bring it
 * back; retiring is terminal. The owning persona is seeded via the API; the
 * lifecycle actions themselves, and the discovery check, go through the browser.
 */
test.describe('Journey O (UI) — profile lifecycle from the profile row', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('pausing removes the profile from discovery; resuming brings it back; retiring removes the row', async ({
    page,
    api,
    service,
    cfg,
    caps,
    authCtx,
    browser,
  }) => {
    // Discovery is search-index-backed and each of the 3 waitForDiscoverable
    // polls below can legitimately take up to 60s under load — comfortably
    // over the suite's default 60s test timeout.
    test.setTimeout(300_000);
    // The discovery check searches by the owner's identifying field, so that
    // field must not be `private` (a private field is masked and excluded from
    // server-side text search) — pick whichever served domain's first required
    // field is public, rather than assuming a fixed domain.
    const domainA = cfg.servedDomains[0];
    const domainB = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const bindingA = await resolveBinding(api, domainA);
    const keyA = bindingA.schema.required?.[0];
    const domainAIsPrivate = !!(keyA && bindingA.schema.properties?.[keyA]?.private);
    const ownerDomainKey = domainAIsPrivate && domainB !== domainA ? domainB : domainA;
    const viewerDomainKey = ownerDomainKey === domainA ? domainB : domainA;

    const owner = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: ownerDomainKey, label: 'olife' });
    const viewer = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: viewerDomainKey, label: 'oview' });

    // A second, independent browser tab for the viewer's discovery check.
    const viewerCtx = await browser.newContext();
    const viewerPage = await viewerCtx.newPage();
    await uiLoginAs(viewerPage, viewer.session.token);

    // Check discoverability off the real discover response the browser itself
    // makes when loading the list — not by matching rendered/possibly-masked
    // card text — so this is exact regardless of which field is private.
    async function isDiscoverableOnce(): Promise<boolean> {
      const [resp] = await Promise.all([
        viewerPage.waitForResponse((r) => r.url().includes('/network/item/discover'), { timeout: 20_000 }),
        gotoEn(viewerPage, '/?view=list'),
      ]);
      const body = (await resp.json().catch(() => null)) as { items?: Array<{ item_id: string }> } | null;
      return !!body?.items?.some((i) => i.item_id === owner.itemId);
    }

    // Discovery is search-index-backed and updates asynchronously off the
    // item's lifecycle events, so a transition can lag the UI action under
    // load (this run has seeded a lot of data) — poll rather than check once.
    async function waitForDiscoverable(expected: boolean, label: string): Promise<void> {
      const deadline = Date.now() + 60_000;
      let last = !expected;
      while (Date.now() < deadline) {
        last = await isDiscoverableOnce();
        if (last === expected) return;
        await viewerPage.waitForTimeout(3000);
      }
      expect(last, label).toBe(expected);
    }

    await waitForDiscoverable(true, 'the live profile is discoverable before pausing');

    await uiLoginAs(page, owner.session.token);
    await gotoEn(page, '/?view=list');
    // Single-role lock means the owner has exactly one profile ever, so the
    // lifecycle icon buttons on the "My Profile(s)" row are unambiguous without
    // needing to match the row by its title text first (the sidebar's own
    // title-field resolution is unrelated to lifecycle behaviour and not what
    // this spec is about).
    await page.getByRole('button', { name: 'Pause profile' }).first().waitFor({ state: 'visible', timeout: 15_000 });

    // Pause.
    await page.getByRole('button', { name: 'Pause profile' }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: /Pause this profile/i })).toBeVisible();
    await page.getByRole('button', { name: 'Pause profile' }).last().click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    await waitForDiscoverable(false, 'a paused profile is hidden from discovery');

    // Resume.
    await page.getByRole('button', { name: 'Resume profile' }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: /Resume this profile/i })).toBeVisible();
    await page.getByRole('button', { name: 'Resume profile' }).last().click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    await waitForDiscoverable(true, 'resuming makes the profile discoverable again');

    // Retire (terminal) — the row itself disappears from "My Profile(s)".
    await page.getByRole('button', { name: 'Retire profile' }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: /Retire this profile/i })).toBeVisible();
    await page.getByRole('button', { name: 'Retire permanently' }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Retire profile' })).toHaveCount(0, { timeout: 15_000 });

    await viewerCtx.close();
  });
});
