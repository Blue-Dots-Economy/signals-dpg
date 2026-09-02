import type { Page } from '@playwright/test';
import { newPhone, newEmail, newName } from './identities.js';
import type { E2EConfig } from './config.js';

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

/** Mirror the UI's domainLabel(): "blue_dot/seeker" → "Seeker". */
export function domainLabelFromKey(domainKey: string): string {
  const id = domainKey.includes('/') ? domainKey.split('/')[1] : domainKey;
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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
  const domainLabel = domainLabelFromKey(input.domainKey ?? cfg.servedDomains[0]);

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

  // optional terms/privacy consent modal
  const consentAccept = page.getByRole('button', { name: 'Accept & Continue' });
  if (await consentAccept.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.getByRole('checkbox').first().check();
    await consentAccept.click();
  }

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
