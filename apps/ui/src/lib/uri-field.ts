/**
 * Turn a stored `x-uri` field value into an href that is safe to put in an
 * `<a>`, or null when it must not be linked. Callers render plain text on null,
 * so a bad or masked value degrades instead of producing a dead link.
 */

/** Display text longer than this is elided; the href always keeps the full value. */
export const URI_DISPLAY_MAX_CHARS = 60;

/**
 * Any explicit `scheme:` prefix, e.g. `https:`, `javascript:`, `mailto:`.
 * Excludes `.` so a scheme-less `host:port` value (`example.com:8080`) is not
 * misread as a non-http scheme and rejected.
 */
const SCHEME_RE = /^[a-z][a-z0-9+-]*:/i;

export function toSafeHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // The API masks uri-ish fields as `https://***` for viewers who have not
  // connected. Never link a stub.
  if (trimmed.includes('***')) return null;

  let candidate: string;
  if (SCHEME_RE.test(trimmed)) {
    // Only http(s) is honoured, which blocks `javascript:` and `data:`.
    if (!/^https?:/i.test(trimmed)) return null;
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  // Must parse as an http(s) URL with a dotted hostname.
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    // Reject userinfo: in `https://trusted.gov.in@evil.example/` the real host
    // is `evil.example`, and head-truncated display text can hide it.
    // `URL_PATTERN` rejects `@`, but this is the last line for values it never
    // saw (required fields skip server validation, values predating the flag,
    // author-supplied `pattern`s).
    if (url.username || url.password) return null;
    // Return the parsed form so the href is exactly what these checks ran
    // against (e.g. `//evil.com` or embedded tabs/backslashes).
    return url.href;
  } catch {
    return null;
  }
}
