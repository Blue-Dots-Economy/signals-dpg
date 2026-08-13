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
CASES.set(
  'welcome',
  plainCase(
    'welcome',
    {
      userName: 'text',
      appName: 'text',
      siteUrl: 'text',
      siteLink: 'html',
      teamName: 'text',
    },
    'best_effort',
    'realtime',
  ),
);
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
