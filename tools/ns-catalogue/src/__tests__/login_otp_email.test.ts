import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  LOGIN_OTP_SIGNOFF,
  LOGIN_OTP_SIGNOFF_DEFAULT,
  loginOtpEmailTemplate,
  loginOtpSignoffFor,
} from '../login_otp_email';
import { emailPublishErrors } from '../ns_rules';
import { renderNsEmail, renderNsEmailText } from '../render_ns';
import { F2_7_DIRS, generateForSchemasRepo } from '../schemas_repo';

/**
 * The email login_otp template (Plan F3, rulings F3-8..F3-10) against the copy
 * Keycloak sends today.
 *
 * Fixtures in ./fixtures/keycloak-theme:
 *   - messages_en.properties — verbatim from aggregator-dpg (branch feature)
 *     infra/keycloak/themes/otp/email/messages/messages_en.properties.
 *   - freemarker_rendered.json — the theme rendered by FreeMarker 2.3.32 (the
 *     version Keycloak 26.x pins) with Keycloak's own pieces: the base theme's
 *     email/html/template.ftl layout, the otp theme's email-otp-code.ftl (html
 *     and text), MessageFormatterMethod (`msg`), KeycloakSanitizerMethod
 *     (`kcSanitize`, OWASP sanitizer 20260101.1), locale `en`, ltr, code
 *     `123456`, and `emailOtpSignoff` set per sign-off as themes.Dockerfile does.
 *
 * `keycloakRender` below is the FreeMarker-equivalent reference: the same
 * steps in TypeScript. It is checked against the FreeMarker output first, then
 * used as the expected email for every catalogue directory.
 */

const THEME = new URL('./fixtures/keycloak-theme/', import.meta.url).pathname;
const SCHEMAS = new URL('./fixtures/schemas/', import.meta.url).pathname;

const FREEMARKER = JSON.parse(readFileSync(`${THEME}freemarker_rendered.json`, 'utf8')) as {
  code: string;
  rendered: Record<string, { subject: string; html: string; text: string }>;
};

/** java.util.Properties, for the single-line `key=value` entries this file uses. */
function readProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    if (trimmed.endsWith('\\')) throw new Error('continuation lines are not modelled');
    const eq = trimmed.indexOf('=');
    const value = trimmed.slice(eq + 1).replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
    out.set(trimmed.slice(0, eq).trim(), value);
  }
  return out;
}

const MESSAGES = readProperties(readFileSync(`${THEME}messages_en.properties`, 'utf8'));

function message(key: string): string {
  const value = MESSAGES.get(key);
  if (value === undefined) throw new Error(`theme has no ${key}`);
  return value;
}

/** java.text.MessageFormat for `{n}` arguments; quoting is not modelled, so a quote fails loudly. */
function messageFormat(pattern: string, args: string[]): string {
  if (pattern.includes("'")) throw new Error('MessageFormat quoting is not modelled');
  return pattern.replace(/\{(\d+)\}/g, (_m, i: string) => args[Number(i)]);
}

/**
 * What Keycloak sends for this code and sign-off.
 *   html: base email/html/template.ftl `emailLayout` (lang/dir for locale en)
 *         around `kcSanitize(msg("emailOtpBodyHtml", code, signoff))`. FreeMarker
 *         drops lines holding only FTL tags, which leaves exactly these breaks.
 *         The sanitizer keeps the theme's <p>/<b> markup as is; sign-offs carry
 *         no markup (asserted), so it is the identity here.
 *   text: `msg("emailOtpBody", code, signoff)` plus the template's final newline.
 */
