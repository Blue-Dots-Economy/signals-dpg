import { randomBytes } from 'node:crypto';

import { escapeHtml } from '@/notifications/email/substitute';

import { formatBytes } from './attachments';

export type SupportType = 'complaint' | 'support_request';

export const TYPE_LABELS: Record<SupportType, string> = {
  complaint: 'Complaint',
  support_request: 'Support Request',
};

// 31 characters with no 0/1/I/L/O ambiguity, for readable refs.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const REFERENCE_LENGTH = 6;
// 256 is not a multiple of 31, so bytes >= 248 are rejected and redrawn to keep
// `byte % 31` uniform (CodeQL js/biased-cryptographic-random).
const REFERENCE_BYTE_LIMIT = 256 - (256 % REFERENCE_ALPHABET.length);

/**
 * Generates a support reference `SUP-YYYYMMDD-XXXXXX`: UTC date plus 6
 * crypto-random characters.
 */
export function generateSupportReference(now: Date): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');

  let suffix = '';
  while (suffix.length < REFERENCE_LENGTH) {
    for (const byte of randomBytes(REFERENCE_LENGTH - suffix.length)) {
      if (byte >= REFERENCE_BYTE_LIMIT) continue;
      suffix += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
    }
  }

  return `SUP-${yyyy}${mm}${dd}-${suffix}`;
}

/**
 * Builds the contact-details table for the support email's `{{detailsTable}}`
 * html token. Every value is HTML-escaped here, which is why the result may be
 * inserted raw.
 */
export function buildSupportDetailsTable(input: {
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  submittedAt: string;
  /** Accepted attachments, for the "Attachments" row. */
  attachments?: Array<{ filename: string; bytes: number }>;
}): string {
  const rows: Array<[string, string]> = [
    ['Reference', input.reference],
    ['Name', input.name],
    ['Phone', input.phone ?? '—'],
    ['Email', input.email ?? '—'],
    ['Submitted at', input.submittedAt],
    ['Consent to share contact', 'Yes'],
  ];
  // Also listed in the body so a client that hides attachments, or one lost in
  // transit, still shows the agent what was sent.
  if (input.attachments?.length) {
    rows.push([
      `Attachments (${input.attachments.length})`,
      input.attachments.map((a) => `${a.filename} (${formatBytes(a.bytes)})`).join(', '),
    ]);
  }
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<p style="margin:0 0 4px;font-weight:600">Contact details</p><table style="border-collapse:collapse;font-size:13px">${detailRows}</table>`;
}
