import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ACTION_CANCELLED_BY_RETIRE,
  ITEM_ONBOARDED,
  SUPPORT_REQUEST,
  USER_WELCOME,
  actionEvent,
  guardianEvent,
} from '@dpg/notification';

import { mergeCopy, readDefaultCopyText } from '../copy';
import { WHATSAPP_WELCOME_CONTENT_SID, buildCatalogue, generatedCaseIds } from '../generate';
import type { NsCatalogue, NsPolicyEntry } from '../ns_rules';
import { catalogueErrors } from '../ns_rules';
import { F2_7_DIRS, generateForSchemasRepo, stableJson } from '../schemas_repo';

const FIXTURES = new URL('./fixtures/schemas/', import.meta.url).pathname;
const VERSION = 'abc1234-20261006';

function fixture(path: string): string {
  return readFileSync(`${FIXTURES}${path}`, 'utf8');
}

function catalogueFor(dir: string) {
  const results = generateForSchemasRepo(FIXTURES, { dirs: [dir], version: VERSION, write: false });
  expect(results).toHaveLength(1);
  const { catalogue, ...rest } = results[0];
  if (!catalogue) throw new Error(`no catalogue for ${dir}: ${rest.warnings.join('; ')}`);
  return { ...rest, catalogue };
}

function policy(c: NsCatalogue, domain: string | null, event: string): NsPolicyEntry | undefined {
  return c.policies.find((p) => p.domain === domain && p.event_type === event);
}

function minimalInput(overrides: Partial<Parameters<typeof buildCatalogue>[0]> = {}) {
  return {
    networkId: 'blue_dot',
    domains: ['seeker'],
    actionTypes: ['connect'],
    copy: mergeCopy(readDefaultCopyText(), []).copy,
    version: VERSION,
    ...overrides,
  };
}

