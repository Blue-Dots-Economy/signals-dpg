export interface SupportSubmitter {
  name: string;
  email: string | null;
  phone: string | null;
  userId: string;
  network: string;
}

export interface BuildSupportEmailInput {
  subject?: string;
  message: string;
  submitter: SupportSubmitter;
  /** ISO-8601 timestamp, stamped by the caller. */
  submittedAt: string;
}

export interface SupportEmail {
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

/** Collapse any CR/LF/tabs to single spaces so they can't break an email header. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the support notification email. Pure: the caller supplies the
 * timestamp and resolved submitter details. All user-controlled strings are
 * HTML-escaped in the body; the subject is flattened to a single line.
 */
export function buildSupportEmail(input: BuildSupportEmailInput): SupportEmail {
  const { message, submitter, submittedAt } = input;
  const trimmedSubject = input.subject?.trim();
  const subjectText = trimmedSubject ? oneLine(trimmedSubject) : 'New support request';
  const subject = `[Support] ${subjectText} — ${oneLine(submitter.name)}`;

  const rows: Array<[string, string]> = [
    ['Name', submitter.name],
    ['Email', submitter.email ?? '—'],
    ['Phone', submitter.phone ?? '—'],
    ['User ID', submitter.userId],
    ['Network', submitter.network],
    ['Submitted at', submittedAt],
  ];
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`
    )
    .join('');

  const html = `<div>
  <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
  <hr />
  <table style="border-collapse:collapse;font-size:13px">${detailRows}</table>
</div>`;

  return { subject, html };
}
