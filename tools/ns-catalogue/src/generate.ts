import {
  ACTION_CANCELLED_BY_RETIRE,
  ACTION_EVENT_SHAPES,
  GUARDIAN_OTP_KINDS,
  ITEM_EVENT,
  ITEM_ONBOARDED,
  SUPPORT_REQUEST,
  USER_WELCOME,
  actionEvent,
  guardianEvent,
  type ItemEvent,
} from '@dpg/notification';

import { knownCopyKeys } from './copy';
import { resolveCopyGroup, resolveRecipientRole, type RecipientRole } from './legacy/action_copy';
import { resolveBrandColor } from './legacy/brand';
import { oneLine } from './legacy/dispatch_email';
import { EMAIL_CASE_IDS, getEmailCase, type EmailCaseDef } from './legacy/email_cases';
import { renderCtaShell, renderOtpBox, renderPlainShell, renderSiteLink } from './legacy/shells';
import { escapeHtml, substituteHtml, substitutePlain } from './legacy/substitute';
import {
  catalogueSchemaErrors,
  emailPublishErrors,
  nsTokensIn,
  type NsCatalogue,
  type NsPolicyEntry,
  type NsTemplateEntry,
  type NsVariableSpec,
} from './ns_rules';

export type { NsCatalogue } from './ns_rules';

export interface CatalogueInput {
  /** network.json `id` (e.g. `onest_yellow_dot`, not the directory name). */
  networkId: string;
  /** network.json domain ids. */
  domains: string[];
  /** network.json action types (the keys of `actions`). */
  actionTypes: string[];
  /** Copy merged per key: defaults < network < brand (F2-3). */
  copy: Map<string, string>;
  /** e.g. the schemas repo's short SHA plus the date. */
  version: string;
}

/**
 * The Twilio content template for the welcome WhatsApp message. Same id as
 * apps/api/src/notifications/welcome.ts `WELCOME_WHATSAPP_CONTENT_SID`.
 */
export const WHATSAPP_WELCOME_CONTENT_SID = 'HX3f2a5d7e4a18e5664124592a12a154eb';
const WHATSAPP_PROVIDER = 'twilio';

/** NS seeds the SMS OTP template from env per vendor (F2-7); policies only name it. */
export const SMS_OTP_TEMPLATE_KEY = 'login_otp';

/** Event types of the policies in `catalogue` that name the SMS `login_otp` template. */
export function loginOtpPolicyEvents(catalogue: NsCatalogue): string[] {
  return catalogue.policies
    .filter((p) => p.channels.some((c) => c.channel === 'sms' && c.template_key === SMS_OTP_TEMPLATE_KEY))
    .map((p) => p.event_type);
}

/**
 * The deployment note the CLI prints for catalogues whose policies name the SMS
 * `login_otp` template (R10): NS publishes those policies once its login_otp SMS
 * template (id, plus body text for pinnacle) is configured for the active vendor. `null` when no directory needs it.
 */
export function loginOtpNote(dirs: string[]): string | null {
  if (dirs.length === 0) return null;
  return [
    `note: the guardian OTP policies in ${dirs.join(', ')} name the SMS template '${SMS_OTP_TEMPLATE_KEY}'.`,
    `  NS publishes them once its ${SMS_OTP_TEMPLATE_KEY} SMS template is configured for the active SMS vendor:`,
    '  SMS_LOGIN_OTP_TEMPLATE_ID (msg91), or PINNACLE_LOGIN_OTP_TEMPLATE_ID together with SMS_LOGIN_OTP_BODY (pinnacle).',
    '  Set it on every cluster that loads these catalogues.',
  ].join('\n');
}

/** `login.otp` has no live caller: Keycloak sends login OTPs (F3). */
const NOT_GENERATED = new Set(['login.otp']);

/** The OTP cases, whose code is the `message` variable (F2-8). */
const OTP_CASES = new Set(['guardian.account', 'guardian.profile', 'guardian.action', 'guardian.action_bulk', 'otp.generic']);

/** Variables a sender may legitimately send empty today, so NS must not require them. */
const OPTIONAL_VARIABLES = new Set(['fromSite']);

const URL_VARIABLES = new Set(['ctaUrl', 'siteUrl']);
const SENSITIVE_VARIABLES = new Set(['message']);

/** Every email case the catalogue carries. */
export function generatedCaseIds(): string[] {
  return EMAIL_CASE_IDS.filter((id) => !NOT_GENERATED.has(id));
}

const tok = (name: string) => `{{${name}}}`;

/**
 * F2-2: the support contact-details table as fixed template rows. Same markup
 * as today's `buildSupportDetailsTable`; the values become variables and the
 * attachments row is always present, fed by `attachmentsSummary`.
 */
