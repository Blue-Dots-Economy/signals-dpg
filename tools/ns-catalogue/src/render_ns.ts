/**
 * The notification service's email rendering rules, copied for the golden test.
 *
 * Sources (notification-service, branch feat/ns-catalogue-seed / PR #155, plus
 * the Task 0 event-variable change on feat/ns-event-variables):
 *   - src/lib/templates/render.ts   — TOKEN, SUBJECT_BREAKS, escapeHtml,
 *                                     substitute(), the email branch of
 *                                     renderValidated()
 *   - src/lib/templates/contract.ts — validateVariables() / normalise() for
 *                                     `string` and `url` variables
 *   - Ruling R3 (feat/ns-event-variables d86bd8a): an event send ignores
 *     variables its template does not declare; a missing required one still
 *     fails as `missing_variable`.
 *
 * Copied, not imported: the two repos share no package. Keep this file a
 * faithful copy — the golden test is only as good as it. Do not "fix" a rule
 * here to make a golden case pass; a difference is a finding.
 */

import type { NsVariableSpec } from './ns_rules';

export interface NsEmailTemplate {
  subject: string;
  body_html: string;
  variables: NsVariableSpec[];
}

export class NsRenderError extends Error {
  constructor(
    readonly code: 'missing_variable' | 'invalid_variable',
    message: string,
  ) {
    super(message);
  }
}

// render.ts
const TOKEN = /\{\{(\w+)\}\}/g;

// render.ts: C0 controls, DEL, NEL and the Unicode line/paragraph separators.
const SUBJECT_BREAKS = /[\x00-\x1f\x7f\u0085\u2028\u2029]+/g;

// render.ts
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// render.ts
function substitute(
  text: string,
  values: Record<string, string>,
  contract: NsVariableSpec[],
  escape: boolean,
): string {
  const raw = new Set(contract.filter((s) => s.raw).map((s) => s.name));
  return text.replace(TOKEN, (_m, name: string) => {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : '';
    return escape && !raw.has(name) ? escapeHtml(value) : value;
  });
}

// contract.ts normalise(), for the scalar-string inputs Signals sends.
function normalise(spec: NsVariableSpec, value: string): string {
  if (spec.type === 'number') {
    const s = value.trim();
    if (!s || !/^-?\d+(\.\d+)?$/.test(s)) {
      throw new NsRenderError('invalid_variable', `${spec.name} must be a number`);
    }
    return s;
  }
  if (spec.type === 'url') {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new NsRenderError('invalid_variable', `${spec.name} must be a URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new NsRenderError('invalid_variable', `${spec.name} must be http(s)`);
    }
    if (url.username || url.password) {
      throw new NsRenderError('invalid_variable', `${spec.name} host is not allowed`);
    }
    return url.href;
  }
  return value;
}

// contract.ts validateVariables(), with R3's event semantics: undeclared
// input names are ignored rather than rejected.
function validateVariables(
  contract: NsVariableSpec[],
  input: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of contract) {
    const value = Object.prototype.hasOwnProperty.call(input, spec.name) ? input[spec.name] : undefined;
    if (value === undefined || value === '') {
      if (spec.required ?? true) {
        throw new NsRenderError('missing_variable', `missing variable: ${spec.name}`);
      }
      continue;
    }
    out[spec.name] = normalise(spec, value);
  }
  return out;
}

/** What NS sends to the email vendor for this template and these event variables. */
export function renderNsEmail(
  t: NsEmailTemplate,
  input: Record<string, string>,
): { subject: string; html: string } {
  const values = validateVariables(t.variables, input);
  return {
    subject: substitute(t.subject, values, t.variables, false).replace(SUBJECT_BREAKS, ' '),
    html: substitute(t.body_html, values, t.variables, true),
  };
}

/**
 * The text body NS sends for an email template (render.ts renderValidated,
 * email branch): substituted without escaping. Variables are validated as in
 * renderNsEmail.
 */
export function renderNsEmailText(
  t: { body_text: string; variables: NsVariableSpec[] },
  input: Record<string, string>,
): string {
  const values = validateVariables(t.variables, input);
  return substitute(t.body_text, values, t.variables, false);
}
