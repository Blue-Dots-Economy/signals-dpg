/**
 * Detects values masked by the API's read-time PII masking ("M***",
 * "+91-XX-XXXX-X123"). Geocoding them wastes quota and returns nonsense, so
 * check before issuing a query.
 */
export function looksLikePIIMask(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/\*{3,}/.test(trimmed)) return true;
  // Phone-style runs of three or more X ("+91-XX-XXXX-X123").
  if (/X{3,}/.test(trimmed)) return true;
  // Otherwise: mask characters make up at least 40% of the string.
  const maskChars = trimmed.match(/[*X]/g)?.length ?? 0;
  return maskChars / trimmed.length >= 0.4;
}
