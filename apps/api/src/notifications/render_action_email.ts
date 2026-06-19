import { resolveActionCopy } from './action_copy';
import type { NotificationShape } from './types';

export interface RenderActionEmailInput {
  actionType: string;
  shape: NotificationShape;
  /** Role-generic label for the counterparty, e.g. "a service provider". */
  counterpartyLabel: string;
  /** Actual counterparty name — supplied only when PII reveal is permitted. */
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

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
  brandName: string;
}): string {
  const { introHtml, ctaUrl, ctaLabel, brandName } = args;
  const url = escapeHtml(ctaUrl);
  const brand = escapeHtml(brandName);
  return `
  <div style="font-family: Arial, sans-serif; font-size: 15px; color: #333;">
    <p>Hi!</p>
    <p>${introHtml}</p>
    <p style="margin: 20px 0;">
      <a href="${url}" style="background-color:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;">${ctaLabel}</a>
    </p>
    <p style="font-size:13px;color:#555;">Or open this link: <a href="${url}">${url}</a></p>
    <p style="margin-top:24px;">Thanks,<br/>Team ${brand}</p>
  </div>`;
}

/**
 * Pure function — builds the subject + branded HTML body for one of the four
 * notification shapes. No I/O. Subject is plain text; dynamic values in the
 * HTML body are escaped.
 */
export function renderActionEmail(input: RenderActionEmailInput): RenderedEmail {
  const { actionType, shape, counterpartyLabel, counterpartyName, brandName, ctaUrl } = input;
  const copy = resolveActionCopy(actionType);

  const who = counterpartyName ?? counterpartyLabel;
  const Who = capitalizeFirst(who);
  const whoHtml = escapeHtml(who);
  const WhoHtml = capitalizeFirst(whoHtml);

  let subject: string;
  let introHtml: string;
  let ctaLabel: string;

  switch (shape) {
    case 'INBOUND_REQUEST':
      subject = `${Who} ${copy.inboundPhrase}`;
      introHtml = `${WhoHtml} ${copy.inboundPhrase}. Click below to view the details and respond.`;
      ctaLabel = 'View & respond';
      break;
    case 'OUTBOUND_REQUEST':
      subject = `Your ${copy.objectNoun} has been sent to ${who}`;
      introHtml = `Your ${copy.objectNoun} has been successfully sent to ${whoHtml}. They will be notified and will respond shortly.`;
      ctaLabel = 'Track your request';
      break;
    case 'INBOUND_STATUS':
      subject = `${Who} has responded to your ${copy.objectNoun}`;
      introHtml = `${WhoHtml} has responded to your ${copy.objectNoun}. Check the latest update and take the next step.`;
      ctaLabel = 'View response';
      break;
    case 'OUTBOUND_STATUS':
      subject = `Your response to ${who} has been sent`;
      introHtml = `Your response to ${whoHtml} has been sent successfully. They will be notified.`;
      ctaLabel = 'View details';
      break;
  }

  const html = renderEmailShell({ introHtml, ctaUrl, ctaLabel, brandName });
  return { subject, html };
}
