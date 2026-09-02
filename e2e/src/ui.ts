import type { Page } from '@playwright/test';
// Explicit `.ts` extensions on these two, unlike the rest of src/ (see ledger.ts
// for the precedent): ui.ts is reached directly by `node --experimental-strip-types`
// via ui-helpers.test.ts, which has no bundler resolving `.js` specifiers back
// to their `.ts` source — a `.js` specifier here throws ERR_MODULE_NOT_FOUND at
// test time (verified). Playwright resolves an explicit `.ts` path just as
// well, so this works in both run modes. The type-only imports below are
// erased entirely by type stripping, so they're unaffected either way.
import { newPhone, newEmail, newName } from './identities.ts';
import type { E2EConfig } from './config.js';
import type { ApiClient } from './api-client.js';
import { getNetworkConfig } from './schema.ts';

/** Append `?lang=en` so text selectors are stable regardless of the target's default language. */
export function withLang(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}lang=en`;
}

export async function gotoEn(page: Page, path: string): Promise<void> {
  await page.goto(withLang(path));
}

/** The 10-digit national part the phone field expects (the UI prepends +91). */
export function nationalPhone(): string {
  return newPhone().replace('+91', '');
}

/**
 * Mirror of the UI's formatDomainLabel (apps/ui/src/lib/domain-icons.ts:57):
 * a network.json `label` wins, else the id is title-cased.
 *
 * The previous version here only title-cased, which agreed with the UI on
 * blue_dot and disagreed on purple_dot, where `provider` renders as "Service
 * Provider" — so every purple_dot UI spec failed to find the domain button.
 * Resolve from the served network config rather than re-deriving.
 */
export function formatDomainLabel(
  domainId: string,
  domains?: ReadonlyArray<{ id: string; label?: string }> | null,
): string {
  const configured = domains?.find((d) => d.id === domainId)?.label?.trim();
  if (configured) return configured;
  return domainId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Authenticate the browser as an already-provisioned user by injecting their
 * better-auth bearer token into localStorage (the UI reads `auth_token` there).
 * Lets UI tests exercise authenticated flows even on a gated instance where the
 * UI self-signup path is disabled — provision via API, then log the browser in.
 */
export async function uiLoginAs(page: Page, token: string): Promise<void> {
  await gotoEn(page, '/'); // establish the origin so localStorage is scoped to the app
  await page.evaluate((t) => localStorage.setItem('auth_token', t), token);
  await page.reload();
}

/** The UI's getInitials() for a name — used to target the (unlabelled) avatar button. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return parts.map((n) => n[0]).join('').toUpperCase().slice(0, 2);
}

export interface UiSignupInput {
  cfg: E2EConfig;
  /** Unauthenticated client, used only to resolve the domain button's label
   * from the served network.json (see formatDomainLabel). */
  api: ApiClient;
  /** Which served domain to sign up into (defaults to the first). */
  domainKey?: string;
  name?: string;
}

/**
 * Drive the real login → OTP UI to create + sign in a brand-new adult, ending on
 * the home page. Assumes the target allows self-signup and runs CREATE_TEST_OTP
 * (OTP fixed to 000000). Handles the two-step signup form and the optional
 * terms/privacy consent modal.
 */
export async function uiSignupAdult(page: Page, input: UiSignupInput): Promise<{ identifierLabel: string }> {
  const { cfg } = input;
  const channel = cfg.loginChannels.includes('phone') ? 'phone' : 'email';
  const name = input.name ?? newName('UiAdult');

  const domainKey = input.domainKey ?? cfg.servedDomains[0];
  // servedDomains entries are "network/domain"; fall back to the configured
  // network for a bare domain id, mirroring the old domainLabelFromKey's split.
  // Deliberately not caught: a missing network_config entry means the target's
  // schema cache isn't in the state this journey assumes, and silently falling
  // back to the title-cased id would click whatever domain button happens to
  // render (or none), signing the user up somewhere the test didn't ask for.
  const [network, domainId] = domainKey.includes('/') ? domainKey.split('/') : [cfg.network, domainKey];
  const { domains } = await getNetworkConfig(input.api, network);
  const domainLabel = formatDomainLabel(domainId, domains);

  await gotoEn(page, '/auth/login');

  // choose channel when both are offered
  if (cfg.loginChannels.length > 1) {
    await page.getByRole('button', { name: channel, exact: true }).click();
  }

  let identifierLabel: string;
  if (channel === 'phone') {
    const national = nationalPhone();
    identifierLabel = `+91${national}`;
    await page.getByLabel('Mobile number').fill(national);
  } else {
    identifierLabel = newEmail('ui');
    await page.getByLabel('Email', { exact: true }).fill(identifierLabel);
  }

  // first Continue → reveals the name + domain fields for a new user
  await page.getByRole('button', { name: /Continue|Send OTP/ }).click();

  // name + domain. The domain toggle is present on current builds; older signup
  // forms omit it — click when present, otherwise proceed.
  await page.getByLabel('Your name').fill(name);
  const domainBtn = page.getByRole('button', { name: domainLabel, exact: true });
  if (await domainBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await domainBtn.click();
  }

  // second Continue → consent gate (if configured) then OTP
  await page.getByRole('button', { name: 'Continue' }).click();

  // optional terms/privacy consent modal. MUST go through passConsentGate, not
  // a direct click — see its docstring (#636).
  await passConsentGate(page);

  // OTP screen: 6 single-digit boxes; fill them with the fixed test OTP
  await page.getByRole('heading', { name: 'Enter verification code' }).waitFor();
  const boxes = page.getByRole('textbox');
  const digits = '000000';
  for (let i = 0; i < digits.length; i++) {
    await boxes.nth(i).fill(digits[i]);
  }

  // completing the OTP auto-verifies and lands on home
  await page.waitForURL((url) => new URL(url).pathname === '/', { timeout: 20_000 });
  return { identifierLabel };
}

/**
 * Clear the consent gate (#636). MUST be used instead of clicking "Accept &
 * Continue" directly: the checkbox and button advertise their disabled state
 * with `aria-disabled` and guard their own handlers, deliberately staying out
 * of `disabled` so they keep keyboard focus. Playwright only waits on the real
 * `disabled` attribute, so a direct click lands, does nothing, and the run
 * fails later somewhere misleading.
 */
export async function passConsentGate(page: Page): Promise<void> {
  const reader = page.getByTestId('consent-reader');
  if (!(await reader.isVisible().catch(() => false))) return; // gate not shown

  const done = page.getByText("That's everything");
  for (let i = 0; i < 40; i += 1) {
    if (await done.isVisible().catch(() => false)) break;
    await reader.evaluate((el) => {
      el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.8, el.scrollHeight);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(60);
  }
  await done.waitFor({ state: 'visible', timeout: 5_000 });

  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: 'Accept & Continue' }).click();
  await page.getByTestId('consent-reader').waitFor({ state: 'hidden', timeout: 15_000 });
}
