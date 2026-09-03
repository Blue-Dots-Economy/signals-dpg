import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { performAction } from '../../src/actions.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';

/**
 * Journey E (UI) — accept / reject a received request, and the PII reveal that
 * accept unlocks (P0). Both pending actions are seeded through the API
 * (`performAction`) — the flow under test is the receiver working the Received
 * tab in the browser: viewing a masked profile, accepting it, then seeing the
 * real contact details (`reveals_pii_on_status`), and rejecting a second one.
 */
test.describe('Journey E (UI) — accept / reject and the PII reveal', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('accepting reveals contact details that were masked while pending', async ({ page, api, service, cfg, caps, authCtx }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const source = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'eacc' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'ercv' });

    await performAction(source.session, { actionType: cfg.action.type, source: source.sourceRef, target: target.targetRef });

    // The name that will show up once revealed — resolved from the actual item
    // state the profile was created with, not the signup display name (the
    // form fills the schema's own field, which need not match it).
    const sourceName = String(source.itemState.name ?? source.itemState.jobProviderName ?? source.displayName);

    await uiLoginAs(page, target.session.token);
    await gotoEn(page, '/my-actions');

    const card = page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' }).first();
    await expect(card, 'the pending request is visible on Received').toBeVisible({ timeout: 15_000 });

    // Before accept: the source's private fields (name) are masked.
    await card.getByRole('button', { name: 'View profile' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /View more details/i }).click().catch(() => {});
    const nameRowBefore = dialog.getByText('Full Name').locator('xpath=following-sibling::*[1]');
    await expect(nameRowBefore, 'name is masked before acceptance').not.toHaveText(sourceName);
    await expect(dialog).toContainText('*');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Accept.
    await card.getByRole('button', { name: 'Accept' }).click();
    const acceptDialog = page.getByRole('dialog');
    await expect(acceptDialog.getByRole('heading', { name: /Accept/i })).toBeVisible();
    await acceptDialog.getByRole('checkbox').first().click();
    await acceptDialog.getByRole('button', { name: 'Submit' }).click();
    await expect(acceptDialog).toBeHidden({ timeout: 10_000 });

    // After accept: the same profile now shows the real, unmasked contact details.
    const phone = String(source.itemState.phone ?? source.itemState.hiringManagerPhoneNumber ?? '');
    await page.getByRole('button', { name: 'View profile' }).first().click();
    const revealDialog = page.getByRole('dialog');
    await revealDialog.getByRole('button', { name: /View more details/i }).click();
    await expect(revealDialog, 'full name is revealed after acceptance').toContainText(sourceName);
    if (phone) {
      await expect(revealDialog, 'phone number is revealed after acceptance').toContainText(phone);
    }
  });

  test('rejecting a request marks it rejected and it drops out of Pending', async ({ page, api, service, cfg, caps, authCtx }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const source = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'erej' });
    const target = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'ercv2' });

    const { actionId } = await performAction(source.session, {
      actionType: cfg.action.type,
      source: source.sourceRef,
      target: target.targetRef,
    });

    await uiLoginAs(page, target.session.token);
    await gotoEn(page, '/my-actions');

    const card = page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole('button', { name: 'Reject' }).click();

    const rejectDialog = page.getByRole('dialog');
    await expect(rejectDialog.getByRole('heading', { name: /Reject/i })).toBeVisible();
    await rejectDialog.getByRole('button', { name: 'Submit' }).click();
    await expect(rejectDialog).toBeHidden({ timeout: 10_000 });

    // No pending card left for this request, and the API agrees it's rejected.
    await expect(page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: 'Pending' })).toHaveCount(0);
    const fetched = await target.session.client.get<{ actions: Array<{ action_id: string; action_status: string }> }>(
      '/api/v1/action/fetch?ownership_role=all&limit=100',
    );
    const found = fetched.body?.actions?.find((a) => a.action_id === actionId);
    expect(found?.action_status, 'the action is rejected server-side').toBe('rejected');
  });
});
