import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { mergeCopy, readDefaultCopyText } from '../copy';
import { buildCatalogue, generatedCaseIds } from '../generate';
import { createEmailSender, type EmailNotifyRequest } from '../legacy/dispatch_email';
import { getEmailCase } from '../legacy/email_cases';
import { loadEmailMessagesIndex } from '../legacy/messages_index';
import { renderOrgList } from '../legacy/shells';
import { buildSupportDetailsTable } from '../legacy/support_details';
import { escapeHtml as signalsEscape } from '../legacy/substitute';
import type { NsTemplateEntry } from '../ns_rules';
import { NsRenderError, escapeHtml as nsEscape, renderNsEmail } from '../render_ns';
import { generateForSchemasRepo } from '../schemas_repo';

/**
 * The golden test: for every email case and network, the generated template
 * rendered with NS's rules must equal what Signals renders today for the same
 * inputs. The only differences are the F2-2 rulings, each asserted here in its
 * exact new form.
 */

const FIXTURES = new URL('./fixtures/schemas/', import.meta.url).pathname;

const NETWORKS = [
  { id: 'blue_dot', dir: 'blue_dot' },
  { id: 'purple_dot', dir: 'purple_dot' },
  { id: 'onest_yellow_dot', dir: 'yellow_dot' },
  { id: 'orange_dot', dir: 'orange_dot' },
] as const;

// Sample values carry every character either side escapes, plus non-ASCII.
const sample = (token: string) => `${token} <b>&"'</b> ’é`;
const OTP = `4<2&"'9`;
const TEAM = `Team <A&B> "Q" 'S'`;
const CTA_URL = 'https://portal.example.org/auth/login?next=a&b=1';
const SITE_URL = 'https://portal.example.org/app/?x=1&y=2';
const ORGS = [`Acme <b>&"'</b>`, 'Beta Ltd', `Gamma ’é`];
const SUPPORT = {
  reference: 'SUP-20261006-ABC234',
  name: sample('name'),
  phone: `+91 <98>&"'`,
  email: `a&b<c>"'@example.org`,
  submittedAt: '2026-10-06T10:20:30.000Z',
  attachments: [
    { filename: `scan <1>&"'.pdf`, bytes: 2048 },
    { filename: 'photo.jpg', bytes: 10 },
  ],
};
const ATTACHMENTS_SUMMARY = `scan <1>&"'.pdf (2.0 KB), photo.jpg (10 B)`;

/** F2-2: orgList becomes plain text joined as `A, B and C`. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** F2-2: the support details table's fixed rows, with the sample values escaped. */
function expectedSupportTable(): string {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:2px 8px;color:#666">${label}</td><td style="padding:2px 8px">${value}</td></tr>`;
  return (
    '<p style="margin:0 0 4px;font-weight:600">Contact details</p><table style="border-collapse:collapse;font-size:13px">' +
    row('Reference', 'SUP-20261006-ABC234') +
    row('Name', 'name &lt;b&gt;&amp;&quot;&#39;&lt;/b&gt; ’é') +
    row('Phone', '+91 &lt;98&gt;&amp;&quot;&#39;') +
    row('Email', 'a&amp;b&lt;c&gt;&quot;&#39;@example.org') +
    row('Submitted at', '2026-10-06T10:20:30.000Z') +
    row('Consent to share contact', 'Yes') +
    row('Attachments', 'scan &lt;1&gt;&amp;&quot;&#39;.pdf (2.0 KB), photo.jpg (10 B)') +
    '</table>'
  );
}

function todayCopyIndex(networkId: string, dir: string) {
  const text = readFileSync(`${FIXTURES}${dir}/messages.properties`, 'utf8');
  return loadEmailMessagesIndex({
    defaultsText: readDefaultCopyText(),
    layers: [{ network: networkId, brand: null, text }],
    warn: () => {},
  });
}

