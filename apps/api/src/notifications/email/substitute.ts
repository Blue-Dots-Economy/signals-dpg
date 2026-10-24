/**
 * `{{token}}` substitution for email copy.
 *
 * Security boundary: template text comes from the reviewed properties files and
 * is trusted. Variable values are runtime data: `text` tokens are HTML-escaped
 * in HTML context; `html` tokens are inserted raw and must be built in code
 * from escaped parts. An undeclared or unprovided `{{token}}` is left verbatim.
 */
export type TokenTypes = Record<string, 'text' | 'html'>;

/** The `{{token}}` grammar, shared by substitution and the placeholder lint in messages.ts. */
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
    // Object.hasOwn so {{toString}} / {{constructor}} never resolve via the prototype.
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
