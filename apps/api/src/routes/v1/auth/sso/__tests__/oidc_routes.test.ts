import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import { generateKeyPairSync } from 'node:crypto';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { createOidcKeys } from '@/services/auth/sso/oidc_keys';

vi.mock('@api/db/secondary/redis', () => ({ redis: {} }));

const SECRET = 'k'.repeat(40);
const mockSso = {
  enabled: true,
  oidc: { client_id: 'signals-sso', client_secret: SECRET, kc_alias: 'signals-sso' },
};
vi.mock('@/config', () => ({
  authConfig: { keycloak_enabled: true },
  ssoConfig: mockSso,
  instance: { INSTANCE_ENV: 'production' },
  keycloakConfig: { base_url: 'https://kc.example.org/auth', realm: 'bluedots' },
  getCurrentApiBaseUrl: () => 'https://api.example.org',
}));
vi.mock('@/services/auth/oidc_flow_state', () => ({
  safeAppOrigin: (raw: unknown, fallback: string) =>
    raw === 'https://app.example.org' ? raw : fallback,
}));

const keys = createOidcKeys(
  generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
);
vi.mock('@/services/auth/sso/registry', () => ({
  getSsoOidcKeys: () => keys,
  getActiveSsoProvider: () => ({ id: 'ncs', appOrigin: 'https://app.example.org' }),
}));

const peekEntry = vi.fn();
const saveCode = vi.fn();
const takeCode = vi.fn();
vi.mock('@/services/auth/sso/sso_store', () => ({
  peekEntry: (...a: unknown[]) => peekEntry(...a),
  saveCode: (...a: unknown[]) => saveCode(...a),
  takeCode: (...a: unknown[]) => takeCode(...a),
  SSO_ENTRY_TTL_SECONDS: 300,
}));

const BROKER = 'https://kc.example.org/auth/realms/bluedots/broker/signals-sso/endpoint';
const ISSUER = 'https://api.example.org/api/v1/auth/sso/oidc';
const ENTRY = {
  identity: {
    provider: 'ncs',
    subject: 'ncs:u-1',
    fullName: 'Ameya Kulkarni',
    phone: '+919730862967',
    phoneVerified: true,
    email: 'ameya@gmail.com',
  },
  preferredUsername: '+919730862967',
};

async function inject(opts: InjectOptions) {
  const { auth_sso_oidc } = await import('../oidc_routes.js');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(auth_sso_oidc, { prefix: '/api/v1/auth/sso/oidc' });
  const res = await app.inject(opts);
  await app.close();
  return res;
}

const authorizeUrl = (over: Record<string, string> = {}) =>
  `/api/v1/auth/sso/oidc/authorize?${new URLSearchParams({
    client_id: 'signals-sso',
    redirect_uri: BROKER,
    response_type: 'code',
    state: 'kc-state',
    nonce: 'kc-nonce',
    ...over,
  }).toString()}`;

const tokenRequest = (over: Record<string, string> = {}): InjectOptions => ({
  method: 'POST',
  url: '/api/v1/auth/sso/oidc/token',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'the-code',
    redirect_uri: BROKER,
    client_id: 'signals-sso',
    client_secret: SECRET,
    ...over,
  }).toString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSso.enabled = true;
  peekEntry.mockResolvedValue(ENTRY);
  takeCode.mockResolvedValue({ handle: 'h-1', nonce: 'kc-nonce', redirectUri: BROKER });
});