/** Today's path: the legacy dispatchEmail, captured through an injected notify spy. */
async function renderToday(
  networkId: string,
  dir: string,
  caseId: string,
  variables: Record<string, string>,
): Promise<{ subject: string; html: string }> {
  const sent: EmailNotifyRequest[] = [];
  const index = todayCopyIndex(networkId, dir);
  const sender = createEmailSender({
    notify: async (req) => {
      sent.push(req);
    },
    getMessages: async () => index,
    fromEmail: 'hello@example.org',
    defaultReplyTo: 'hello@example.org',
    defaultNetwork: networkId,
    teamName: TEAM,
    log: () => {},
  });
  const cta = getEmailCase(caseId).shell === 'cta';
  const { ok } = await sender.dispatchEmail({
    caseId,
    to: 'r@example.org',
    fromName: 'From',
    variables,
    ...(cta ? { ctaUrl: CTA_URL, network: networkId } : {}),
  });
  expect(ok).toBe(true);
  expect(sent).toHaveLength(1);
  return { subject: sent[0].variables.subject, html: sent[0].variables.html };
}

/** The variables Signals passes to dispatchEmail today for a case. */
function todayVariables(caseId: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [token, type] of Object.entries(getEmailCase(caseId).tokens)) {
    if (type === 'html') continue;
    if (token === 'otp') vars.otp = OTP;
    else if (token === 'siteUrl') vars.siteUrl = SITE_URL;
    else if (token === 'teamName') vars.teamName = TEAM;
    else if (caseId === 'support.request' && token === 'name') vars.name = SUPPORT.name;
    else if (caseId === 'support.request' && token === 'reference') vars.reference = SUPPORT.reference;
    else vars[token] = sample(token);
  }
  if (caseId === 'guardian.action_bulk') vars.orgList = renderOrgList(ORGS);
  if (caseId === 'support.request') vars.detailsTable = buildSupportDetailsTable(SUPPORT);
  return vars;
}

/** The event variables Signals will send NS for the same case. Extra names are ignored (R3). */
function nsVariables(caseId: string): Record<string, string> {
  const { otp, orgList: _orgList, detailsTable: _detailsTable, ...rest } = todayVariables(caseId);
  return {
    ...rest,
    ...(otp !== undefined ? { message: otp } : {}),
    ctaUrl: CTA_URL,
    teamName: TEAM,
    siteUrl: SITE_URL,
    orgList: joinNames(ORGS),
    phone: SUPPORT.phone,
    email: SUPPORT.email,
    submittedAt: SUPPORT.submittedAt,
    attachmentsSummary: ATTACHMENTS_SUMMARY,
  };
}

function emailTemplate(templates: NsTemplateEntry[], key: string) {
  const t = templates.find((x) => x.channel === 'email' && x.template_key === key);
  if (!t?.subject || !t.body_html) throw new Error(`no email template ${key}`);
  return { subject: t.subject, body_html: t.body_html, variables: t.variables };
}

function generated(dir: string) {
  const [result] = generateForSchemasRepo(FIXTURES, { dirs: [dir], version: 'golden', write: false });
  if (!result.catalogue) throw new Error(`no catalogue for ${dir}`);
  expect(result.errors).toEqual([]);
  return { ...result, catalogue: result.catalogue };
}

