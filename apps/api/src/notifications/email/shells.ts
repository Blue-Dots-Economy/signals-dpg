import { escapeHtml } from './substitute';

/**
 * HTML shells and code-built fragments for email copy. Layout stays in code;
 * the properties file holds words only. `html` tokens take only code-built
 * fragments whose parts are escaped, like the ones here.
 */

/** Branded action shell (greeting, body, CTA button + fallback link, sign-off). */
export function renderCtaShell(args: {
  introHtml: string;
  ctaUrl: string;
  ctaLabel: string;
  ctaColor: string;
  brandName: string;
}): string {
  const { introHtml, ctaUrl, ctaLabel, ctaColor, brandName } = args;
  const url = escapeHtml(ctaUrl);
  const brand = escapeHtml(brandName);
  const label = escapeHtml(ctaLabel);
  return `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    <p>Hi!</p>
    ${introHtml}
    <p style="margin: 20px 0;">
      <a href="${url}" style="background-color:${ctaColor};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;">${label}</a>
    </p>
    <p style="font-size:13px;color:#555;">Or open this link: <a href="${url}" style="color:${ctaColor};">${url}</a></p>
    <p style="margin-top:24px;">Thanks,<br/>Team ${brand}</p>
  </div>`;
}

/** Plain shell: the font wrapper only — sign-offs live in the copy. */
export function renderPlainShell(bodyHtml: string): string {
  return `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    ${bodyHtml}
  </div>`;
}

/** The monospace OTP code box for OTP emails. */
export function renderOtpBox(otp: string): string {
  return `<div style="
      font-size: 20px;
      font-weight: bold;
      background-color: #f4f4f4;
      padding: 10px 15px;
      border-radius: 6px;
      display: inline-block;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
    ">${escapeHtml(otp)}</div>`;
}

/**
 * The platform link as an `html` token. With no URL it renders the words
 * "the platform" instead of a dead `<a href="">`.
 */
export function renderSiteLink(url: string | undefined): string {
  if (!url) return 'the platform';
  const safe = escapeHtml(url);
  // Inline style because some mail clients (Zoho, Outlook) drop default link
  // styling. Fixed blue, since lighter brand colours are unreadable as body text.
  return `<a href="${safe}" style="color: #1a56db; text-decoration: underline;">${safe}</a>`;
}

/** Numbered provider-org list for the guardian bulk email. */
export function renderOrgList(names: string[]): string {
  if (names.length === 0) return '<p>the selected organisations</p>';
  const items = names.map((n) => '<li>' + escapeHtml(n) + '</li>').join('');
  return `<ol>${items}</ol>`;
}
