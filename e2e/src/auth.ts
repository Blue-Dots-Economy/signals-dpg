import type { APIRequestContext } from '@playwright/test';
import type { ApiClient, ApiResult } from './api-client.js';
import type { E2EConfig } from './config.js';
import { KeycloakLogin, keycloakSettingsFrom } from './keycloak.js';
import { Mailpit } from './mailpit.js';
import { readKeycloakLogOtp } from './keycloak_log.js';
import { recordCreated } from './ledger.js';

/**
 * Signals-issued OTPs (guardian challenges, and login under
 * `AUTH_PROVIDER=betterauth`) are fixed to "000000" when the target runs
 * `CREATE_TEST_OTP=true`. There is no endpoint that returns the code; the fixed
 * value IS the mechanism.
 *
 * IMPORTANT: this no longer covers the LOGIN OTP under `AUTH_PROVIDER=keycloak`.
 * That code is minted by Keycloak's OTP authenticator SPI in a separate
 * container which never sees `CREATE_TEST_OTP`, so it is random and must be read
 * back from the delivery channel (Mailpit for email, the Keycloak container log
 * for phone). Guardian OTPs are still signals-issued, so they stay "000000" in
 * both modes.
 */
export const TEST_OTP = '000000';

/**
 * Public self-signup refused this runner's IP.
 *
 * `POST /api/v1/auth/signup` allows `MAX_PER_IP = 10` per fixed hour
 * (`services/auth/self_signup.ts`) — a hardcoded constant, not configurable, so
 * a target cannot be tuned for testing. The suite spends ~7 signups per full API
 * run (journeys A, C, S all genuinely need the self-signup path), which means a
 * second run inside the same hour exhausts it.
 *
 * This is an environment limit, not a product regression, so it is worth
 * distinguishing from a real failure — see `skipIfSignupExhausted`.
 */
export class SignupRateLimitedError extends Error {
  constructor(identifier: string) {
    super(
      `[e2e] self-signup is rate-limited for this runner's IP (${identifier}). ` +
        'POST /api/v1/auth/signup allows MAX_PER_IP = 10 per hour (services/auth/self_signup.ts), ' +
        'which repeated local runs exhaust. Journeys that only NEED a persona use service ' +
        'provisioning and are unaffected; only the self-signup journeys (A, C, S) hit this. ' +
        'Wait out the 1h fixed window, or clear the `signup:ip:*` keys on the target\'s Redis.',
    );
    this.name = 'SignupRateLimitedError';
  }
}

/** Which identity provider the target's session path actually runs. */
export type AuthProvider = 'betterauth' | 'keycloak';

interface AuthConfigResponse {
  selfSignupAllowed: boolean;
  loginChannels: string[];
  authProvider?: AuthProvider;
  keycloak?: { url: string; realm: string; clientId: string } | null;
}

let providerCache: AuthProvider | undefined;

/**
 * Resolve the provider from the target itself. `config.authProvider` may pin it,
 * but `auto` (the default) asks `GET /api/v1/auth/config` — the server env is the
 * single source of truth and can flip without the config file changing.
 *
 * Targets that predate the field report no `authProvider`; those are better-auth.
 */
export async function resolveAuthProvider(api: ApiClient, cfg: E2EConfig): Promise<AuthProvider> {
  if (cfg.authProvider !== 'auto') return cfg.authProvider;
  if (providerCache) return providerCache;
  const res = await api.get<AuthConfigResponse>('/api/v1/auth/config');
  providerCache = res.body?.authProvider === 'keycloak' ? 'keycloak' : 'betterauth';
  return providerCache;
}

/** Reset the memoized provider — for tests that need a clean read. */
export function resetAuthProviderCache(): void {
  providerCache = undefined;
}

export type Channel = 'phone' | 'email';

export interface Identity {
  channel: Channel;
  /** E.164 phone (channel=phone) or email address (channel=email). */
  value: string;
}

function identityBody(id: Identity): Record<string, string> {
  return id.channel === 'phone' ? { phoneNumber: id.value } : { email: id.value };
}