describe.each(NETWORKS)('golden: $id', ({ id, dir }) => {
  const { catalogue, warnings } = generated(dir);

  it('reads the network id from network.json', () => {
    expect(catalogue.policies.every((p) => p.domain === null || typeof p.domain === 'string')).toBe(true);
    expect(generateForSchemasRepo(FIXTURES, { dirs: [dir], version: 'golden', write: false })[0].networkId).toBe(id);
  });

  it('fixture copy has no token a case does not declare', () => {
    expect(warnings.filter((w) => w.includes('does not declare'))).toEqual([]);
  });

  for (const caseId of generatedCaseIds()) {
    it(`${caseId}: NS renders what Signals renders today`, async () => {
      const ns = renderNsEmail(emailTemplate(catalogue.templates, caseId), nsVariables(caseId));

      if (caseId === 'guardian.action_bulk') {
        // F2-2: the numbered <ol> becomes the plain text "A, B and C".
        const before = await renderToday(id, dir, caseId, todayVariables(caseId));
        expect(before.html).toContain('<ol><li>');
        const expected = await renderToday(id, dir, caseId, {
          ...todayVariables(caseId),
          orgList: 'Acme &lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;, Beta Ltd and Gamma ’é',
        });
        expect(ns.html).toBe(expected.html);
        expect(ns.html).not.toContain('<ol>');
        expect(ns.subject).toBe(before.subject);
        return;
      }

      if (caseId === 'support.request') {
        // F2-2: fixed rows, and an always-present "Attachments" row.
        const before = await renderToday(id, dir, caseId, todayVariables(caseId));
        expect(before.html).toContain('Attachments (2)');
        const expected = await renderToday(id, dir, caseId, {
          ...todayVariables(caseId),
          detailsTable: expectedSupportTable(),
        });
        expect(ns.html).toBe(expected.html);
        expect(ns.subject).toBe(before.subject);
        return;
      }

      const today = await renderToday(id, dir, caseId, todayVariables(caseId));
      expect(ns.html).toBe(today.html);
      expect(ns.subject).toBe(today.subject);
    });
  }

  it('the OTP box is static template HTML around {{message}}, byte-identical once rendered', async () => {
    for (const caseId of ['guardian.account', 'guardian.profile', 'guardian.action', 'guardian.action_bulk']) {
      const t = emailTemplate(catalogue.templates, caseId);
      expect(t.body_html).toContain(`display: inline-block;
      font-family: 'Courier New', monospace;
      margin: 10px 0;
    ">{{message}}</div>`);
      expect(t.variables).toContainEqual({ name: 'message', type: 'string', required: true, sensitive: true });
      const ns = renderNsEmail(t, nsVariables(caseId));
      expect(ns.html).toContain('">4&lt;2&amp;&quot;&#39;9</div>');
    }
  });

  it('welcome without a site URL: Signals printed "the platform"; NS refuses wherever the copy links the site', async () => {
    for (const caseId of ['welcome', 'welcome.seeker', 'welcome.provider']) {
      const t = emailTemplate(catalogue.templates, caseId);
      const { siteUrl: _siteUrl, ...withoutSite } = todayVariables(caseId);
      const today = await renderToday(id, dir, caseId, withoutSite);
      const { siteUrl: _s, ...nsWithoutSite } = nsVariables(caseId);
      if (t.variables.some((v) => v.name === 'siteUrl')) {
        expect(today.html).toContain('the platform');
        expect(() => renderNsEmail(t, nsWithoutSite)).toThrow(NsRenderError);
        expect(() => renderNsEmail(t, nsWithoutSite)).toThrow('missing variable: siteUrl');
        // With the URL, the anchor is exactly today's.
        const ns = renderNsEmail(t, nsVariables(caseId));
        expect(ns.html).toContain(
          '<a href="https://portal.example.org/app/?x=1&amp;y=2" style="color: #1a56db; text-decoration: underline;">https://portal.example.org/app/?x=1&amp;y=2</a>',
        );
      } else {
        expect(renderNsEmail(t, nsWithoutSite)).toEqual(today);
      }
    }
  });
});

describe('golden: the copy a network actually links the site from', () => {
  it('blue_dot welcome copy uses the site link, so its templates declare siteUrl', () => {
    const { catalogue } = generated('blue_dot');
    expect(emailTemplate(catalogue.templates, 'welcome.seeker').variables.map((v) => v.name)).toContain('siteUrl');
  });
});