describe('policies', () => {
  // Per domain: 4 shapes x action types, cancelled_by_retire, 5 item events,
  // onboarded, welcome. Domain-less: welcome, 4 guardian kinds, generic, support.
  const expected: Record<string, number> = {
    blue_dot: 2 * (4 * 2 + 8) + 7,
    purple_dot: 2 * (4 * 1 + 8) + 7,
    'purple_dot/alimco': 2 * (4 * 1 + 8) + 7,
    yellow_dot: 2 * (4 * 1 + 8) + 7,
    orange_dot: 1 * (4 * 0 + 8) + 7,
  };

  for (const [dir, count] of Object.entries(expected)) {
    it(`${dir}: ${count} policies, one per (domain, event), and NS would accept the file`, () => {
      const { catalogue, errors } = catalogueFor(dir);
      expect(errors).toEqual([]);
      expect(catalogueErrors(catalogue)).toEqual([]);
      expect(catalogue.policies).toHaveLength(count);
      const keys = catalogue.policies.map((p) => `${p.domain ?? ''}|${p.event_type}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  it('blue_dot policy shapes follow the event table', () => {
    const { catalogue: c } = catalogueFor('blue_dot');
    expect(policy(c, 'seeker', actionEvent('apply', 'inbound_request'))).toEqual({
      domain: 'seeker',
      event_type: 'action.apply.inbound_request',
      mode: 'all',
      channels: [{ channel: 'email', template_key: 'action.apply.seeker.inbound_request' }],
    });
    expect(policy(c, 'provider', ACTION_CANCELLED_BY_RETIRE)?.channels).toEqual([
      { channel: 'email', template_key: 'retire.cancel' },
    ]);
    expect(policy(c, 'provider', 'item.created_draft')?.channels).toEqual([
      { channel: 'email', template_key: 'offer.create_incomplete' },
    ]);
    expect(policy(c, 'seeker', ITEM_ONBOARDED)?.channels).toEqual([
      { channel: 'email', template_key: 'account.aggregator_init.seeker' },
    ]);
    expect(policy(c, 'provider', USER_WELCOME)).toEqual({
      domain: 'provider',
      event_type: 'user.welcome',
      mode: 'all',
      channels: [
        { channel: 'email', template_key: 'welcome.provider' },
        { channel: 'whatsapp', template_key: 'welcome' },
      ],
    });
    expect(policy(c, null, USER_WELCOME)?.channels).toEqual([
      { channel: 'email', template_key: 'welcome' },
      { channel: 'whatsapp', template_key: 'welcome' },
    ]);
    for (const kind of ['account', 'profile', 'action', 'action_bulk'] as const) {
      expect(policy(c, null, guardianEvent(kind))).toEqual({
        domain: null,
        event_type: `guardian.otp.${kind}`,
        mode: 'first_available',
        channels: [
          { channel: 'email', template_key: `guardian.${kind}` },
          { channel: 'sms', template_key: 'login_otp' },
        ],
      });
    }
    expect(policy(c, null, guardianEvent('generic'))?.channels).toEqual([
      { channel: 'email', template_key: 'otp.generic' },
      { channel: 'sms', template_key: 'login_otp' },
    ]);
    expect(policy(c, null, SUPPORT_REQUEST)?.channels).toEqual([
      { channel: 'email', template_key: 'support.request' },
    ]);
    // Guardian and support are domain-less only.
    expect(policy(c, 'seeker', guardianEvent('account'))).toBeUndefined();
    expect(policy(c, 'seeker', SUPPORT_REQUEST)).toBeUndefined();
  });

  it('every policy names templates the catalogue carries, except NS-seeded sms login_otp', () => {
    const { catalogue: c } = catalogueFor('blue_dot');
    const carried = new Set(c.templates.map((t) => `${t.channel}/${t.template_key}`));
    for (const p of c.policies) {
      for (const ch of p.channels) {
        if (ch.channel === 'sms') {
          expect(ch.template_key).toBe('login_otp');
          continue;
        }
        expect(carried.has(`${ch.channel}/${ch.template_key}`)).toBe(true);
      }
    }
    expect(carried.has('sms/login_otp')).toBe(false);
  });
});

describe('role and copy-group mapping', () => {
  it('student → profile/seeker and individual_tutor_weera_counsellor → offer/provider (yellow_dot)', () => {
    const { catalogue: c } = catalogueFor('yellow_dot');
    expect(c.version).toBe(VERSION);
    expect(policy(c, 'student', 'item.created')?.channels[0].template_key).toBe('profile.create');
    expect(policy(c, 'student', actionEvent('connect', 'outbound_status'))?.channels[0].template_key).toBe(
      'action.connect.seeker.outbound_status',
    );
    const tutor = 'individual_tutor_weera_counsellor';
    expect(policy(c, tutor, 'item.paused')?.channels[0].template_key).toBe('offer.pause');
    expect(policy(c, tutor, actionEvent('connect', 'inbound_request'))?.channels[0].template_key).toBe(
      'action.connect.provider.inbound_request',
    );
    expect(policy(c, tutor, USER_WELCOME)?.channels[0].template_key).toBe('welcome.provider');
  });

  it('service_provider → provider', () => {
    const { catalogue: c } = buildCatalogue(
      minimalInput({ domains: ['service_provider'], actionTypes: ['apply'] }),
    );
    expect(policy(c, 'service_provider', 'item.retired')?.channels[0].template_key).toBe('offer.retire');
    expect(policy(c, 'service_provider', ITEM_ONBOARDED)?.channels[0].template_key).toBe(
      'account.aggregator_init.provider',
    );
    expect(
      policy(c, 'service_provider', actionEvent('apply', 'inbound_status'))?.channels[0].template_key,
    ).toBe('action.apply.provider.inbound_status');
  });

  it('apply, shortlist and pre_shortlist all use the apply copy; connect uses connect', () => {
    const { catalogue: c } = buildCatalogue(
      minimalInput({ actionTypes: ['apply', 'shortlist', 'pre_shortlist', 'connect'] }),
    );
    for (const type of ['apply', 'shortlist', 'pre_shortlist']) {
      expect(policy(c, 'seeker', actionEvent(type, 'inbound_request'))?.channels[0].template_key).toBe(
        'action.apply.seeker.inbound_request',
      );
    }
    expect(policy(c, 'seeker', actionEvent('connect', 'inbound_request'))?.channels[0].template_key).toBe(
      'action.connect.seeker.inbound_request',
    );
  });

  it('warns about a domain that falls to the seeker role by default', () => {
    const { warnings } = buildCatalogue(minimalInput({ domains: ['seeker', 'student', 'provider'] }));
    expect(warnings.some((w) => w.includes('"student"') && w.includes('seeker'))).toBe(true);
    expect(warnings.some((w) => w.includes('"seeker"'))).toBe(false);
    expect(warnings.some((w) => w.includes('"provider"'))).toBe(false);
  });
});

describe('copy layering (F2-3)', () => {
  it('a brand directory merges defaults < network < brand', () => {
    const brand = catalogueFor('purple_dot/alimco').catalogue;
    const network = catalogueFor('purple_dot').catalogue;
    const subject = (c: NsCatalogue, key: string) =>
      c.templates.find((t) => t.channel === 'email' && t.template_key === key)?.subject;

    // Brand-only key: alimco sets profile.create; purple_dot does not.
    const defaults = mergeCopy(readDefaultCopyText(), []).copy;
    const alimcoCopy = mergeCopy(readDefaultCopyText(), [
      { label: 'n', text: fixture('purple_dot/messages.properties') },
      { label: 'b', text: fixture('purple_dot/alimco/messages.properties') },
    ]).copy;
    expect(alimcoCopy.get('profile.create.subject')).not.toBe(defaults.get('profile.create.subject'));
    expect(subject(brand, 'profile.create')).toBe(alimcoCopy.get('profile.create.subject'));
    expect(subject(network, 'profile.create')).toBe(defaults.get('profile.create.subject'));

    // A key no layer overrides falls through to the bundled default.
    expect(subject(brand, 'support.request')).toBe(
      'Issue Number: {{reference}} — {{type}} from {{name}}{{fromSite}}',
    );
  });

  it('brand beats network beats defaults, key by key', () => {
    expect(() => mergeCopy('', [])).toThrow(/missing required keys/);
    const merged = mergeCopy(readDefaultCopyText(), [
      { label: 'network x', text: 'welcome.subject=Network\nwelcome.body=<p>N</p>' },
      { label: 'brand y', text: 'welcome.subject=Brand' },
    ]).copy;
    expect(merged.get('welcome.subject')).toBe('Brand');
    expect(merged.get('welcome.body')).toBe('<p>N</p>');
    expect(merged.get('welcome.seeker.subject')).toBe('Welcome!');
  });

  it('a brand directory with no network.json of its own uses its network root', () => {
    const { catalogue, warnings } = catalogueFor('blue_dot/upsdm');
    expect(catalogue.policies).toHaveLength(2 * (4 * 2 + 8) + 7);
    expect(warnings.some((w) => w.includes('blue_dot/upsdm') && w.includes('network.json'))).toBe(true);
  });
});

describe('warnings', () => {
  it('reports the purple_dot service_provider keys the registry does not know', () => {
    const { warnings } = catalogueFor('purple_dot');
    const unknown = warnings.filter((w) => w.includes('unknown key') && w.includes('.service_provider.'));
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((w) => w.startsWith('copy network purple_dot:'))).toBe(true);
  });

  it('a malformed line and an empty value are reported and ignored', () => {
    const { copy, warnings } = mergeCopy(readDefaultCopyText(), [
      { label: 'network z', text: 'not a pair\nwelcome.subject=' },
    ]);
    expect(copy.get('welcome.subject')).toBe('Welcome!');
    expect(warnings).toEqual([
      'copy network z: line 1 is not "key=value"; ignored',
      'copy network z: empty value for "welcome.subject"; ignored (the lower layer applies)',
    ]);
  });
});

describe('templates', () => {
  it('carries every live email case, not login.otp, plus the WhatsApp welcome', () => {
    const { catalogue: c } = catalogueFor('blue_dot');
    const email = c.templates.filter((t) => t.channel === 'email').map((t) => t.template_key);
    expect(email.sort()).toEqual([...generatedCaseIds()].sort());
    expect(email).not.toContain('login.otp');
    expect(email).toHaveLength(38);
    expect(c.templates.filter((t) => t.channel === 'email').every((t) => t.provider === undefined)).toBe(true);
  });

  it('the WhatsApp welcome template names twilio, its content id and variable 1', () => {
    const { catalogue: c } = catalogueFor('orange_dot');
    expect(c.templates.find((t) => t.channel === 'whatsapp')).toEqual({
      channel: 'whatsapp',
      template_key: 'welcome',
      provider: 'twilio',
      provider_template_id: WHATSAPP_WELCOME_CONTENT_SID,
      variables: [{ name: '1', type: 'string', required: true }],
    });
    expect(WHATSAPP_WELCOME_CONTENT_SID).toBe('HX3f2a5d7e4a18e5664124592a12a154eb');
  });

  it('variable contracts: text → string, ctaUrl/siteUrl → url, message → sensitive', () => {
    const { catalogue: c } = catalogueFor('blue_dot');
    const vars = (key: string) => c.templates.find((t) => t.template_key === key && t.channel === 'email')?.variables;
    expect(vars('action.connect.seeker.inbound_request')).toEqual([
      { name: 'ctaUrl', type: 'url', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'teamName', type: 'string', required: true },
    ]);
    expect(vars('retire.cancel')).toEqual([
      { name: 'ctaUrl', type: 'url', required: true },
      { name: 'teamName', type: 'string', required: true },
    ]);
    expect(vars('otp.generic')).toEqual([{ name: 'message', type: 'string', required: true, sensitive: true }]);
    // blue_dot's welcome copy uses the site link; the default copy does not.
    expect(vars('welcome.seeker')).toEqual([{ name: 'siteUrl', type: 'url', required: true }]);
    const { catalogue: orange } = catalogueFor('orange_dot');
    expect(orange.templates.find((t) => t.template_key === 'welcome.seeker')?.variables).toEqual([
      { name: 'appName', type: 'string', required: true },
      { name: 'userName', type: 'string', required: true },
    ]);
    // fromSite is legitimately empty today (no SUPPORT link base URL), so it is optional.
    expect(vars('support.request')?.find((v) => v.name === 'fromSite')).toEqual({
      name: 'fromSite',
      type: 'string',
      required: false,
    });
  });

  it('every guardian template carries the OTP as {{message}} and never {{otp}}', () => {
    const { catalogue: c } = catalogueFor('purple_dot');
    for (const key of ['guardian.account', 'guardian.profile', 'guardian.action', 'guardian.action_bulk', 'otp.generic']) {
      const t = c.templates.find((x) => x.template_key === key);
      expect(t?.body_html).toContain('{{message}}');
      expect(t?.body_html).not.toContain('{{otp}}');
      expect(t?.body_html).not.toContain('{{otpBox}}');
    }
  });

  it('a copy token the case does not declare is a warning and an optional variable', () => {
    const copy = mergeCopy(readDefaultCopyText(), [
      { label: 't', text: 'profile.update.body=<p>Hi {{nickname}}, {{name}}.</p>' },
    ]).copy;
    const { catalogue, warnings } = buildCatalogue(minimalInput({ copy }));
    expect(warnings).toContain(
      'template profile.update: copy "profile.update.body" uses {{nickname}}, which the case does not declare; Signals sends it verbatim today, NS renders it empty',
    );
    const t = catalogue.templates.find((x) => x.template_key === 'profile.update');
    expect(t?.variables).toContainEqual({ name: 'nickname', type: 'string', required: false });
    expect(catalogueErrors(catalogue)).toEqual([]);
  });

  it('a malformed token or a non-url href token is reported as an NS publish error', () => {
    const copy = mergeCopy(readDefaultCopyText(), [
      {
        label: 't',
        text: 'profile.update.body=<p>{{ name }}</p>\noffer.update.body=<p><a href="{{name}}">x</a></p>',
      },
    ]).copy;
    const { warnings } = buildCatalogue(minimalInput({ copy }));
    expect(warnings).toContain('NS would reject email/profile.update: malformed token');
    expect(warnings).toContain(
      'NS would reject email/offer.update: name is used in an href/src attribute and must be type url',
    );
  });
});

describe('output', () => {
  it('is stable, pretty-printed JSON with no duplicate keys', () => {
    const a = stableJson(catalogueFor('blue_dot').catalogue);
    const b = stableJson(catalogueFor('blue_dot').catalogue);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(a).toContain('\n  "policies": [');
    const parsed = JSON.parse(a) as NsCatalogue;
    expect(Object.keys(parsed)).toEqual(['policies', 'templates', 'version']);
    const tKeys = parsed.templates.map((t) => `${t.channel}/${t.template_key}`);
    expect(new Set(tKeys).size).toBe(tKeys.length);
    expect(tKeys).toEqual([...tKeys].sort());
    const pKeys = parsed.policies.map((p) => `${p.domain ?? ''}|${p.event_type}`);
    expect(new Set(pKeys).size).toBe(pKeys.length);
  });

  it('rejects a version NS would refuse', () => {
    expect(() => buildCatalogue(minimalInput({ version: 'has space' }))).toThrow(/version/);
  });

  it('lists the F2-7 directories', () => {
    expect(F2_7_DIRS).toEqual([
      'blue_dot',
      'blue_dot/up-gzb',
      'blue_dot/ka-dhwd',
      'blue_dot/upsdm',
      'purple_dot',
      'purple_dot/alimco',
      'yellow_dot',
      'orange_dot',
      'orange_dot/onetac',
    ]);
  });

  it('a listed directory missing from the repo is a warning, not a crash', () => {
    const results = generateForSchemasRepo(FIXTURES, { dirs: ['blue_dot/ka-dhwd'], version: VERSION, write: false });
    expect(results).toEqual([
      expect.objectContaining({ dir: 'blue_dot/ka-dhwd', catalogue: null, warnings: [expect.stringContaining('not found')] }),
    ]);
  });
});

describe('legacy copies', () => {
  // Until Task 6 deletes the apps/api originals, the generator must read the
  // same copy and rules the running API renders with.
  const API = new URL('../../../../apps/api/src/notifications/', import.meta.url).pathname;
  const LEGACY = new URL('../legacy/', import.meta.url).pathname;
  const verbatim: Array<[string, string]> = [
    ['messages.default.properties', 'email/messages.default.properties'],
    ['email_cases.ts', 'email/email_cases.ts'],
    ['shells.ts', 'email/shells.ts'],
    ['substitute.ts', 'email/substitute.ts'],
    ['parse_properties.ts', 'email/parse_properties.ts'],
    ['action_copy.ts', 'action_copy.ts'],
  ];
  for (const [legacy, api] of verbatim) {
    it(`${legacy} matches apps/api ${api}`, () => {
      const copy = readFileSync(`${LEGACY}${legacy}`, 'utf8');
      const body = legacy.endsWith('.ts') ? copy.split('\n').slice(2).join('\n') : copy;
      expect(body).toBe(readFileSync(`${API}${api}`, 'utf8'));
    });
  }
});