/** Query-string fragment for consent status-by-identifier. */
export function identityQuery(id: Identity): string {
  return id.channel === 'phone' ? `phone=${encodeURIComponent(id.value)}` : `email=${encodeURIComponent(id.value)}`;
}

interface CheckUserResp { userExists: boolean }
interface VerifyResp { token: string; user: { id: string; name?: string; email?: string; phoneNumber?: string }; afterUserCreate?: unknown }

export async function checkUser(api: ApiClient, id: Identity): Promise<ApiResult<CheckUserResp>> {
  return api.post<CheckUserResp>('/api/auth/unified-otp/check-user', identityBody(id));
}

export async function requestOtp(api: ApiClient, id: Identity): Promise<ApiResult<{ ok: boolean; user: boolean }>> {
  return api.post('/api/auth/unified-otp/request', identityBody(id));
}

export async function verifyOtp(
  api: ApiClient,
  id: Identity,
  opts: { name?: string; dateOfBirth?: string | null; otp?: string } = {},
): Promise<ApiResult<VerifyResp>> {
  return api.post<VerifyResp>('/api/auth/unified-otp/verify', {
    ...identityBody(id),
    otp: opts.otp ?? TEST_OTP,
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.dateOfBirth !== undefined ? { dateOfBirth: opts.dateOfBirth } : {}),
  });
}

export interface Session {
  token: string;
  userId: string;
  identity: Identity;
  /** An ApiClient carrying the session Bearer token. */
  client: ApiClient;
}

/** Everything the Keycloak path needs that the better-auth path does not. */
export interface AuthContext {
  cfg: E2EConfig;
  /** Playwright request context — the Keycloak driver needs its own cookie jar. */
  request: APIRequestContext;
}

// ── better-auth path ────────────────────────────────────────────────────────

