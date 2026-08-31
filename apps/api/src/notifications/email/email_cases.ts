import type { TokenTypes } from './substitute';

/**
 * The email case registry (#529): one entry per email the system sends. This
 * is the issue's "stable template_ids per case" — internal to Signals; the
 * wire template_id stays 'basic_email' (the notification service's email
 * provider registers no other template).
 *
 * Per case: which properties-file keys hold its copy, which {{tokens}} its
 * copy may use (text = escaped on substitution, html = code-built raw
 * fragments), which HTML shell wraps the body, whether a send failure is
 * critical (throws to the caller) or best-effort (logged, never blocks the
 * triggering action), and the notification-service priority.
 */
export type EmailShell = 'cta' | 'plain';
export type EmailCriticality = 'critical' | 'best_effort';

export interface EmailCaseDef {
  keys: { subject: string; body: string; cta?: string };
  tokens: TokenTypes;
  shell: EmailShell;
  criticality: EmailCriticality;
  priority: 'realtime' | 'other';
}

const ACTION_GROUPS = ['connect', 'apply'] as const;
const ACTION_ROLES = ['seeker', 'provider'] as const;
const ACTION_SHAPES = [
  'inbound_request',
  'outbound_request',
  'inbound_status',
  'outbound_status',
] as const;

function ctaCase(prefix: string, tokens: TokenTypes): EmailCaseDef {
  return {
    keys: { subject: `${prefix}.subject`, body: `${prefix}.body`, cta: `${prefix}.cta` },
    tokens,
    shell: 'cta',
    criticality: 'best_effort',
    priority: 'other',
  };
}

function plainCase(
  prefix: string,
  tokens: TokenTypes,
  criticality: EmailCriticality,
  priority: 'realtime' | 'other',
): EmailCaseDef {
  return {
    keys: { subject: `${prefix}.subject`, body: `${prefix}.body` },
    tokens,
    shell: 'plain',
    criticality,
    priority,
  };
}

const CASES = new Map<string, EmailCaseDef>();

for (const group of ACTION_GROUPS) {
  for (const role of ACTION_ROLES) {
    for (const shape of ACTION_SHAPES) {
      const id = `action.${group}.${role}.${shape}`;
      CASES.set(id, ctaCase(id, { name: 'text' }));
    }
  }
}

CASES.set('retire.cancel', ctaCase('retire.cancel', {}));

// Item-lifecycle emails to the owner (#531/#534): profile = seeker, offer =
// provider/service_provider. CTA shell (home link) + per-INSTANCE_NAME
// sign-off, best-effort — a failed send never blocks the create/update/
// lifecycle route. `account.aggregator_init` is the one sent when an
// aggregator onboards a participant (in place of the self create/welcome
// emails, which are gated off for aggregator-onboarded records).
const ITEM_TOKENS: TokenTypes = { name: 'text' };
CASES.set('profile.create', ctaCase('profile.create', ITEM_TOKENS));
CASES.set('offer.create', ctaCase('offer.create', ITEM_TOKENS));
// A create that committed `draft` (incomplete / gated minor) is not yet live —
// this "complete your profile" copy is sent instead of the live create copy.
CASES.set('profile.create_incomplete', ctaCase('profile.create_incomplete', ITEM_TOKENS));
CASES.set('offer.create_incomplete', ctaCase('offer.create_incomplete', ITEM_TOKENS));
CASES.set('profile.update', ctaCase('profile.update', ITEM_TOKENS));
CASES.set('offer.update', ctaCase('offer.update', ITEM_TOKENS));
// Aggregator-onboarding initiation email, split per recipient role so the
// activation copy is domain-correct: a seeker is told about discovering jobs
// while a provider/service_provider is told about offering their services.
// `notify_item_lifecycle` picks the suffix from resolveRecipientRole(domain),
// so service_provider folds into the provider copy.
const AGGREGATOR_INIT_TOKENS: TokenTypes = { aggregatorOrg: 'text', networkName: 'text' };
CASES.set(
  'account.aggregator_init.seeker',
  ctaCase('account.aggregator_init.seeker', AGGREGATOR_INIT_TOKENS),
);
CASES.set(
  'account.aggregator_init.provider',
  ctaCase('account.aggregator_init.provider', AGGREGATOR_INIT_TOKENS),
);
CASES.set('profile.pause', ctaCase('profile.pause', ITEM_TOKENS));
CASES.set('offer.pause', ctaCase('offer.pause', ITEM_TOKENS));
CASES.set('profile.retire', ctaCase('profile.retire', ITEM_TOKENS));
CASES.set('offer.retire', ctaCase('offer.retire', ITEM_TOKENS));