describe('jwks', () => {
  it('serves no discovery document (Keycloak is configured with the URLs)', async () => {
    const res = await inject({
      method: 'GET',
      url: '/api/v1/auth/sso/oidc/.well-known/openid-configuration',
    });
    expect(res.statusCode).toBe(404);
  });

  it('serves the public key', async () => {
    const res = await inject({ method: 'GET', url: '/api/v1/auth/sso/oidc/jwks' });
    expect(res.json().keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256' });
  });
});

describe('GET /authorize', () => {
  it('issues a one-time code back to the Keycloak broker endpoint', async () => {
    const res = await inject({
      method: 'GET',
      url: authorizeUrl(),
      headers: { cookie: 'sso_h=h-1' },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(BROKER);
    expect(location.searchParams.get('state')).toBe('kc-state');
    const code = location.searchParams.get('code');
    expect(saveCode).toHaveBeenCalledWith(code, {
      handle: 'h-1',
      nonce: 'kc-nonce',
      redirectUri: BROKER,
    });
    expect(res.cookies.find((c) => c.name === 'sso_h')?.value).toBe('');
  });

  it.each([
    ['an unknown client', { client_id: 'other' }],
    ['a foreign redirect_uri', { redirect_uri: 'https://evil.test/cb' }],
    ['a non-code response_type', { response_type: 'token' }],
  ])('refuses %s with 400 and never redirects', async (_label, over) => {
    const res = await inject({ method: 'GET', url: authorizeUrl(over), headers: { cookie: 'sso_h=h-1' } });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(saveCode).not.toHaveBeenCalled();
  });

  it('sends a browser without a live SSO entry to the error page', async () => {
    peekEntry.mockResolvedValue(null);
    const res = await inject({ method: 'GET', url: authorizeUrl(), headers: { cookie: 'sso_h=h-1' } });
    expect(res.headers.location).toBe('https://app.example.org/auth/sso/error?reason=session-expired');
    const noCookie = await inject({ method: 'GET', url: authorizeUrl() });
    expect(noCookie.headers.location).toContain('reason=session-expired');
    expect(saveCode).not.toHaveBeenCalled();
  });
});

describe('POST /token', () => {
  it('returns an id_token Keycloak can verify, without an email claim', async () => {
    const res = await inject(tokenRequest());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('Bearer');

    const { payload } = await jwtVerify(body.id_token, createLocalJWKSet(await keys.jwks()), {
      issuer: ISSUER,
      audience: 'signals-sso',
    });
    expect(payload).toMatchObject({
      sub: 'ncs:u-1',
      nonce: 'kc-nonce',
      preferred_username: '+919730862967',
      name: 'Ameya Kulkarni',
      given_name: 'Ameya',
      family_name: 'Kulkarni',
      phone_number: '+919730862967',
      phone_number_verified: true,
      sso_provider: 'ncs',
    });
    expect(payload).not.toHaveProperty('email');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('accepts client_secret_basic', async () => {
    const basic = Buffer.from(`signals-sso:${SECRET}`).toString('base64');
    const req = tokenRequest({ client_id: '', client_secret: '' });
    const res = await inject({
      ...req,
      headers: { ...req.headers, authorization: `Basic ${basic}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a wrong client secret before touching the code', async () => {
    const res = await inject(tokenRequest({ client_secret: 'wrong' }));
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(takeCode).not.toHaveBeenCalled();
  });

  it('refuses an unknown, used or mismatched code', async () => {
    takeCode.mockResolvedValueOnce(null);
    expect((await inject(tokenRequest())).json().error).toBe('invalid_grant');

    takeCode.mockResolvedValueOnce({ handle: 'h-1', nonce: null, redirectUri: 'https://other' });
    expect((await inject(tokenRequest())).json().error).toBe('invalid_grant');
  });

  it('refuses when the login behind the code expired', async () => {
    peekEntry.mockResolvedValue(null);
    expect((await inject(tokenRequest())).json().error).toBe('invalid_grant');
  });

  it('refuses other grant types', async () => {
    const res = await inject(tokenRequest({ grant_type: 'client_credentials' }));
    expect(res.json().error).toBe('unsupported_grant_type');
  });
});

describe('disabled', () => {
  it('404s every route when SSO is off', async () => {
    mockSso.enabled = false;
    for (const url of ['/api/v1/auth/sso/oidc/jwks', authorizeUrl()]) {
      expect((await inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    expect((await inject(tokenRequest())).statusCode).toBe(404);
  });
});
