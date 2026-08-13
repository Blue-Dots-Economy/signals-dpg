/**
 * `{{token}}` substitution for externalized email copy (#529).
 *
 * Security boundary: template text comes from the reviewed properties file and
 * is trusted (inserted raw so inline HTML works). Variable VALUES are runtime
 * data: `text` tokens are HTML-escaped on substitution; `html` tokens are
 * inserted raw and may only be produced in code from already-escaped parts.
 * Substitution is best-effort — an undeclared or unprovided `{{token}}` is
 * left in the output verbatim, never an error.
 */
export type TokenTypes = Record<string, 'text' | 'html'>;

/**
 * The one `{{token}}` grammar, shared by the runtime substituter, the boot
 * placeholder lint (messages.ts), and tests — so they can never drift apart.
 */
export const TOKEN_RE = /\{\{([A-Za-z]\w*)\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function substitute(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
  escapeText: boolean,
): string {
  return template.replace(TOKEN_RE, (match, name: string) => {
    // Object.hasOwn, not `name in tokens`/plain indexing: a placeholder named
    // after a prototype member (e.g. {{toString}}, {{constructor}}) must not
    // resolve to an inherited function — that's not a declared/provided
    // token, it's an undeclared one, left verbatim like any other typo.
    if (!Object.hasOwn(tokens, name) || !Object.hasOwn(variables, name)) {
      return match;
    }
    const type = tokens[name];
    const value = variables[name];
    if (type === 'html') return value;
    return escapeText ? escapeHtml(value) : value;
  });
}

/** HTML context (bodies): text tokens escaped, html tokens raw. */
export function substituteHtml(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
): string {
  return substitute(template, variables, tokens, true);
}

/** Plain-text context (subjects): recognised tokens substituted unescaped. */
export function substitutePlain(
  template: string,
  variables: Record<string, string>,
  tokens: TokenTypes,
): string {
  return substitute(template, variables, tokens, false);
}
