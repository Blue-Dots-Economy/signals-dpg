import { test, expect } from '../../src/fixtures.js';
import { createLiveProfileUser, provisioningMethod } from '../../src/flows.js';
import { uiLoginAs, gotoEn } from '../../src/ui.js';
import { requireCapabilities } from '../../src/capabilities.js';

/**
 * Journey (UI) — the match-score modal (P2). Opens it from a browse card and
 * expects it to render the matching factors. The provider (`packages/match_score`)
 * is optional infra — a target that hasn't configured one returns
 * `MATCH_SCORE_NOT_CONFIGURED`, which this spec treats as a genuine SKIP with a
 * reason, not a silently-weakened assertion.
 *
 * `requireCapabilities(['matchScore'])` gates this at the top, before the flow
 * even starts: without `MATCH_SCORE_PROVIDER` configured, `getMatchScoreClient()`
 * returns `undefined` server-side and the UI's own click-to-calculate flow has
 * no real `/match-score/calculate` request to wait for — `waitForResponse`
 * would simply time out (a suite-defect-shaped failure that hides the real
 * "not configured here" reason). The runtime `MATCH_SCORE_NOT_CONFIGURED`
 * check below stays as a second line of defense for a target that reports
 * itself as configured but still answers 503.
 */
test.describe('Journey (UI) — match score modal', () => {
  test.skip(({ cfg, caps }) => provisioningMethod(cfg, caps) === null, 'no way to create users');
  test.skip(({ caps }) => !caps.testOtp, 'requires CREATE_TEST_OTP on the target');

  test('opening the match-score modal on a card renders its factors', async ({ page, api, service, cfg, caps, authCtx }) => {
    requireCapabilities(test, caps, ['matchScore']);
    const sourceDomainKey = cfg.servedDomains[0];
    const targetDomainKey = cfg.servedDomains[1] ?? cfg.servedDomains[0];
    const viewer = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: sourceDomainKey, label: 'mscv' });
    const listing = await createLiveProfileUser(api, service, cfg, caps, { authCtx, domainKey: targetDomainKey, label: 'mscl' });
    const listingLabel = String(listing.itemState.jobProviderName ?? listing.itemState.name ?? listing.displayName);

    await uiLoginAs(page, viewer.session.token);
    await gotoEn(page, '/?view=list');
    await page.getByPlaceholder('Search...').fill(listingLabel);
    await expect(page.getByText(listingLabel, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/match-score/calculate')),
      page.getByRole('button', { name: /See Match Score/i }).first().click(),
    ]);

    if (response.status() === 503) {
      const body = await response.json().catch(() => ({}));
      test.skip(
        body?.error === 'MATCH_SCORE_NOT_CONFIGURED',
        'match-score provider is not configured on this target (MATCH_SCORE_NOT_CONFIGURED)',
      );
    }

    expect(response.status(), `match-score/calculate: ${JSON.stringify(await response.json().catch(() => null))}`).toBe(200);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Matching Factors')).toBeVisible({ timeout: 10_000 });
    // At least one concrete factor row is rendered, not just the empty heading.
    await expect(dialog.locator('li, [class*="factor"]').first()).toBeVisible();
  });
});