export function supportDetailsTableTemplate(): string {
  const rows: Array<[string, string]> = [
    ['Reference', tok('reference')],
    ['Name', tok('name')],
    ['Phone', tok('phone')],
    ['Email', tok('email')],
    ['Submitted at', tok('submittedAt')],
    ['Consent to share contact', 'Yes'],
    ['Attachments', tok('attachmentsSummary')],
  ];
  const detailRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 8px;color:#666">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 8px">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<p style="margin:0 0 4px;font-weight:600">Contact details</p><table style="border-collapse:collapse;font-size:13px">${detailRows}</table>`;
}

/**
 * The values that turn today's renderer into a template generator: each text
 * token renders as its own `{{name}}` (escapeHtml leaves `{{x}}` unchanged),
 * and each code-built html token becomes its F2-2 template form.
 */
function passthroughValues(caseId: string, def: EmailCaseDef): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, type] of Object.entries(def.tokens)) {
    if (type === 'text') {
      values[name] = name === 'otp' && OTP_CASES.has(caseId) ? tok('message') : tok(name);
      continue;
    }
    switch (name) {
      case 'otpBox':
        values.otpBox = renderOtpBox(tok('message'));
        break;
      case 'siteLink':
        values.siteLink = renderSiteLink(tok('siteUrl'));
        break;
      case 'orgList':
        values.orgList = tok('orgList');
        break;
      case 'detailsTable':
        values.detailsTable = supportDetailsTableTemplate();
        break;
      default:
        throw new Error(`case ${caseId}: html token ${name} has no template form`);
    }
  }
  return values;
}

/** The variable names a case's template may legitimately carry. */
function caseVariableNames(caseId: string, def: EmailCaseDef): Set<string> {
  const names = new Set<string>();
  for (const [name, type] of Object.entries(def.tokens)) {
    if (type === 'text') names.add(name === 'otp' && OTP_CASES.has(caseId) ? 'message' : name);
  }
  if (def.tokens.otpBox) names.add('message');
  if (def.tokens.siteLink) names.add('siteUrl');
  if (def.tokens.orgList) names.add('orgList');
  if (def.tokens.detailsTable) {
    for (const n of ['reference', 'name', 'phone', 'email', 'submittedAt', 'attachmentsSummary']) names.add(n);
  }
  if (def.shell === 'cta') {
    names.add('ctaUrl');
    names.add('teamName');
  }
  return names;
}

function copyOf(copy: Map<string, string>, key: string): string {
  const value = copy.get(key);
  if (value === undefined) throw new Error(`copy is missing key ${key}`);
  return value;
}

function buildEmailTemplate(
  caseId: string,
  input: CatalogueInput,
  warnings: string[],
): NsTemplateEntry {
  const def = getEmailCase(caseId);
  const values = passthroughValues(caseId, def);

  // A token the case does not declare is sent verbatim by Signals today; NS
  // substitutes every {{token}}, so it renders empty there. Report it.
  const declared = caseVariableNames(caseId, def);
  const copyKeys = [def.keys.subject, def.keys.body, def.keys.cta].filter((k): k is string => Boolean(k));
  for (const key of copyKeys) {
    for (const name of nsTokensIn(copyOf(input.copy, key))) {
      if (!Object.hasOwn(def.tokens, name)) {
        warnings.push(
          `template ${caseId}: copy "${key}" uses {{${name}}}, which the case does not declare; Signals sends it verbatim today, NS renders it empty`,
        );
      }
    }
  }

  const subject = oneLine(substitutePlain(copyOf(input.copy, def.keys.subject), values, def.tokens));
  const bodyHtml = substituteHtml(copyOf(input.copy, def.keys.body), values, def.tokens);
  const html =
    def.shell === 'cta'
      ? renderCtaShell({
          introHtml: bodyHtml,
          ctaUrl: tok('ctaUrl'),
          ctaLabel: substitutePlain(copyOf(input.copy, def.keys.cta as string), values, def.tokens),
          ctaColor: resolveBrandColor(input.networkId),
          brandName: tok('teamName'),
        })
      : renderPlainShell(bodyHtml);

  const variables: NsVariableSpec[] = [...nsTokensIn(subject, html)].sort().map((name) => {
    const spec: NsVariableSpec = {
      name,
      type: URL_VARIABLES.has(name) ? 'url' : 'string',
      required: declared.has(name) && !OPTIONAL_VARIABLES.has(name),
    };
    if (SENSITIVE_VARIABLES.has(name)) spec.sensitive = true;
    return spec;
  });

  const template: NsTemplateEntry = {
    channel: 'email',
    template_key: caseId,
    subject,
    body_html: html,
    variables,
  };
  for (const error of emailPublishErrors(template)) warnings.push(`NS would reject ${error}`);
  return template;
}

