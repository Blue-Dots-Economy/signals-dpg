import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));
vi.mock('@/utils/keycloak_token', () => ({ verifyKeycloakToken: vi.fn() }));
vi.mock('@api/plugins/auth/resolve_session', () => ({ resolveHumanSession: vi.fn() }));
vi.mock('@/middleware/public_rate_limit', () => ({
  public_rate_limit: () => async () => undefined,
}));

const mockSso = { enabled: true, oidc: { kc_alias: 'signals-sso' } };
const mockAuth = { keycloak_enabled: true };
vi.mock('@/config', () => ({
  authConfig: mockAuth,
  ssoConfig: mockSso,
  instance: { INSTANCE_ENV: 'production' },
  keycloakConfig: { base_url: 'https://kc.example.org', realm: 'bluedots' },
  getCurrentApiBaseUrl: () => 'https://api.example.org',
}));
vi.mock('@/services/auth/oidc_flow_state', async (orig) => ({
  ...(await orig<typeof import('@/services/auth/oidc_flow_state')>()),
  safeAppOrigin: (raw: unknown, fallback: string) =>
    raw === 'https://app.example.org' ? raw : fallback,
}));

const verify = vi.fn();
const provider = { id: 'ncs', appOrigin: 'https://app.example.org', verify };
const getActiveSsoProvider = vi.fn(() => provider as unknown);
vi.mock('@/services/auth/sso/registry', () => ({
  getActiveSsoProvider: () => getActiveSsoProvider(),
}));
const resolveAccountLink = vi.fn();
vi.mock('@/services/auth/sso/link_resolver', () => ({
  resolveAccountLink: (...a: unknown[]) => resolveAccountLink(...a),
}));
vi.mock('@/services/auth/keycloak_admin_instance', () => ({
  getKeycloakAdminClient: () => ({}),
}));
const saveEntry = vi.fn();
vi.mock('@/services/auth/sso/sso_store', () => ({
  saveEntry: (...a: unknown[]) => saveEntry(...a),
  SSO_ENTRY_TTL_SECONDS: 300,
}));
const endBrowserSessionEverywhere = vi.fn();
vi.mock('@/services/auth/end_browser_session', () => ({
  endBrowserSessionEverywhere: (...a: unknown[]) => endBrowserSessionEverywhere(...a),
}));
const startLoginFlow = vi.fn(async (..._a: unknown[]) => 'https://kc.example.org/auth?x=1');
vi.mock('@/routes/v1/auth/login_flow', async (orig) => ({
  ...(await orig<typeof import('@/routes/v1/auth/login_flow')>()),
  startLoginFlow: (...a: unknown[]) => startLoginFlow(...a),
}));

const IDENTITY = { provider: 'ncs', subject: 'ncs:u-1', phone: '+919730862967' };

async function inject(opts: InjectOptions) {
  const { auth_sso_login } = await import('../sso_login.js');
  const app = Fastify({ trustProxy: true });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(auth_sso_login, { prefix: '/api/v1/auth/sso' });
  const res = await app.inject(opts);
  await app.close();
  return res;
}

const LOGIN = '/api/v1/auth/sso/login?userName=jwt&sig=s&expiry=1&featureKey=placement-prep';

beforeEach(() => {
  vi.clearAllMocks();
  mockSso.enabled = true;
  mockAuth.keycloak_enabled = true;
  verify.mockResolvedValue({
    ok: true,
    value: { identity: IDENTITY, returnTo: '/discover', appOrigin: 'https://app.example.org' },
  });
  resolveAccountLink.mockResolvedValue({ ok: true, value: { preferredUsername: '+919730862967' } });
});

describe('GET /api/v1/auth/sso/login', () => {
  it('verifies, stashes the identity, and sends the browser to Keycloak via signals-sso', async () => {
    const res = await inject({ method: 'GET', url: LOGIN });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://kc.example.org/auth?x=1');
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ userName: 'jwt', sig: 's', featureKey: 'placement-prep' })
    );
    const [handle, entry] = saveEntry.mock.calls[0] as [string, unknown];
    expect(handle).toMatch(/^[\w-]{40,}$/);
    expect(entry).toEqual({ identity: IDENTITY, preferredUsername: '+919730862967' });
    expect(startLoginFlow).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      returnTo: '/discover',
      appOrigin: 'https://app.example.org',
      idpHint: 'signals-sso',
      sso: { provider: 'ncs', handle },
    });
    const cookieSet = res.cookies.find((c) => c.name === 'sso_h');
    expect(cookieSet).toMatchObject({
      value: handle,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/api/v1/auth/sso/oidc',
    });
  });

  it('hardens the response and never echoes the partner token', async () => {
    const res = await inject({ method: 'GET', url: LOGIN });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers.location)).not.toContain('jwt');
  });

  it('sends a refused link to the error page with only the reason', async () => {
    verify.mockResolvedValue({ ok: false, reason: 'link-expired', detail: 'secret detail' });
    const res = await inject({ method: 'GET', url: LOGIN });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://app.example.org/auth/sso/error?reason=link-expired');
    expect(saveEntry).not.toHaveBeenCalled();
    expect(startLoginFlow).not.toHaveBeenCalled();
  });

  it('sends a refused account link to the error page', async () => {
    resolveAccountLink.mockResolvedValue({ ok: false, reason: 'phone-unverified' });
    const res = await inject({ method: 'GET', url: LOGIN });
    expect(res.headers.location).toBe(
      'https://app.example.org/auth/sso/error?reason=phone-unverified'
    );
    expect(saveEntry).not.toHaveBeenCalled();
  });

  it('ends a session already in the browser before logging someone in', async () => {
    const res = await inject({ method: 'GET', url: LOGIN, headers: { cookie: 'sid=old-session' } });
    expect(endBrowserSessionEverywhere).toHaveBeenCalledWith('old-session', expect.anything());
    const cleared = res.cookies.find((c) => c.name === 'sid');
    expect(cleared?.value).toBe('');
  });

  it('leaves a browser with no session alone', async () => {
    await inject({ method: 'GET', url: LOGIN });
    expect(endBrowserSessionEverywhere).not.toHaveBeenCalled();
  });

  it('404s when SSO is off or the instance is not on Keycloak', async () => {
    mockSso.enabled = false;
    expect((await inject({ method: 'GET', url: LOGIN })).statusCode).toBe(404);
    mockSso.enabled = true;
    mockAuth.keycloak_enabled = false;
    expect((await inject({ method: 'GET', url: LOGIN })).statusCode).toBe(404);
    expect(verify).not.toHaveBeenCalled();
  });
});
