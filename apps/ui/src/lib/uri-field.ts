/**
 * Turn a stored `x-uri` field value into an href that is safe to put in an
 * `<a>`, or null when it must not be linked. Callers render plain text on null,
 * so a bad or masked value degrades instead of producing a dead link.
 */

/** Display text longer than this is elided; the href always keeps the full value. */
export const URI_DISPLAY_MAX_CHARS = 60;

/** Any explicit `scheme:` prefix, e.g. `https:`, `javascript:`, `mailto:`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function toSafeHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Masked public projection (the API rewrites uri-ish fields to `https://***`
  // for viewers who have not connected). Never link a stub.
  if (trimmed.includes('***')) return null;

  let candidate: string;
  if (SCHEME_RE.test(trimmed)) {
    // An explicit scheme is honoured only if it is http(s); this is what blocks
    // `javascript:` and `data:`.
    if (!/^https?:/i.test(trimmed)) return null;
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  // Final gate: it must parse as a real URL with an http(s) protocol and a host
  // that looks like a hostname (a dot, and no spaces).
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return candidate;
  } catch {
    return null;
  }
}
