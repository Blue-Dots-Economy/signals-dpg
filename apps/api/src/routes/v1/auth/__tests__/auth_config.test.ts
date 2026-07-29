import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * The public auth-config endpoint. Beyond the self-signup/channel flags, this is
 * now what tells the UI which login screen to render — replacing a build-time
 * `VITE_AUTH_PROVIDER`, so a UI bundle can no longer disagree with the API.
 */

const mockAuthConfig = {
  allow_self_signup: false,
  login_channels: ['email', 'phone'] as Array<'email' | 'phone'>,
  provider: 'betterauth' as 'betterauth' | 'dual' | 'keycloak',
  keycloak_enabled: false,
};

const mockKeycloakConfig = {
  base_url: '',
  realm: 'bluedots',
  ui_client_id: 'signals-ui',
};

vi.mock('@/config', () => ({
  authConfig: mockAuthConfig,
  keycloakConfig: mockKeycloakConfig,
}));

async function get() {
  const { auth_config } = await import('../auth_config');
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(auth_config, { prefix: '/api/v1/auth' });
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/config' });
  await app.close();
  return res;
}

beforeEach(() => {
  mockAuthConfig.allow_self_signup = false;
  mockAuthConfig.login_channels = ['email', 'phone'];
  mockAuthConfig.provider = 'betterauth';
  mockAuthConfig.keycloak_enabled = false;
  mockKeycloakConfig.base_url = '';
  mockKeycloakConfig.realm = 'bluedots';
  mockKeycloakConfig.ui_client_id = 'signals-ui';
});

describe('GET /api/v1/auth/config', () => {
  it('returns the configured self-signup + channel flags', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      selfSignupAllowed: false,
      loginChannels: ['email', 'phone'],
    });
  });

  it('reports the provider and no Keycloak details on a better-auth instance', async () => {
    const res = await get();
    expect(res.json()).toMatchObject({ authProvider: 'betterauth', keycloak: null });
  });

  it('advertises Keycloak details once the instance is configured for it', async () => {
    mockAuthConfig.provider = 'keycloak';
    mockAuthConfig.keycloak_enabled = true;
    mockKeycloakConfig.base_url = 'http://localhost:8080';

    const res = await get();

    expect(res.json()).toMatchObject({
      authProvider: 'keycloak',
      keycloak: { url: 'http://localhost:8080', realm: 'bluedots', clientId: 'signals-ui' },
    });
  });

  it('reports dual mode, so the UI can keep the OTP screen during transition', async () => {
    mockAuthConfig.provider = 'dual';
    mockAuthConfig.keycloak_enabled = true;
    mockKeycloakConfig.base_url = 'http://localhost:8080';

    const res = await get();

    expect(res.json().authProvider).toBe('dual');
    // Details are still advertised — dual accepts Keycloak tokens — but the UI
    // maps `dual` to the OTP screen (see lib/keycloak-config.ts).
    expect(res.json().keycloak).not.toBeNull();
  });

  it('withholds Keycloak details when the mode is on but no URL is configured', async () => {
    // A half-configured instance must not send the UI somewhere broken.
    mockAuthConfig.provider = 'keycloak';
    mockAuthConfig.keycloak_enabled = true;
    mockKeycloakConfig.base_url = '';

    const res = await get();

    expect(res.json().keycloak).toBeNull();
  });

  it('never exposes the API client secret', async () => {
    mockAuthConfig.provider = 'keycloak';
    mockAuthConfig.keycloak_enabled = true;
    mockKeycloakConfig.base_url = 'http://localhost:8080';

    const res = await get();

    // The endpoint is public and unauthenticated — only OIDC-public values.
    expect(res.body).not.toContain('secret');
  });
});
