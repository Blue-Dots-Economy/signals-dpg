import { filenameStamp } from './time';

/**
 * Download filename for an engagement export (#770). Carries no PII — it lands
 * in download history, mail attachments and shared drives — only the network,
 * counterparty domain, status filter, and the first 8 chars of the audit
 * `export_id` that ties the file back to its `bulk_export_audit` row.
 */
export function buildExportFilename(input: {
  network: string | undefined;
  counterpartyDomain: string | undefined;
  statuses: readonly string[] | undefined;
  exportId: string;
  now: Date;
  /** IANA zone for the timestamp (EXPORT_TIMEZONE). */
  timeZone: string;
}): string {
  const part = (s: string) => s.replaceAll(/[^A-Za-z0-9_-]/g, '-');
  const status = input.statuses?.length ? input.statuses.join('-') : 'all';
  // Second precision in the configured zone, with its offset; `-` for `:`
  // (Windows forbids `:` in filenames).
  const ts = filenameStamp(input.now, input.timeZone);
  return [
    part(input.network ?? 'export'),
    part(input.counterpartyDomain ?? 'none'),
    part(status),
    input.exportId.slice(0, 8),
    ts,
  ].join('_') + '.csv';
}
