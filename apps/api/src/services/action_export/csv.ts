/**
 * CSV cell/line encoding for the engagement export (#770): RFC-4180 quoting,
 * `|`-joined primitive arrays (the network's array-cell convention), and
 * spreadsheet formula-injection neutralisation.
 */

// A cell a spreadsheet would evaluate as a formula. Only strings are
// neutralised — a typed number such as -5 is data.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function toText(value: unknown): { text: string; fromString: boolean } {
  if (value === null || value === undefined) return { text: '', fromString: false };
  if (value instanceof Date) return { text: value.toISOString(), fromString: false };
  if (typeof value === 'string') return { text: value, fromString: true };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value), fromString: false };
  }
  if (Array.isArray(value) && value.every(isPrimitive)) {
    return { text: value.map(String).join('|'), fromString: true };
  }
  return { text: JSON.stringify(value), fromString: false };
}

/** One encoded CSV cell. */
export function csvCell(value: unknown): string {
  const { text, fromString } = toText(value);
  const safe = fromString && FORMULA_LEAD.test(text) ? `'${text}` : text;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One CSV record, CRLF-terminated (RFC 4180). */
export function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(',') + '\r\n';
}
