import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { getNetworkConfig } from '../../src/schema.js';
import { uiLoginAs, gotoEn, formatDomainLabel } from '../../src/ui.js';

/**
 * Journey D (UI) — send a connection/apply from browse, through the real
 * browser (P0). Seeds both personas via the API (createLiveProfileUser) —
 * only the "browse a counterparty card and act on it" step is the flow under
 * test — then asserts the request lands under My Actions → Initiated.
 */
test.describe('Journey D (UI) — send apply/connect from browse', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('opening a counterparty card and acting on it creates a pending request under Initiated', async ({
    page,
    api,
    service,
    cfg,
    caps,
    authCtx,
  }) => {
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const me = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'dme' });
    const counterparty = await createLiveProfileUser(api, service, cfg, caps, {
      authCtx,
      domainKey: targetDomainKey,
      label: 'dcp',
    });

    const [targetNetwork, targetDomainId] = targetDomainKey.includes('/')
      ? targetDomainKey.split('/')
      : [cfg.network, targetDomainKey];
    const { domains } = await getNetworkConfig(api, targetNetwork);
    const targetLabel = formatDomainLabel(targetDomainId, domains);

    await uiLoginAs(page, me.session.token);
    await gotoEn(page, '/?view=list');

    // Browse defaults to the counterparty's domain for a fresh persona; if it
    // doesn't (multi-role deployments), switch to it explicitly via the domain
    // selector before searching.
    const searchBox = page.getByPlaceholder('Search...');
    await searchBox.waitFor({ state: 'visible', timeout: 15_000 });
    const nameNeedle = String(counterparty.itemState.jobProviderName ?? counterparty.itemState.name ?? counterparty.displayName);
    await searchBox.fill(nameNeedle);
    await page.waitForTimeout(1500);

    if (!(await page.getByText(nameNeedle, { exact: false }).first().isVisible().catch(() => false))) {
      await page.getByRole('button', { name: 'Select' }).click();
      await page.getByRole('button', { name: targetLabel, exact: true }).click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    const card = page.getByText(nameNeedle, { exact: false }).first();
    await expect(card, `counterparty "${nameNeedle}" is discoverable`).toBeVisible({ timeout: 15_000 });

    const actionRegex = new RegExp(`^${cfg.action.type}`, 'i');
    await page.getByRole('button', { name: actionRegex }).first().click();

    // The act confirmation dialog: heading matches the action type, a consent
    // checkbox, then a submit button wired to `action-requirement-form`.
    await expect(page.getByRole('dialog').getByRole('heading', { name: actionRegex })).toBeVisible();
    const consentBox = page.locator('#consent-acknowledge');
    if (await consentBox.isVisible({ timeout: 3000 }).catch(() => false)) {
      await consentBox.click();
    }
    const confirm = page.locator('button[type="submit"][form="action-requirement-form"]');
    await expect(confirm).toBeEnabled({ timeout: 5000 });
    await confirm.click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    // My Actions → Initiated shows the newly created request as Pending.
    await gotoEn(page, '/my-actions');
    await page.getByRole('button', { name: /Initiated/i }).click();
    const initiatedCard = page.locator('xpath=//div[contains(@class, "rounded-[18px]")]').filter({ hasText: targetLabel }).filter({ hasText: 'Pending' }).first();
    await expect(initiatedCard, 'the new request appears under Initiated as Pending').toBeVisible({ timeout: 15_000 });
  });
});