const ITEM_CASE_SUFFIX: Record<ItemEvent, string> = {
  [ITEM_EVENT.created]: 'create',
  [ITEM_EVENT.created_draft]: 'create_incomplete',
  [ITEM_EVENT.updated]: 'update',
  [ITEM_EVENT.paused]: 'pause',
  [ITEM_EVENT.retired]: 'retire',
};

const ITEM_ENTITY: Record<RecipientRole, string> = { seeker: 'profile', provider: 'offer' };

function emailPolicy(domain: string | null, eventType: string, templateKey: string): NsPolicyEntry {
  return { domain, event_type: eventType, mode: 'all', channels: [{ channel: 'email', template_key: templateKey }] };
}

function welcomePolicy(domain: string | null, emailKey: string): NsPolicyEntry {
  return {
    domain,
    event_type: USER_WELCOME,
    mode: 'all',
    channels: [
      { channel: 'email', template_key: emailKey },
      { channel: 'whatsapp', template_key: 'welcome' },
    ],
  };
}

function otpPolicy(eventType: string, emailKey: string): NsPolicyEntry {
  return {
    domain: null,
    event_type: eventType,
    mode: 'first_available',
    channels: [
      { channel: 'email', template_key: emailKey },
      { channel: 'sms', template_key: SMS_OTP_TEMPLATE_KEY },
    ],
  };
}

/** One policy per (domain, event) the network can produce, plus the domain-less ones. */
function buildPolicies(input: CatalogueInput, warnings: string[]): NsPolicyEntry[] {
  const policies: NsPolicyEntry[] = [];
  for (const domain of input.domains) {
    const role = resolveRecipientRole(domain);
    if (role === 'seeker' && domain !== 'seeker') {
      warnings.push(`domain "${domain}" is not a known provider-like domain; it gets the seeker copy (resolveRecipientRole default)`);
    }
    for (const actionType of input.actionTypes) {
      const group = resolveCopyGroup(actionType);
      for (const shape of ACTION_EVENT_SHAPES) {
        policies.push(emailPolicy(domain, actionEvent(actionType, shape), `action.${group}.${role}.${shape}`));
      }
    }
    policies.push(emailPolicy(domain, ACTION_CANCELLED_BY_RETIRE, 'retire.cancel'));
    for (const event of Object.values(ITEM_EVENT)) {
      policies.push(emailPolicy(domain, event, `${ITEM_ENTITY[role]}.${ITEM_CASE_SUFFIX[event]}`));
    }
    policies.push(emailPolicy(domain, ITEM_ONBOARDED, `account.aggregator_init.${role}`));
    policies.push(welcomePolicy(domain, `welcome.${role}`));
  }
  policies.push(welcomePolicy(null, 'welcome'));
  for (const kind of GUARDIAN_OTP_KINDS) policies.push(otpPolicy(guardianEvent(kind), `guardian.${kind}`));
  policies.push(otpPolicy(guardianEvent('generic'), 'otp.generic'));
  policies.push(emailPolicy(null, SUPPORT_REQUEST, 'support.request'));
  return policies;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Build one network's NS catalogue: an email template per live case, the
 * WhatsApp welcome, and every policy. Pure; the CLI does the file work.
 */
export function buildCatalogue(input: CatalogueInput): { catalogue: NsCatalogue; warnings: string[] } {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.version)) {
    throw new Error(`catalogue version "${input.version}" must match [A-Za-z0-9._-]{1,64}`);
  }
  const warnings: string[] = [];

  const known = knownCopyKeys();
  for (const key of input.copy.keys()) {
    if (!known.has(key)) warnings.push(`copy key "${key}" is not a known case key; ignored`);
  }

  const templates: NsTemplateEntry[] = generatedCaseIds().map((id) => buildEmailTemplate(id, input, warnings));
  templates.push({
    channel: 'whatsapp',
    template_key: 'welcome',
    provider: WHATSAPP_PROVIDER,
    provider_template_id: WHATSAPP_WELCOME_CONTENT_SID,
    variables: [{ name: '1', type: 'string', required: true }],
  });
  templates.sort((a, b) => compare(a.channel, b.channel) || compare(a.template_key, b.template_key));

  const policies = buildPolicies(input, warnings);
  policies.sort((a, b) => compare(a.domain ?? '', b.domain ?? '') || compare(a.event_type, b.event_type));

  const catalogue: NsCatalogue = { version: input.version, templates, policies };
  // Publish errors are reported per template above; these are the file-level ones.
  for (const error of catalogueSchemaErrors(catalogue)) warnings.push(`NS would reject the catalogue: ${error}`);
  return { catalogue, warnings };
}
