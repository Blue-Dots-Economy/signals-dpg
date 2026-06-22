import {
  FALLBACK_SERVICE_NAME,
  resolveActionEmailCopy,
  resolveCopyGroup,
  resolveRecipientRole,
} from './action_copy';
import { resolveBrandColor } from './brand';
import type { NotificationShape } from './types';

export interface RenderActionEmailInput {
  actionType: string;
  shape: NotificationShape;
  /** Recipient's item domain (e.g. "seeker" | "provider") — picks the copy. */
  recipientRole: string;
  /** Network id — picks the per-network CTA button colour. */
  network: string;
  /**
   * Counterparty's service name, substituted for `{name}` in seeker-facing
   * copy (the provider's Service Name). Omitted for provider-facing copy,
   * where the seeker stays generic.
   */
  counterpartyName?: string;
  /** Brand / dot-network display name for the sign-off. */
  brandName: string;
  /** Generic CTA link (Phase 1: FRONTEND_BASE_URL + /auth/login). */
  ctaUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEmailShell(args: {
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
    <p>${introHtml}</p>
    <p style="margin: 20px 0;">
      <a href="${url}" style="background-color:${ctaColor};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;">${label}</a>
    </p>
    <p style="font-size:13px;color:#555;">Or open this link: <a href="${url}" style="color:${ctaColor};">${url}</a></p>
    <p style="margin-top:24px;">Thanks,<br/>Team ${brand}</p>
  </div>`;
}

/**
 * Pure function — builds the subject + branded HTML body for one notification,
 * keyed by (action group × recipient role × shape) from the copy table.
 * Subject is plain text; the `{name}` token is HTML-escaped in the body.
 */
export function renderActionEmail(input: RenderActionEmailInput): RenderedEmail {
  const { actionType, shape, recipientRole, network, counterpartyName, brandName, ctaUrl } =
    input;

  const group = resolveCopyGroup(actionType);
  const role = resolveRecipientRole(recipientRole);
  const copy = resolveActionEmailCopy(group, role, shape);

  const name = counterpartyName?.trim() || FALLBACK_SERVICE_NAME;
  const subject = copy.subject.replaceAll('{name}', name);
  const introHtml = copy.body.replaceAll('{name}', escapeHtml(name));

  const html = renderEmailShell({
    introHtml,
    ctaUrl,
    ctaLabel: copy.ctaLabel,
    ctaColor: resolveBrandColor(network),
    brandName,
  });
  return { subject, html };
}