describe('golden: a copy token the case does not declare', () => {
  it('Signals sends it verbatim today; NS renders it empty, and the generator warns', async () => {
    const copyText = 'profile.update.body=<p>Hi {{nickname}}, {{name}}.</p>';
    const index = loadEmailMessagesIndex({
      defaultsText: readDefaultCopyText(),
      layers: [{ network: 'blue_dot', brand: null, text: copyText }],
      warn: () => {},
    });
    const sent: EmailNotifyRequest[] = [];
    await createEmailSender({
      notify: async (r) => {
        sent.push(r);
      },
      getMessages: async () => index,
      fromEmail: 'x@example.org',
      defaultReplyTo: 'x@example.org',
      defaultNetwork: 'blue_dot',
      teamName: TEAM,
      log: () => {},
    }).dispatchEmail({
      caseId: 'profile.update',
      to: 'r@example.org',
      fromName: 'F',
      variables: { name: 'Ana' },
      ctaUrl: CTA_URL,
      network: 'blue_dot',
    });
    expect(sent[0].variables.html).toContain('<p>Hi {{nickname}}, Ana.</p>');

    const copy = mergeCopy(readDefaultCopyText(), [{ label: 'network blue_dot', text: copyText }]).copy;
    const { catalogue, warnings } = buildCatalogue({
      networkId: 'blue_dot',
      domains: ['seeker'],
      actionTypes: [],
      copy,
      version: 'golden',
    });
    expect(warnings.some((w) => w.includes('{{nickname}}'))).toBe(true);
    const ns = renderNsEmail(emailTemplate(catalogue.templates, 'profile.update'), {
      name: 'Ana',
      ctaUrl: CTA_URL,
      teamName: TEAM,
    });
    expect(ns.html).toContain('<p>Hi , Ana.</p>');
    expect(ns.html).toBe(sent[0].variables.html.replace('{{nickname}}', ''));
  });
});

describe('golden: NS rules vs Signals rules (findings, asserted as they are)', () => {
  it('HTML escaping is identical for every BMP code point', () => {
    const differing: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      if (signalsEscape(ch) !== nsEscape(ch)) differing.push(cp.toString(16));
    }
    expect(differing).toEqual([]);
    expect(nsEscape(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  it('subject whitespace: Signals collapses every whitespace run and trims; NS replaces only control runs', async () => {
    const { catalogue } = generated('blue_dot');
    const caseId = 'action.connect.seeker.outbound_request';
    const name = ' Ana \t\n  Rao\u00a0 ';
    const today = await renderToday('blue_dot', 'blue_dot', caseId, { name });
    const ns = renderNsEmail(emailTemplate(catalogue.templates, caseId), { name, ctaUrl: CTA_URL, teamName: TEAM });
    expect(today.subject).toBe('Your connection request has been sent to Ana Rao');
    expect(ns.subject).toBe('Your connection request has been sent to  Ana    Rao\u00a0 ');
    // A single-space name is unaffected.
    const plain = renderNsEmail(emailTemplate(catalogue.templates, caseId), {
      name: 'Ana Rao',
      ctaUrl: CTA_URL,
      teamName: TEAM,
    });
    expect(plain.subject).toBe(today.subject);
  });

  it('url variables: NS normalises the URL, so a bare origin gains a trailing slash', async () => {
    const { catalogue } = generated('blue_dot');
    const today = await renderToday('blue_dot', 'blue_dot', 'welcome', {
      ...todayVariables('welcome'),
      siteUrl: 'https://Portal.Example.org',
    });
    const ns = renderNsEmail(emailTemplate(catalogue.templates, 'welcome'), {
      ...nsVariables('welcome'),
      siteUrl: 'https://Portal.Example.org',
    });
    expect(today.html).toContain('<a href="https://Portal.Example.org" ');
    expect(ns.html).toContain('<a href="https://portal.example.org/" ');
    expect(ns.html).toBe(today.html.replaceAll('https://Portal.Example.org', 'https://portal.example.org/'));
  });

  it('support with no site link: fromSite is empty and optional, as today', async () => {
    const { catalogue } = generated('blue_dot');
    const before = await renderToday('blue_dot', 'blue_dot', 'support.request', {
      ...todayVariables('support.request'),
      fromSite: '',
    });
    const ns = renderNsEmail(emailTemplate(catalogue.templates, 'support.request'), {
      ...nsVariables('support.request'),
      fromSite: '',
    });
    expect(ns.subject).toBe(before.subject);
  });
});
