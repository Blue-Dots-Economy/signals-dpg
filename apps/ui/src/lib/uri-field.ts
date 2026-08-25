/**
 * Turn a stored `x-uri` field value into an href that is safe to put in an
 * `<a>`, or null when it must not be linked. Callers render plain text on null,
 * so a bad or masked value degrades instead of producing a dead link.
 */

/** Display text longer than this is elided; the href always keeps the full value. */
export const URI_DISPLAY_MAX_CHARS = 60;

/**
 * Any explicit `scheme:` prefix, e.g. `https:`, `javascript:`, `mailto:`.
 * Deliberately excludes `.` from the scheme character class: real URI schemes
 * we care about never contain a dot, and allowing it would misclassify a
 * scheme-less `host:port` value (e.g. `example.com:8080`) as an explicit,
 * non-http scheme and reject it.
 */
const SCHEME_RE = /^[a-z][a-z0-9+-]*:/i;

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
    // Reject userinfo. `https://trusted-looking-host.gov.in@evil.example/` opens
    // `evil.example` — everything before the `@` is a username, not the host. The
    // display text is head-truncated, so a long enough userinfo pushes the real
    // host out of view and the link reads as somewhere it is not. `URL_PATTERN`
    // rejects `@`, but this is the last line for values it never saw: a field
    // that is `required` is not validated server-side at all, values predating a
    // field being flagged are never re-checked, and an author-supplied `pattern`
    // replaces ours. Nothing legitimate in a profile link carries userinfo.
    if (url.username || url.password) return null;
    // Return the PARSED form, so the href we hand the browser is the same thing
    // these checks ran against. Returning the raw string let `//evil.com` through
    // as `https:////evil.com`, and tabs/backslashes survive into the attribute;
    // browsers normalise those to the same destination, so this is hardening
    // rather than a fix, but it removes the gap between checked and used.
    return url.href;
  } catch {
    return null;
  }
}
