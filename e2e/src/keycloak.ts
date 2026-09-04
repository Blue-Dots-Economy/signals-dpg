import { createHash, randomBytes } from 'node:crypto';
import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { Mailpit } from './mailpit.js';
import type { E2EConfig } from './config.js';

/**
 * Keycloak OTP login driver (external mode, no browser).
 *
 * Under `AUTH_PROVIDER=keycloak` better-auth's `/api/auth/*` mount is not
 * registered at all (`apps/api/src/app.ts`), so the suite's better-auth OTP
 * helpers 404 and there is no session to get. This module drives the real thing
 * instead: the authorization-code + PKCE flow against the realm's
 * `bluedots-otp-browser` flow, scripted over HTTP.
 *
 * The verified shape of that flow (probed against the local stack):
 *
 *   1. GET  /realms/<realm>/protocol/openid-connect/auth?…   → identifier form
 *   2. POST <form action> { identifier }                     → OTP form
 *      (a multi-channel identifier can interpose a channel-choice form)
 *   3. OTP is delivered — email → Mailpit, phone → the Keycloak container log
 *   4. POST <form action> { otp }                            → 302 to the app
 *                                                              with ?code=
 *   5. POST /protocol/openid-connect/token { code, verifier } → access_token
 *
 * Two things that will bite anyone changing this:
 *
 * - **The form `action` points at the INTERNAL host.** Keycloak renders
 *   `http://keycloak:8080/...` because that is its own hostname inside compose;
 *   that host does not resolve from the test runner. Every action URL is
 *   rewritten to the public base URL before use (`toPublicUrl`).
 * - **The SPI cannot create users.** It is login-only — an unknown identifier
 *   comes back to the identifier form with "No account matches this email or
 *   mobile number". Signup goes through signals' own public
 *   `POST /api/v1/auth/signup`, which creates the Keycloak identity; the local
 *   `user` row then appears on the first successful login.
 */

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface KeycloakTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface ParsedForm {
  action: string | null;
  inputs: string[];
  buttons: Array<[string, string]>;
  text: string;
}

