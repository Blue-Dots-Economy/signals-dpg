import { filenameStamp } from './time';

/**
 * Download filename for an engagement export. Carries no PII, since it lands in
 * download history, mail attachments and shared drives: only the network,
 * counterparty domain, status filter and time. The audit `export_id` travels in
 * the `X-Export-Id` header and the `action.export.audit` log line instead.
 */
export function buildExportFilename(input: {
  network: string | undefined;
  counterpartyDomain: string | undefined;
  statuses: readonly string[] | undefined;
  now: Date;
  /** IANA zone for the timestamp (EXPORT_TIMEZONE). */
  timeZone: string;
}): string {
  const part = (s: string) => s.replaceAll(/[^A-Za-z0-9_-]/g, '-');
  const status = input.statuses?.length ? input.statuses.join('-') : 'all';
  // `-` replaces `:`, which Windows forbids in filenames.
  const ts = filenameStamp(input.now, input.timeZone);
  return [
    part(input.network ?? 'export'),
    part(input.counterpartyDomain ?? 'none'),
    part(status),
    ts,
  ].join('_') + '.xlsx';
}
