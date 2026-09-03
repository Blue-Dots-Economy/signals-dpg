import { test, expect } from '../../src/fixtures.js';
import { gotoEn } from '../../src/ui.js';
// Source of truth for per-network design tokens — imported, not restated, so
// this spec fails the moment the served theme drifts from it (either side).
import { networkThemes } from '../../../apps/ui/src/theme/network-themes.ts';

/**
 * Journey (UI) — per-dot theming (P1). For the network this target is
 * configured for, asserts: `<html>`'s `data-network`/`data-brand`, every
 * resolved `--brand-*` CSS custom property against
 * `apps/ui/src/theme/network-themes.ts`'s entry for that dot, the brand logo
 * `<img>` resolving with a real HTTP 200, the document title, and WCAG AA
 * contrast on the CTA colour pair (computable straight from the resolved
 * colours).
 */
test.describe('Journey (UI) — per-dot theming', () => {
  test('the served dot applies its own data attributes, brand tokens, logo and title', async ({ page, cfg }) => {
    const theme = networkThemes[cfg.network];
    test.skip(!theme, `network-themes.ts has no entry for "${cfg.network}" to compare against`);

    await gotoEn(page, `/?network=${cfg.network}`);
    await page.waitForTimeout(500); // let NetworkThemeProvider's layout effect apply the tokens

    const dataset = await page.evaluate(() => ({
      network: document.documentElement.dataset.network,
      brand: document.documentElement.dataset.brand,
    }));
    expect(dataset.network).toBe(cfg.network);
    expect(dataset.brand).toBe(cfg.brand ?? 'standard');

    // Every --brand-* token must equal the source-of-truth entry exactly.
    const expectedTokens = theme.tokens as unknown as Record<string, string>;
    const brandVarNames = Object.keys(expectedTokens).filter((k) => k.startsWith('--brand-'));
    const resolved = await page.evaluate((names: string[]) => {
      const cs = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
    }, brandVarNames);
    for (const name of brandVarNames) {
      expect(resolved[name], `${name} for ${cfg.network}`).toBe(expectedTokens[name]);
    }

    // The brand logo resolves to a real asset (HTTP 200), not a broken path.
    const logo = page.getByRole('img', { name: `${theme.name} logo` }).first();
    await expect(logo).toBeVisible({ timeout: 10_000 });
    const src = await logo.getAttribute('src');
    expect(src, 'logo has a src').toBeTruthy();
    const logoUrl = new URL(src as string, cfg.uiBaseUrl).toString();
    const logoResp = await page.request.get(logoUrl);
    expect(logoResp.status(), `logo asset ${logoUrl}`).toBe(200);

    // Document title carries the network's brand name.
    await expect(page).toHaveTitle(new RegExp(theme.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // WCAG AA contrast on the CTA colour pair — computable directly from the
    // resolved (browser-normalised) colours regardless of source format
    // (oklch/hex): render them on a probe element and read back sRGB.
    const ratio = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.position = 'fixed';
      probe.style.top = '-9999px';
      probe.style.backgroundColor = 'var(--brand-cta)';
      probe.style.color = 'var(--brand-cta-foreground)';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const bg = cs.backgroundColor;
      const fg = cs.color;
      probe.remove();

      const toRgb = (v: string): [number, number, number] => {
        const m = v.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
        return [m[0], m[1], m[2]];
      };
      const luminance = ([r, g, b]: [number, number, number]) => {
        const chan = (c: number) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
      };
      const lBg = luminance(toRgb(bg));
      const lFg = luminance(toRgb(fg));
      const lighter = Math.max(lBg, lFg);
      const darker = Math.min(lBg, lFg);
      return (lighter + 0.05) / (darker + 0.05);
    });
    expect(ratio, `--brand-cta vs --brand-cta-foreground contrast ratio (${ratio.toFixed(2)}:1) must meet WCAG AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
  });
});