const GUARDIAN_TOKENS: TokenTypes = {
  parentName: 'text',
  domain: 'text',
  org: 'text',
  otp: 'text',
  otpBox: 'html',
  teamName: 'text',
};
CASES.set('guardian.account', plainCase('guardian.account', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set('guardian.profile', plainCase('guardian.profile', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set('guardian.action', plainCase('guardian.action', GUARDIAN_TOKENS, 'critical', 'realtime'));
CASES.set(
  'guardian.action_bulk',
  plainCase(
    'guardian.action_bulk',
    { ...GUARDIAN_TOKENS, noun: 'text', orgList: 'html' },
    'critical',
    'realtime',
  ),
);
CASES.set('otp.generic', plainCase('otp.generic', { otp: 'text' }, 'critical', 'realtime'));
CASES.set(
  'login.otp',
  plainCase(
    'login.otp',
    {
      userName: 'text',
      signAction: 'text',
      appName: 'text',
      otp: 'text',
      otpBox: 'html',
      // Injected by the app-side sendEmail wiring (create_auth.ts): the
      // frontend base URL and "Team <name>" sign-off name, so copy can carry
      // a platform link and a per-deployment sign-off (email content sheet).
      siteUrl: 'text',
      // Code-built anchor derived from siteUrl — what copy should use for a
      // clickable platform link (degrades to plain text when unconfigured).
      siteLink: 'html',
      teamName: 'text',
    },
    'critical',
    'realtime',
  ),
);
// Welcome (self-signup). `welcome` is the domain-less fallback; `.seeker` /
// `.provider` carry role-correct copy, picked in notifications/welcome.ts from
// resolveRecipientRole(domain) so service_provider folds into provider.
const WELCOME_TOKENS: TokenTypes = {
  userName: 'text',
  appName: 'text',
  siteUrl: 'text',
  siteLink: 'html',
  teamName: 'text',
};
CASES.set('welcome', plainCase('welcome', WELCOME_TOKENS, 'best_effort', 'realtime'));
CASES.set('welcome.seeker', plainCase('welcome.seeker', WELCOME_TOKENS, 'best_effort', 'realtime'));
CASES.set('welcome.provider', plainCase('welcome.provider', WELCOME_TOKENS, 'best_effort', 'realtime'));
CASES.set(
  'support.request',
  plainCase(
    'support.request',
    {
      reference: 'text',
      type: 'text',
      name: 'text',
      fromSite: 'text',
      details: 'text',
      detailsTable: 'html',
      teamName: 'text',
    },
    'critical',
    'other',
  ),
);

export const EMAIL_CASE_IDS: string[] = [...CASES.keys()];

export function getEmailCase(caseId: string): EmailCaseDef {
  const def = CASES.get(caseId);
  if (!def) throw new Error(`unknown email case: ${caseId}`);
  return def;
}

export function actionCaseId(
  group: 'connect' | 'apply',
  role: 'seeker' | 'provider',
  shape: string,
): string {
  return `action.${group}.${role}.${shape.toLowerCase()}`;
}

export function requiredMessageKeys(): string[] {
  const keys: string[] = [];
  for (const def of CASES.values()) {
    keys.push(def.keys.subject, def.keys.body);
    if (def.keys.cta) keys.push(def.keys.cta);
  }
  return keys;
}
