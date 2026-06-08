/**
 * Guard against geocoding masked PII values surfaced by the API's read-time
 * masking. When the backend serves a private field to an unprivileged caller it
 * replaces its value with a mask (e.g. "M***", "+91-XX-XXXX-X123"). Passing
 * these strings to a geocoding service wastes quota and returns nonsense
 * results, so callers should check this before issuing a query.
 */
export function looksLikePIIMask(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  // Common mask: any string containing "***".
  if (/\*{3,}/.test(trimmed)) return true;
  // Phone-style: contains "XX" runs (e.g. "+91-XX-XXXX-X123")
  if (/X{3,}/.test(trimmed)) return true;
  // Heuristic: anything where mask-chars are >= 40% of the string
  const maskChars = trimmed.match(/[*X]/g)?.length ?? 0;
  return maskChars / trimmed.length >= 0.4;
}
