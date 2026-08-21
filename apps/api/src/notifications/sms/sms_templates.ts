import { parseProperties } from '../email/parse_properties';

/**
 * SMS template registry (#532/#535). Mirrors the email copy system, but SMS
 * is provider-agnostic and DLT-driven: the on-wire text is owned by the
 * DLT-approved template registered with the operator, so this repo stores only
 * the per-event routing (`template_id`), the variable contract (`vars`), and a
 * REFERENCE `body` — the body is NOT sent (the provider renders from the DLT
 * template); it exists for review + a dev-preview log + drift tests.
 *
 * Properties layout (one `.properties` per network, brand override in a
 * subfolder — same discovery as email `messages.properties`):
 *
 *   profile.create.template_id=1507XXXXXXXXXXXX   # DLT/provider flow id (blank = not approved yet)
 *   profile.create.body=Your profile is ready {{name}}! ... - Team EkStep
 *   profile.create.vars=name
 */

export interface SmsTemplate {
  /** Provider-side (DLT) flow id, sent as the notify `template_id`. Empty until approved. */
  templateId: string;
  /** Reference copy — NOT sent; for review, dev preview, and drift tests. */
  body: string;
  /** Declared variable names the DLT template expects. */
  vars: string[];
}

export type SmsTemplateIndex = Map<string, SmsTemplate>;

const SUFFIXES = ['.template_id', '.body', '.vars'] as const;

/** The case id for a key like `profile.create.body` → `profile.create`. */
function caseIdOf(key: string): string | null {
  for (const s of SUFFIXES) if (key.endsWith(s)) return key.slice(0, -s.length);
  return null;
}

/**
 * Build the SMS template index from layered `.properties` texts (base first,
 * each later layer overrides matching keys — instance < network < brand,
 * mirroring the email loader precedence). Pure: no I/O.
 */
export function loadSmsTemplateIndex(layers: string[]): SmsTemplateIndex {
  const merged = new Map<string, string>();
  for (const text of layers) {
    if (!text) continue;
    for (const [k, v] of parseProperties(text).entries) merged.set(k, v);
  }

  const index: SmsTemplateIndex = new Map();
  const ensure = (id: string): SmsTemplate => {
    let t = index.get(id);
    if (!t) {
      t = { templateId: '', body: '', vars: [] };
      index.set(id, t);
    }
    return t;
  };

  for (const [key, value] of merged) {
    const id = caseIdOf(key);
    if (!id) continue;
    const t = ensure(id);
    if (key.endsWith('.template_id')) t.templateId = value.trim();
    else if (key.endsWith('.body')) t.body = value;
    else if (key.endsWith('.vars'))
      t.vars = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  }
  return index;
}

/**
 * Substitute `{{token}}` placeholders in the reference body. Used ONLY for the
 * dev-preview log (the real render happens provider-side from the DLT
 * template), so it's a plain string replace — no HTML, no escaping needed.
 */
export function renderSmsPreview(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : `{{${name}}}`,
  );
}