function keycloakRender(code: string, signoff: string): { subject: string; html: string; text: string } {
  if (/[<>&"']/.test(signoff)) throw new Error('kcSanitize is modelled only for sign-offs without markup');
  const body = messageFormat(message('emailOtpBodyHtml'), [code, signoff]);
  return {
    subject: messageFormat(message('emailOtpSubject'), []),
    html: `<html lang="en" dir="ltr">\n<body>\n${body}\n</body>\n</html>\n`,
    text: `${messageFormat(message('emailOtpBody'), [code, signoff])}\n`,
  };
}

/** What NS sends for a template_key send of this template with `{message: code}`. */
function nsRender(signoff: string, code: string) {
  const t = loginOtpEmailTemplate(signoff);
  if (!t.subject || !t.body_html || !t.body_text) throw new Error('login_otp needs subject, html and text');
  const { subject, html } = renderNsEmail({ subject: t.subject, body_html: t.body_html, variables: t.variables }, { message: code });
  const text = renderNsEmailText({ body_text: t.body_text, variables: t.variables }, { message: code });
  return { subject, html, text };
}

describe('email login_otp template', () => {
  it('is the Keycloak theme copy, addressed by template_key, with only the sensitive message variable', () => {
    expect(loginOtpEmailTemplate('Team OneTAC')).toEqual({
      channel: 'email',
      template_key: 'login_otp',
      subject: 'OTP to verify access',
      body_html:
        '<html lang="en" dir="ltr">\n<body>\n' +
        '<p>Hi!</p><p>Use the following One-Time Password (OTP) to sign in:</p>' +
        '<p><b>{{message}}</b></p><p>This OTP is valid for 5 mins. Do not share it with anyone.</p>' +
        '<p>- Team OneTAC</p>\n</body>\n</html>\n',
      body_text:
        'Hi!\n\nUse the following One-Time Password (OTP) to sign in:\n\n{{message}}\n\n' +
        'This OTP is valid for 5 mins. Do not share it with anyone.\n\n- Team OneTAC\n',
      variables: [{ name: 'message', type: 'string', required: true, sensitive: true }],
    });
  });

  it('escapes the sign-off in HTML only', () => {
    const t = loginOtpEmailTemplate('Team <A&B>');
    expect(t.body_html).toContain('<p>- Team &lt;A&amp;B&gt;</p>');
    expect(t.body_text).toContain('- Team <A&B>\n');
  });

  it('passes the NS publish rules', () => {
    expect(emailPublishErrors(loginOtpEmailTemplate(LOGIN_OTP_SIGNOFF_DEFAULT))).toEqual([]);
  });

  it('NS refuses to render it without the code', () => {
    const t = loginOtpEmailTemplate(LOGIN_OTP_SIGNOFF_DEFAULT);
    expect(() =>
      renderNsEmail({ subject: t.subject!, body_html: t.body_html!, variables: t.variables }, {}),
    ).toThrow('missing variable: message');
  });
});

describe('sign-off per catalogue directory (F3-10)', () => {
  it('covers every directory with the deployed Keycloak sign-off', () => {
    expect(LOGIN_OTP_SIGNOFF_DEFAULT).toBe('Team EkStep');
    expect(Object.keys(LOGIN_OTP_SIGNOFF).sort()).toEqual([...F2_7_DIRS].sort());
    expect(Object.fromEntries(F2_7_DIRS.map((dir) => [dir, loginOtpSignoffFor(dir)]))).toEqual({
      blue_dot: 'Team EkStep',
      'blue_dot/up-gzb': 'Team EkStep',
      'blue_dot/ka-dhwd': 'Team EkStep',
      'blue_dot/upsdm': 'Team Blue Dots',
      purple_dot: 'Team ALIMCO',
      'purple_dot/alimco': 'Team ALIMCO',
      yellow_dot: 'Team EkStep',
      orange_dot: 'Team Orange Dots',
      'orange_dot/onetac': 'Team OneTAC',
    });
  });

  it('an unlisted directory gets the theme build default', () => {
    expect(loginOtpSignoffFor('green_dot')).toBe(LOGIN_OTP_SIGNOFF_DEFAULT);
  });
});

describe('golden: NS renders the email Keycloak sends today', () => {
  it('the reference reproduces FreeMarker for every sign-off in use', () => {
    const inUse = [...new Set(F2_7_DIRS.map(loginOtpSignoffFor))].sort();
    expect(Object.keys(FREEMARKER.rendered).sort()).toEqual(inUse);
    for (const signoff of inUse) {
      expect(keycloakRender(FREEMARKER.code, signoff)).toEqual(FREEMARKER.rendered[signoff]);
    }
  });

  it.each([...F2_7_DIRS])('%s: subject, HTML and text are byte-identical', (dir) => {
    const signoff = loginOtpSignoffFor(dir);
    for (const code of [FREEMARKER.code, '000000', '987654']) {
      expect(nsRender(signoff, code)).toEqual(keycloakRender(code, signoff));
    }
    expect(nsRender(signoff, FREEMARKER.code)).toEqual(FREEMARKER.rendered[signoff]);
  });
});

describe('generated catalogues', () => {
  const results = generateForSchemasRepo(SCHEMAS, { dirs: F2_7_DIRS, version: 'login-otp', write: false });
  const generated = results.filter((r) => r.catalogue !== null);

  it('the fixtures cover more than one sign-off', () => {
    expect(new Set(generated.map((r) => loginOtpSignoffFor(r.dir))).size).toBeGreaterThan(1);
  });

  it.each(generated.map((r) => [r.dir, r] as const))(
    '%s: one email login_otp with its sign-off, publishable, named by no policy',
    (dir, r) => {
      const c = r.catalogue!;
      expect(r.errors).toEqual([]);
      const found = c.templates.filter((t) => t.channel === 'email' && t.template_key === 'login_otp');
      expect(found).toEqual([loginOtpEmailTemplate(loginOtpSignoffFor(dir))]);
      expect(emailPublishErrors(found[0])).toEqual([]);
      expect(c.policies.flatMap((p) => p.channels).filter((ch) => ch.channel === 'email' && ch.template_key === 'login_otp')).toEqual([]);
    },
  );
});
