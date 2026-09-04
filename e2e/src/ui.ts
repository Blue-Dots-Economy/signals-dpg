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
 *
 * Lands on `/?view=list`, not bare `/`: the home route's *default* view is the
 * map, and once any live item exists to plot, the map view throws inside
 * `@vis.gl/react-google-maps`'s `<AdvancedMarker>` on a target whose Google
 * Maps key is invalid/expired — an uncaught render error with no boundary
 * above it, which unmounts the whole app (`#root` goes empty) and turns this
 * navigation into `page.reload: net::ERR_ABORTED; maybe frame was detached?`.
 * `view=list` is a same-origin route either way, so this is a no-op for any
 * caller that immediately navigates elsewhere.
 */
export async function uiLoginAs(page: Page, token: string): Promise<void> {
  await gotoEn(page, '/?view=list'); // establish the origin so localStorage is scoped to the app
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
 * Drive the real login → OTP UI to create + sign in a brand-new adult, ending
 * on `/profile/new` — NOT `/`. #376's post-login redirect
 * (`lib/post-login-route.ts`'s `resolvePostLoginRedirect`) sends any user with
 * zero profiles straight to profile creation instead of a home page they
 * wouldn't know what to do with, and this helper only ever drives the UI
 * signup form itself (no `item/create` call), so a user it just created
 * always has zero profiles and always lands here — deterministically, not as
 * a possible outcome to branch on. Also handles a guardian-gated domain's
 * birth-year step (SignupDobStep) when the chosen domain requires it, the
 * optional terms/privacy consent modal, and the OTP screen. Assumes the
 * target allows self-signup and runs CREATE_TEST_OTP (OTP fixed to 000000).
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

  // second Continue → consent gate (if configured) then OTP, UNLESS the chosen
  // domain is guardian-gated (`guardian_consent_required`, e.g. blue_dot's
  // `seeker`), in which case this instead reveals a birth-year step
  // (SignupDobStep, apps/ui/src/components/consent/u18/signup-dob-step.tsx)
  // BEFORE consent/OTP. Missing this step here previously stranded the whole
  // signup on that screen (its own Continue stays disabled until a year is
  // picked) — confirmed live: `uiSignupAdult` timed out waiting for the OTP
  // heading with the DOB step's "To create an account, please provide"
  // heading still on screen.
  await page.getByRole('button', { name: 'Continue' }).click();

  // `handleSubmit` awaits an API call (`checkUser`) before deciding whether to
  // render the birth-year step, so which of the THREE possible next screens
  // (birth-year step / consent modal / straight to OTP) is actually showing is
  // NOT yet decided the instant `.click()` above resolves — `.click()` only
  // confirms the click was dispatched, not that the app finished reacting to
  // it. `locator.isVisible()` does NOT wait for this (Playwright's own docs:
  // "does not wait for the element to become visible and returns
  // immediately" — its `timeout` option is deprecated and ignored), so
  // checking it right here would race the async gap and read "not visible"
  // even on a target that WILL show the birth-year step a moment later —
  // confirmed live: this raced every single time, `uiSignupAdult` never once
  // detected the step, and the signup then hung on it forever, timing out
  // deep in the OTP wait below with no explanation of why the OTP screen was
  // never reached. Wait for whichever of the three genuinely appears first
  // instead, THEN branch on which one it was.
  const birthYearSelect = page.getByLabel('Birth year', { exact: true });
  const consentReader = page.getByTestId('consent-reader');
  const otpHeading = page.getByRole('heading', { name: 'Enter verification code' });
  await birthYearSelect.or(consentReader).or(otpHeading).first().waitFor({ state: 'visible', timeout: 15_000 });

  if (await birthYearSelect.isVisible()) {
    // A comfortably-adult year — this helper only ever drives the ADULT
    // signup path (a minor is routed to the pre-auth guardian flow instead,
    // which this helper does not exercise; use SignupGuardianFlow's own
    // journey for that).
    const adultYear = String(new Date().getFullYear() - 30);
    await birthYearSelect.click();
    await page.getByRole('option', { name: adultYear, exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
  }

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

  // Completing the OTP auto-verifies and — per #376's post-login redirect,
  // since this brand-new user has zero profiles — lands on `/profile/new`,
  // not `/`. Confirmed live: waiting on `/` here previously timed out with
  // the browser already sitting on `/profile/new` the whole time.
  await page.waitForURL((url) => new URL(url).pathname === '/profile/new', { timeout: 20_000 });
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
  // `reader.isVisible()` alone does NOT wait (Playwright's own docs: "does
  // not wait for the element to become visible and returns immediately") —
  // the caller's own action just triggered an ASYNC pre-check
  // (`getConsentStatusByIdentifier`/`fetchConsentConfigs` in login-page.tsx)
  // that decides whether this gate renders at all, so an instant check can
  // read "not shown" on a target that WILL show it a moment later — confirmed
  // live: inserting one more async step earlier in a signup flow (a
  // guardian-gated domain's birth-year step) shifted this race just enough to
  // make it lose every time, leaving the gate open and untouched while the
  // caller moved on to wait for a screen that never arrives. Bound the wait
  // instead of skipping it: shown-eventually and never-shown both still
  // resolve correctly, just the latter now takes up to this timeout instead
  // of returning instantly.
  const shown = await reader
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!shown) return; // gate genuinely not shown

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
