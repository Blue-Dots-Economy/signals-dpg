/**
 * Legacy copy of apps/api/src/support/build_support_email.ts
 * `buildSupportDetailsTable` (and `formatBytes` from support/attachments.ts),
 * so the golden test can render today's support email.
 */
import { escapeHtml } from './substitute';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Builds the escaped contact-details table for the support email — the
 * `{{detailsTable}}` html token (#529). Pure; all user-controlled strings are
 * HTML-escaped here, which is what licenses inserting the result raw.
 */
export function buildSupportDetailsTable(input: {
  reference: string;
  name: string;
  email: string | null;
  phone: string | null;
  submittedAt: string;
  /** Accepted attachments, for the "Attachments" row (#551). */
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
  // Listed in the body as well as carried as MIME parts, so a client that
  // collapses or hides attachments still tells the agent what was sent — and an
  // attachment lost in transit is visible as a discrepancy rather than silence.
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
