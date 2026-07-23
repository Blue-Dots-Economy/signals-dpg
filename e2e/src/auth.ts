import type { ApiClient, ApiResult } from './api-client.js';

/**
 * When the target runs with CREATE_TEST_OTP=true, every OTP (login and guardian)
 * is the fixed string "000000" — so headless tests submit this directly. There
 * is no endpoint that returns the code; the fixed value IS the mechanism.
 */
export const TEST_OTP = '000000';

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

/** Full self-signup: request OTP → verify(name). Requires selfSignupAllowed. */
export async function signup(api: ApiClient, id: Identity, name: string): Promise<Session> {
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

/** Existing-user login: request → verify. */
export async function login(api: ApiClient, id: Identity): Promise<Session> {
  const req = await requestOtp(api, id);
  if (req.status !== 200) throw new Error(`[e2e] login request-otp failed for ${id.value}: ${req.status} ${JSON.stringify(req.body)}`);
  const verify = await verifyOtp(api, id);
  if (verify.status !== 200 || !verify.body?.token) {
    throw new Error(`[e2e] login verify failed for ${id.value}: ${verify.status} ${JSON.stringify(verify.body)}`);
  }
  return { token: verify.body.token, userId: verify.body.user.id, identity: id, client: api.with({ bearer: verify.body.token }) };
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
