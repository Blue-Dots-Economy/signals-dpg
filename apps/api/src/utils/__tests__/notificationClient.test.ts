import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The app-side factory: built from config, undefined when not configured, and
 * memoised so every sender shares one client and one cached token.
 */

const config = vi.hoisted(() => ({
  notification: { NOTIFICATION_SERVICE_ENDPOINT: 'http://ns:3000' as string | undefined },
  keycloakConfig: {
    internal_base_url: 'http://keycloak:8080/auth',
    realm: 'bluedots',
    api_client_id: 'signals-api',
    api_client_secret: 'shh' as string | undefined,
  },
}));
vi.mock('@/config', () => config);

const createTokenSource = vi.hoisted(() => vi.fn());
vi.mock('@dpg/notification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/notification')>();
  createTokenSource.mockImplementation(actual.createClientCredentialsTokenSource);
  return { ...actual, createClientCredentialsTokenSource: createTokenSource };
});

async function freshModule() {
  vi.resetModules();
  return import('../notificationClient');
}

beforeEach(() => {
  createTokenSource.mockClear();
  config.notification.NOTIFICATION_SERVICE_ENDPOINT = 'http://ns:3000';
  config.keycloakConfig.api_client_secret = 'shh';
});

describe('getNotificationClient', () => {
  it('is undefined without an endpoint', async () => {
    config.notification.NOTIFICATION_SERVICE_ENDPOINT = undefined;
    const { getNotificationClient } = await freshModule();
    expect(getNotificationClient()).toBeUndefined();
  });

  it('is undefined without the Keycloak client secret', async () => {
    config.keycloakConfig.api_client_secret = undefined;
    const { getNotificationClient } = await freshModule();
    expect(getNotificationClient()).toBeUndefined();
  });

  it('builds the token source from the Keycloak service-account config', async () => {
    const { getNotificationClient } = await freshModule();
    expect(getNotificationClient()).toBeDefined();
    expect(createTokenSource).toHaveBeenCalledWith({
      tokenUrl: 'http://keycloak:8080/auth/realms/bluedots/protocol/openid-connect/token',
      clientId: 'signals-api',
      clientSecret: 'shh',
    });
  });

  it('memoises the client and its token source', async () => {
    const { getNotificationClient } = await freshModule();
    const first = getNotificationClient();
    expect(getNotificationClient()).toBe(first);
    expect(createTokenSource).toHaveBeenCalledTimes(1);
  });

  it('returns a plain NotificationClient with only the event API', async () => {
    const { getNotificationClient } = await freshModule();
    const { NotificationClient } = await import('@dpg/notification');
    const client = getNotificationClient();
    expect(client).toBeInstanceOf(NotificationClient);
    expect(Object.getPrototypeOf(client)).toBe(NotificationClient.prototype);
    expect('notify' in client!).toBe(false);
  });
});
