import { parseProperties } from '../email/parse_properties';

/**
 * SMS template registry. The sent text is the DLT-approved template held by
 * the provider, so this stores only the `template_id`, the variable contract
 * (`vars`) and a reference `body` that is never sent (review, dev preview and
 * drift tests only).
 *
 * Properties layout (one file per network, brand override in a subfolder):
 *
 *   profile.create.template_id=1507XXXXXXXXXXXX   # DLT/provider flow id (blank = not approved yet)
 *   profile.create.body=Your profile is ready {{name}}! ... - Team EkStep
 *   profile.create.vars=name
 */

export interface SmsTemplate {
  /** Provider-side (DLT) flow id, sent as the notify `template_id`. Empty until approved. */
  templateId: string;
  /** Reference copy; never sent. */
  body: string;
  /** Declared variable names the DLT template expects. */
  vars: string[];
}

export type SmsTemplateIndex = Map<string, SmsTemplate>;

const SUFFIXES = ['.template_id', '.body', '.vars'] as const;

/** `profile.create.body` → `profile.create`. */
function caseIdOf(key: string): string | null {
  for (const s of SUFFIXES) if (key.endsWith(s)) return key.slice(0, -s.length);
  return null;
}

/** Builds the SMS template index from layered `.properties` texts; later layers win per key. */
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

/** Substitutes `{{token}}` in the reference body for the dev-preview log; no escaping. */
export function renderSmsPreview(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    Object.hasOwn(variables, name) ? variables[name]! : `{{${name}}}`,
  );
}
