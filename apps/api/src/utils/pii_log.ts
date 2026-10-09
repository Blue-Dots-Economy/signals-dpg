/**
 * Mask a phone to its last 4 digits for log lines. No raw phone (PII) is ever
 * placed into a log-bound string.
 */
export function maskPhone(to: string): string {
  const tail = to.replace(/\D/g, '').slice(-4);
  return tail ? `****${tail}` : '****';
}