/** Parse the first form on a Keycloak login page. */
function parseForm(html: string): ParsedForm {
  const m = /<form[^>]*action="([^"]*)"/.exec(html);
  const action = m ? m[1].replace(/&amp;/g, '&') : null;
  const inputs = [...html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/g)].map((x) => x[1]);
  const buttons = [...html.matchAll(/<button[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map(
    (x) => [x[1], x[2]] as [string, string],
  );
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { action, inputs, buttons, text };
}

export interface KeycloakSettings {
  /** Browser-facing Keycloak base URL, e.g. http://localhost:8080 */
  baseUrl: string;
  /** The hostname Keycloak renders into form actions (its in-compose name). */
  internalBaseUrl: string;
  realm: string;
  /** Public UI client — must match KEYCLOAK_ACCEPTED_CLIENT_IDS on the API. */
  clientId: string;
  /** A redirect URI registered on that client. */
  redirectUri: string;
}

export function keycloakSettingsFrom(cfg: E2EConfig): KeycloakSettings {
  return {
    baseUrl: cfg.keycloak.baseUrl,
    internalBaseUrl: cfg.keycloak.internalBaseUrl,
    realm: cfg.keycloak.realm,
    clientId: cfg.keycloak.uiClientId,
    redirectUri: cfg.keycloak.redirectUri,
  };
}

export class KeycloakLogin {
  /**
   * `mailpit` may be bound to any context — reading an inbox needs no cookies.
   * The login flow itself always runs in a fresh context of its own (see
   * `login`), so no request context is held here.
   */
  constructor(
    private readonly kc: KeycloakSettings,
    private readonly mailpit: Mailpit | null,
  ) {}

  /** Rewrite Keycloak's internally-rendered host to the reachable public one. */
  private toPublicUrl(url: string): string {
    return url.startsWith(this.kc.internalBaseUrl)
      ? this.kc.baseUrl + url.slice(this.kc.internalBaseUrl.length)
      : url;
  }

  /**
   * Run the full OTP login and return the token set.
   *
   * `otpResolver` supplies the delivered code. The default reads the email
   * channel out of Mailpit; a phone identity needs a resolver that reads the
   * Keycloak container log (`KC_SPI_SMS_PROVIDER=log`).
   */
  async login(
    identifier: string,
    opts: { otpResolver?: () => Promise<string | undefined>; channel?: 'email' | 'phone' } = {},
  ): Promise<KeycloakTokens> {
    // A DEDICATED cookie jar per login, not the shared fixture context.
    //
    // The realm's browser flow starts with `auth-cookie` as an ALTERNATIVE to
    // the OTP forms, so a context that already holds a Keycloak SSO cookie is
    // re-authenticated silently as whoever logged in first — the authorization
    // endpoint redirects straight to the callback and never renders a form. A
    // test that creates two personas would then get the same identity twice,
    // which fails confusingly ("no login form") or, worse, passes while
    // asserting against one user playing both sides.
    const ctx = await playwrightRequest.newContext();
    try {
      return await this.runFlow(ctx, identifier, opts);
    } finally {
      await ctx.dispose();
    }
  }

  private async runFlow(
    ctx: APIRequestContext,
    identifier: string,
    opts: { otpResolver?: () => Promise<string | undefined>; channel?: 'email' | 'phone' },
  ): Promise<KeycloakTokens> {
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());

    // Snapshot this identifier's existing mail so a previous run's code can't be
    // read back. This used to wipe the WHOLE inbox, which is shared by every
    // worker — under parallel runs one login deleted another's unread OTP and
    // that test then failed with "no OTP could be read". Scoping to the
    // recipient's own message ids fixes the interference without a global write.
    const seenMailIds =
      !opts.otpResolver && this.mailpit ? await this.mailpit.idsFor(identifier) : undefined;

    const authUrl =
      `${this.kc.baseUrl}/realms/${this.kc.realm}/protocol/openid-connect/auth?` +
      new URLSearchParams({
        client_id: this.kc.clientId,
        redirect_uri: this.kc.redirectUri,
        response_type: 'code',
        scope: 'openid',
        state: b64url(randomBytes(9)),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();

    // 1. identifier form
    const start = await ctx.get(authUrl);
    let form = parseForm(await start.text());
    if (!form.action) {
      throw new Error(`[e2e/keycloak] no login form at the authorization endpoint (status ${start.status()})`);
    }

    // 2. submit the identifier
    const afterId = await ctx.post(this.toPublicUrl(form.action), {
      form: { identifier },
    });
    form = parseForm(await afterId.text());

    if (/No account matches/i.test(form.text)) {
      throw new Error(
        `[e2e/keycloak] "${identifier}" has no Keycloak identity. The OTP SPI is login-only — ` +
          'create the identity first via POST /api/v1/auth/signup.',
      );
    }

    // 2b. optional channel-choice step (shown when the identity has both an
    // email and a phone). Pick the requested channel, else the first offered.
    if (!form.inputs.includes('otp') && (form.buttons.length > 0 || form.inputs.includes('channel'))) {
      const wanted = opts.channel;
      const chosen =
        (wanted && form.buttons.find(([, v]) => v.toLowerCase().includes(wanted))) ??
        form.buttons[0];
      const body = chosen ? { [chosen[0]]: chosen[1] } : { channel: wanted ?? 'email' };
      if (!form.action) throw new Error('[e2e/keycloak] channel-choice form had no action');
      const afterChannel = await ctx.post(this.toPublicUrl(form.action), { form: body });
      form = parseForm(await afterChannel.text());
    }

    if (!form.inputs.includes('otp') || !form.action) {
      throw new Error(`[e2e/keycloak] expected an OTP form, got: ${form.text.slice(0, 300)}`);
    }
    const otpAction = form.action;

    // 3. read the delivered code
    const resolve =
      opts.otpResolver ??
      (async () => {
        if (!this.mailpit) return undefined;
        return this.mailpit.waitForOtp(identifier, { excludeIds: seenMailIds });
      });
    const otp = await resolve();
    if (!otp) {
      throw new Error(
        `[e2e/keycloak] no OTP could be read for "${identifier}". ` +
          'Email needs a reachable Mailpit (config.mailpitUrl); phone needs a log resolver.',
      );
    }

    // 4. submit it — success is a 302 back to the app carrying ?code=
    const afterOtp = await ctx.post(this.toPublicUrl(otpAction), {
      form: { otp },
      maxRedirects: 0,
    });
    const location = afterOtp.headers()['location'];
    if (!location) {
      const failed = parseForm(await afterOtp.text());
      throw new Error(`[e2e/keycloak] OTP submit did not redirect: ${failed.text.slice(0, 300)}`);
    }
    const code = new URL(location).searchParams.get('code');
    if (!code) throw new Error(`[e2e/keycloak] redirect carried no authorization code: ${location}`);

    // 5. exchange the code (PKCE — the public client has no secret)
    const tokenRes = await ctx.post(
      `${this.kc.baseUrl}/realms/${this.kc.realm}/protocol/openid-connect/token`,
      {
        form: {
          grant_type: 'authorization_code',
          client_id: this.kc.clientId,
          code,
          redirect_uri: this.kc.redirectUri,
          code_verifier: verifier,
        },
      },
    );
    if (!tokenRes.ok()) {
      throw new Error(`[e2e/keycloak] token exchange failed: ${tokenRes.status()} ${await tokenRes.text()}`);
    }
    return (await tokenRes.json()) as KeycloakTokens;
  }
}

/** Decode a JWT payload without verifying — for asserting claims in tests. */
export function decodeJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('[e2e/keycloak] not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}
