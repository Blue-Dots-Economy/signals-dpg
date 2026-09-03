import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction, updateActionStatus } from '../../src/actions.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';

/**
 * Journey (UI) — My Actions filter/sort, and the share dialog (P1). Both
 * counterparties and the actions themselves are seeded via the API; only
 * working the Filters sheet, the sort dropdown, and the share dialog goes
 * through the browser.
 */
test.describe('My Actions — filter, sort and share', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('the status filter narrows Initiated to the matching requests, and sort can be changed', async ({
    page,
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const me = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'mapend' });
    const targetPending = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'matgp' });
    const targetRejected = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'matgr' });

    await performAction(me.session, { actionType: cfg.action.type, source: me.sourceRef, target: targetPending.targetRef });
    const { actionId: rejectedId } = await performAction(me.session, {
      actionType: cfg.action.type,
      source: me.sourceRef,
      target: targetRejected.targetRef,
    });
    await updateActionStatus(targetRejected.session, { actionId: rejectedId, status: 'rejected' });

    await uiLoginAs(page, me.session.token);
    await gotoEn(page, '/my-actions');
    await page.getByRole('button', { name: /Initiated/i }).click();
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' })).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Rejected' }).first()).toBeVisible();

    // Status filter: Rejected only.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('button', { name: 'Rejected', exact: true }).click();
    await page.getByRole('button', { name: /close filters/i }).click().catch(() => page.keyboard.press('Escape'));
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Rejected' }).first()).toBeVisible();

    // Back to All, then Pending only.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await page.getByRole('button', { name: /close filters/i }).click().catch(() => page.keyboard.press('Escape'));
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Rejected' })).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' }).first()).toBeVisible();

    // Sort dropdown changes selection.
    await page.getByRole('button', { name: 'Newest' }).click();
    await page.getByRole('menuitem', { name: 'Oldest' }).or(page.getByText('Oldest', { exact: true })).first().click();
    await expect(page.getByRole('button', { name: 'Oldest' })).toBeVisible({ timeout: 5000 });
  });

  test('the share dialog on a live profile produces a public link and a QR code', async ({ page, api, service, cfg, caps, authCtx }) => {
    const me = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: cfg.servedDomains[0], label: 'mshare' });
    const rowLabel = String(me.itemState.name ?? me.itemState.jobProviderName ?? me.displayName);

    await uiLoginAs(page, me.session.token);
    await gotoEn(page, '/?view=list');
    await page.locator(`[title="${rowLabel}"]`).first().waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByRole('button', { name: 'Share profile' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Share profile')).toBeVisible();

    const qr = dialog.getByRole('img', { name: /QR code/i });
    await expect(qr).toBeVisible({ timeout: 10_000 });
    const src = await qr.getAttribute('src');
    expect(src, 'the QR is a rendered image, not a placeholder').toMatch(/^data:image\//);

    const linkText = await dialog.locator('p', { hasText: /^https?:\/\// }).textContent();
    expect(linkText, 'the share link points at this item').toContain(me.itemId);
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeVisible();
  });
});
