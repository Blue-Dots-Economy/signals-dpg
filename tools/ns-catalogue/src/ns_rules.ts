/**
 * The notification service's catalogue format and the publish rules a seeded
 * template must pass, copied so the generator can check its own output.
 *
 * Sources (notification-service, branch feat/ns-catalogue-seed / PR #155):
 *   - src/lib/catalogue/schema.ts  — CatalogueSchema, TemplateEntrySchema
 *                                    (provider rule), PolicyCreateSchema, the
 *                                    Slug pattern, size caps, duplicate checks
 *   - src/lib/templates/contract.ts — VariableSpec shape, checkTokensMatchContract
 *   - src/lib/templates/validate.ts — checkNoMalformedTokens, checkUrlAttributes
 *                                    (the email branch of validateForPublish)
 *
 * NS seeds a template that breaks a publish rule as a draft, and refuses the
 * whole file when it breaks the schema. Both are reported here as errors.
 */

export interface NsVariableSpec {
  name: string;
  required?: boolean;
  type?: 'string' | 'number' | 'url';
  sensitive?: boolean;
  raw?: boolean;
}

export interface NsTemplateEntry {
  channel: string;
  template_key: string;
  provider?: string;
  subject?: string;
  body_html?: string;
  body_text?: string;
  provider_template_id?: string;
  variables: NsVariableSpec[];
}

export interface NsPolicyEntry {
  domain: string | null;
  event_type: string;
  mode: 'first_available' | 'all';
  channels: Array<{ channel: string; template_key: string }>;
}

export interface NsCatalogue {
  version: string;
  templates: NsTemplateEntry[];
  policies: NsPolicyEntry[];
}

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const SLUG = /^[a-z0-9_.-]+$/;
const VARIABLE_NAME = /^\w+$/;
const TOKEN = /\{\{(\w+)\}\}/g;
const VALID_TOKEN = /\{\{\w+\}\}/g;
const URL_ATTR = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

function slugOk(value: string, max: number): boolean {
  return SLUG.test(value) && value.length <= max;
}

/** Tokens NS sees in a text (contract.ts `tokensIn`). */
export function nsTokensIn(...texts: (string | undefined)[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN)) found.add(m[1]);
  }
  return found;
}

/** validate.ts `checkNoMalformedTokens`: a stray `{{`/`}}` outside a valid token. */
export function hasMalformedToken(text: string | undefined): boolean {
  if (!text) return false;
  const rest = text.replace(VALID_TOKEN, '');
  return rest.includes('{{') || rest.includes('}}');
}

/** The email publish rules for one template; [] when it would publish. */
export function emailPublishErrors(t: NsTemplateEntry): string[] {
  const errors: string[] = [];
  const where = `${t.channel}/${t.template_key}`;
  if (!t.subject || (!t.body_html && !t.body_text)) {
    errors.push(`${where}: email needs a subject and a body`);
    return errors;
  }
  if ([t.subject, t.body_html, t.body_text].some(hasMalformedToken)) {
    errors.push(`${where}: malformed token`);
  }
  const tokens = nsTokensIn(t.subject, t.body_html, t.body_text);
  const declared = new Set(t.variables.map((v) => v.name));
  const undeclared = [...tokens].filter((n) => !declared.has(n));
  if (undeclared.length) errors.push(`${where}: undeclared tokens: ${undeclared.join(', ')}`);
  const unused = [...declared].filter((n) => !tokens.has(n));
  if (unused.length) errors.push(`${where}: declared but unused: ${unused.join(', ')}`);
  const byName = new Map(t.variables.map((v) => [v.name, v]));
  for (const m of (t.body_html ?? '').matchAll(URL_ATTR)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    for (const tok of value.matchAll(VALID_TOKEN)) {
      const name = tok[0].slice(2, -2);
      if (byName.get(name)?.type !== 'url') {
        errors.push(`${where}: ${name} is used in an href/src attribute and must be type url`);
      }
    }
  }
  return errors;
}

/** The catalogue schema rules (schema.ts); a break here makes NS refuse the whole file. */
export function catalogueSchemaErrors(c: NsCatalogue): string[] {
  const errors: string[] = [];
  if (!VERSION.test(c.version)) errors.push(`version "${c.version}" is not [A-Za-z0-9._-]{1,64}`);
  if (c.templates.length > 500) errors.push('more than 500 templates');
  if (c.policies.length > 500) errors.push('more than 500 policies');

  const seenT = new Set<string>();
  c.templates.forEach((t, i) => {
    const where = `templates.${i} (${t.channel}/${t.template_key})`;
    if (!t.channel || t.channel.length > 32) errors.push(`${where}: channel length`);
    if (!slugOk(t.template_key, 128)) errors.push(`${where}: template_key is not a slug`);
    if (t.channel !== 'email' && t.provider === undefined) {
      errors.push(`${where}: provider is required for non-email channels`);
    }
    if (t.provider !== undefined && (t.provider.length < 1 || t.provider.length > 32)) {
      errors.push(`${where}: provider length`);
    }
    if ((t.subject?.length ?? 0) > 998) errors.push(`${where}: subject over 998 characters`);
    if ((t.body_html?.length ?? 0) > 200_000) errors.push(`${where}: body_html over 200000 characters`);
    if ((t.body_text?.length ?? 0) > 10_000) errors.push(`${where}: body_text over 10000 characters`);
    if ((t.provider_template_id?.length ?? 0) > 255) errors.push(`${where}: provider_template_id length`);
    if (t.variables.length > 50) errors.push(`${where}: more than 50 variables`);
    const names = t.variables.map((v) => v.name);
    if (new Set(names).size !== names.length) errors.push(`${where}: variable names must be unique`);
    for (const v of t.variables) {
      if (!VARIABLE_NAME.test(v.name) || v.name.length > 64) errors.push(`${where}: bad variable name ${v.name}`);
      if (v.name in Object.prototype) errors.push(`${where}: variable name ${v.name} is reserved`);
    }
    const k = [t.channel, t.template_key, '', t.provider ?? ''].join('\u0000');
    if (seenT.has(k)) errors.push(`${where}: duplicate template`);
    seenT.add(k);
  });

  const seenP = new Set<string>();
  c.policies.forEach((p, i) => {
    const where = `policies.${i} (${p.domain ?? 'null'}/${p.event_type})`;
    if (p.domain !== null && !slugOk(p.domain, 64)) errors.push(`${where}: domain is not a slug`);
    if (!slugOk(p.event_type, 64)) errors.push(`${where}: event_type is not a slug`);
    if (p.channels.length > 10) errors.push(`${where}: more than 10 channels`);
    for (const ch of p.channels) {
      if (!ch.channel || ch.channel.length > 32) errors.push(`${where}: channel length`);
      if (!slugOk(ch.template_key, 128)) errors.push(`${where}: channel template_key is not a slug`);
    }
    const k = [p.domain ?? '', p.event_type].join('\u0000');
    if (seenP.has(k)) errors.push(`${where}: duplicate policy`);
    seenP.add(k);
  });
  return errors;
}

/**
 * Every schema and publish rule NS applies to a catalogue file. An empty list
 * means NS would accept the file and publish every entry.
 */
export function catalogueErrors(c: NsCatalogue): string[] {
  return [
    ...catalogueSchemaErrors(c),
    ...c.templates.filter((t) => t.channel === 'email').flatMap(emailPublishErrors),
  ];
}