async function betterAuthSignup(api: ApiClient, id: Identity, name: string): Promise<Session> {
  const req = await requestOtp(api, id);
  if (req.status !== 200) {
    throw new Error(`[e2e] signup request-otp failed for ${id.value}: ${req.status} ${JSON.stringify(req.body)}`);
  }
  const verify = await verifyOtp(api, id, { name });
  if (verify.status !== 200 || !verify.body?.token) {
    throw new Error(`[e2e] signup verify failed for ${id.value}: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  return { token: verify.body.token, userId: verify.body.user.id, identity: id, client: api.with({ bearer: verify.body.token }) };
}

async function betterAuthLogin(api: ApiClient, id: Identity): Promise<Session> {
  const req = await requestOtp(api, id);
  if (req.status !== 200) throw new Error(`[e2e] login request-otp failed for ${id.value}: ${req.status} ${JSON.stringify(req.body)}`);
  const verify = await verifyOtp(api, id);
  if (verify.status !== 200 || !verify.body?.token) {
    throw new Error(`[e2e] login verify failed for ${id.value}: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  return { token: verify.body.token, userId: verify.body.user.id, identity: id, client: api.with({ bearer: verify.body.token }) };
}

// ── Keycloak path ───────────────────────────────────────────────────────────

/**
 * Create the Keycloak identity via signals' own public self-signup route.
 * The OTP SPI is login-only and Keycloak's built-in registration form is
 * password-based, which is exactly why this endpoint exists. No local `user`
 * row appears until the first successful login.
 */
export async function keycloakSelfSignup(
  api: ApiClient,
  id: Identity,
  name: string,
  opts: { domain?: string; age?: number } = {},
): Promise<{ ok: boolean; alreadyRegistered: boolean; status: number; body: unknown }> {
  const res = await api.post<{ ok: boolean; alreadyRegistered: boolean }>('/api/v1/auth/signup', {
    name,
    ...(id.channel === 'phone' ? { phoneNumber: id.value } : { email: id.value }),
    ...(opts.domain ? { domain: opts.domain } : {}),
    ...(opts.age !== undefined ? { age: opts.age } : {}),
  });
  return {
    ok: res.status === 200 && res.body?.ok === true,
    alreadyRegistered: res.body?.alreadyRegistered ?? false,
    status: res.status,
    body: res.body,
  };
}

function keycloakDriver(ctx: AuthContext): KeycloakLogin {
  const mailpit = ctx.cfg.mailpitUrl ? new Mailpit(ctx.request, ctx.cfg.mailpitUrl) : null;
  return new KeycloakLogin(keycloakSettingsFrom(ctx.cfg), mailpit);
}

/** Drive the OIDC OTP flow and wrap the access token in a Session. */
async function keycloakSessionFor(api: ApiClient, ctx: AuthContext, id: Identity): Promise<Session> {
  const driver = keycloakDriver(ctx);
  const otpResolver =
    id.channel === 'phone' && ctx.cfg.keycloakLogContainer
      ? () => readKeycloakLogOtp(ctx.cfg.keycloakLogContainer as string, id.value)
      : undefined;

  const tokens = await driver.login(id.value, { channel: id.channel, otpResolver });
  const client = api.with({ bearer: tokens.access_token });

  // The local `user` row is materialized by the API on the first authenticated
  // call (provisionUserFromClaims), so read the id back rather than guessing it
  // from the token's `sub` — they are the same by design, but /auth/me is the
  // contract and it also proves the mirror actually happened.
  const me = await client.get<{ id: string }>('/api/v1/auth/me');
  if (me.status !== 200 || !me.body?.id) {
    throw new Error(`[e2e] keycloak login succeeded but /auth/me failed for ${id.value}: ${me.status} ${JSON.stringify(me.body)}`);
  }
  return { token: tokens.access_token, userId: me.body.id, identity: id, client };
}

// ── provider-dispatching public API ─────────────────────────────────────────

/**
 * Full self-signup for a brand-new identity. Requires the target to allow
 * self-signup. Dispatches on the target's resolved provider:
 *
 *  - betterauth: request OTP → verify(name), which creates the user.
 *  - keycloak  : POST /api/v1/auth/signup (creates the Keycloak identity) then
 *                the OIDC OTP login, which materializes the local user row.
 */
export async function signup(
  api: ApiClient,
  id: Identity,
  name: string,
  ctx?: AuthContext,
  opts: { domain?: string; age?: number } = {},
): Promise<Session> {
  const provider = ctx ? await resolveAuthProvider(api, ctx.cfg) : 'betterauth';
  if (provider === 'betterauth') {
    const session = await betterAuthSignup(api, id, name);
    // This is the only path that mints a brand-new better-auth user row, so
    // it's the one choke point that needs to ledger it — every caller of
    // signup() (direct journeys and flows.ts's createLiveProfileUser) gets
    // this for free rather than each needing its own recordCreated call.
    recordCreated('user', session.userId);
    return session;
  }
  if (!ctx) throw new Error('[e2e] keycloak signup needs an AuthContext');

  const created = await keycloakSelfSignup(api, id, name, opts);
  if (!created.ok) {
    if (created.status === 429) {
      throw new SignupRateLimitedError(id.value);
    }
    throw new Error(`[e2e] keycloak self-signup failed for ${id.value}: ${created.status} ${JSON.stringify(created.body)}`);
  }
  // Keycloak: the local `user` row is materialized right here, on this first
  // authenticated call (see keycloakSessionFor's doc comment) — same choke
  // point reasoning as the betterauth branch above.
  const session = await keycloakSessionFor(api, ctx, id);
  recordCreated('user', session.userId);
  return session;
}

/** Existing-user login. */
export async function login(api: ApiClient, id: Identity, ctx?: AuthContext): Promise<Session> {
  const provider = ctx ? await resolveAuthProvider(api, ctx.cfg) : 'betterauth';
  if (provider === 'betterauth') return betterAuthLogin(api, id);
  if (!ctx) throw new Error('[e2e] keycloak login needs an AuthContext');
  return keycloakSessionFor(api, ctx, id);
}

/** Accept the universal terms + privacy for a session's user (version derived server-side). */
export async function acceptCoreConsent(session: Session, network: string, source: 'signup' | 'login' = 'signup'): Promise<void> {
  const res = await session.client.post('/api/v1/consent/accept', {
    network,
    source,
    items: [
      { category: 'terms', version: 1 },
      { category: 'privacy', version: 1 },
    ],
  });
  if (res.status !== 200) {
    throw new Error(`[e2e] consent/accept failed for ${session.identity.value}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}
