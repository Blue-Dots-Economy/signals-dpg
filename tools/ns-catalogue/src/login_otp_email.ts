/**
 * The email login_otp template (Plan F3). Keycloak sends it by template_key
 * with `{message: <code>}`, so it has no policy and declares only `message`.
 *
 * Copy is the deployed Keycloak theme (aggregator-dpg
 * infra/keycloak/themes/otp/email/messages/messages_en.properties:
 * emailOtpSubject, emailOtpBodyHtml, emailOtpBody) with {0} → {{message}} and
 * {1} → the sign-off. The HTML keeps the layout Keycloak's base email theme
 * wraps it in (email/html/template.ftl, locale en), and both bodies keep the
 * line breaks FreeMarker emits, so NS sends byte-for-byte what Keycloak sends.
 *
 * Sign-offs come from aggregator-dpg config/<network>[/<brand>]/keycloak.env
 * EMAIL_SIGNOFF; a directory without one uses the theme build default
 * (themes.Dockerfile ARG EMAIL_SIGNOFF).
 */
import { escapeHtml } from './legacy/substitute';
import type { NsTemplateEntry } from './ns_rules';

export const LOGIN_OTP_SIGNOFF_DEFAULT = 'Team EkStep';

/** F3-10: the Keycloak theme sign-off per catalogue directory (F2-7). */
export const LOGIN_OTP_SIGNOFF: Readonly<Record<string, string>> = {
  blue_dot: 'Team EkStep',
  'blue_dot/up-gzb': LOGIN_OTP_SIGNOFF_DEFAULT,
  'blue_dot/ka-dhwd': LOGIN_OTP_SIGNOFF_DEFAULT,
  'blue_dot/upsdm': 'Team Blue Dots',
  purple_dot: 'Team ALIMCO',
  'purple_dot/alimco': 'Team ALIMCO',
  yellow_dot: LOGIN_OTP_SIGNOFF_DEFAULT,
  orange_dot: 'Team Orange Dots',
  'orange_dot/onetac': 'Team OneTAC',
};

export function loginOtpSignoffFor(dir: string): string {
  return LOGIN_OTP_SIGNOFF[dir] ?? LOGIN_OTP_SIGNOFF_DEFAULT;
}

export function loginOtpEmailTemplate(signoff: string): NsTemplateEntry {
  const html =
    '<html lang="en" dir="ltr">\n<body>\n' +
    '<p>Hi!</p><p>Use the following One-Time Password (OTP) to sign in:</p>' +
    '<p><b>{{message}}</b></p><p>This OTP is valid for 5 mins. Do not share it with anyone.</p>' +
    `<p>- ${escapeHtml(signoff)}</p>\n</body>\n</html>\n`;
  const text =
    'Hi!\n\nUse the following One-Time Password (OTP) to sign in:\n\n{{message}}\n\n' +
    `This OTP is valid for 5 mins. Do not share it with anyone.\n\n- ${signoff}\n`;
  return {
    channel: 'email',
    template_key: 'login_otp',
    subject: 'OTP to verify access',
    body_html: html,
    body_text: text,
    variables: [{ name: 'message', type: 'string', required: true, sensitive: true }],
  };
}
