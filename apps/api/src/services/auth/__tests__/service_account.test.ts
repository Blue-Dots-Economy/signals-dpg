import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Client-credentials service auth (§5). The properties that matter:
 * the allowlist is enforced, the client→service-user mapping is by slug, and
 * every failure mode fails closed rather than binding to the wrong identity.
 */

const dbState = {
  rows: [] as unknown[],
  selectError: null as unknown,
};

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: function innerJoin() {
          return this;
        },
        where: () => ({
          limit: async () => {
            if (dbState.selectError) throw dbState.selectError;
            return dbState.rows;
          },
        }),
      }),
    }),
  },
}));

const mockKeycloakConfig = {
  service_client_ids: ['aggregator-dpg', 'voice-dpg'],
  session_client_ids: ['signals-ui', 'signals-api'],
};

vi.mock('@/config', () => ({ keycloakConfig: mockKeycloakConfig }));

const { resolveServiceAccount, serviceClientId } = await import('../service_account.js');

const makeLog = () =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'service-account-sub',
    iss: 'http://kc/realms/bluedots',
    aud: ['account'],
    azp: 'aggregator-dpg',
    exp: 9999999999,
    client_id: 'aggregator-dpg',
    preferred_username: 'service-account-aggregator-dpg',
    ...overrides,
  } as Parameters<typeof resolveServiceAccount>[0];
}

const SERVICE_ROW = {
  userId: 'usr_service_1',
  email: 'aggregator-dpg-svc@signals.local',
  name: 'aggregator-dpg',
  role: null,
  orgType: 'network_service',
};

beforeEach(() => {
  dbState.rows = [];
  dbState.selectError = null;
  mockKeycloakConfig.service_client_ids = ['aggregator-dpg', 'voice-dpg'];
});

describe('serviceClientId', () => {
  it('prefers the client_id claim', () => {
    expect(serviceClientId(claims())).toBe('aggregator-dpg');
  });

  it('falls back to azp', () => {
    expect(serviceClientId(claims({ client_id: undefined }))).toBe('aggregator-dpg');
  });

  it('derives from the service-account username as a last resort', () => {
    expect(
      serviceClientId(
        claims({
          client_id: undefined,
          azp: undefined,
          preferred_username: 'service-account-voice-dpg',
        })
      )
    ).toBe('voice-dpg');
  });

  it('returns null when the token names no client at all', () => {
    expect(
      serviceClientId(
        claims({ client_id: undefined, azp: undefined, preferred_username: undefined })
      )
    ).toBeNull();
  });
});

describe('resolveServiceAccount', () => {
  it('resolves an allowlisted client to its seeded service user', async () => {
    dbState.rows = [SERVICE_ROW];

    const result = await resolveServiceAccount(claims(), makeLog());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same shape as the apikey path produced, so acting_org and every admin
    // route downstream cannot tell which credential was used.
    expect(result.user).toEqual({
      id: 'usr_service_1',
      email: 'aggregator-dpg-svc@signals.local',
      name: 'aggregator-dpg',
      role: null,
    });
  });

  it('rejects a client that is not on the service allowlist', async () => {
    dbState.rows = [SERVICE_ROW];
    mockKeycloakConfig.service_client_ids = ['voice-dpg'];

    const result = await resolveServiceAccount(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_CLIENT_NOT_ALLOWED');
  });

  it('rejects every client when the allowlist is empty (the default)', async () => {
    // Service auth stays on x-api-key until an operator names the clients.
    dbState.rows = [SERVICE_ROW];
    mockKeycloakConfig.service_client_ids = [];

    const result = await resolveServiceAccount(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_CLIENT_NOT_ALLOWED');
  });

  it("rejects signals' own admin service account", async () => {
    // signals-api holds realm-management roles for provisioning; it is not an
    // integrating DPG and must not be able to call the service path.
    dbState.rows = [SERVICE_ROW];

    const result = await resolveServiceAccount(
      claims({ client_id: 'signals-api', azp: 'signals-api' }),
      makeLog()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_CLIENT_NOT_ALLOWED');
  });

  it('rejects a token that names no client', async () => {
    const result = await resolveServiceAccount(
      claims({ client_id: undefined, azp: undefined, preferred_username: undefined }),
      makeLog()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_CLIENT_UNKNOWN');
  });

  it('fails closed when no service user is seeded for the client', async () => {
    dbState.rows = [];
    const log = makeLog();

    const result = await resolveServiceAccount(claims(), log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_ACCOUNT_NOT_PROVISIONED');
    // The operator needs to know the slug convention was not met.
    expect(log.error).toHaveBeenCalled();
  });

  it('rejects when the matching org is not a service org type', async () => {
    // A slug collision with, say, a participant-facing org must not hand out a
    // service identity.
    dbState.rows = [{ ...SERVICE_ROW, orgType: 'something_else' }];

    const result = await resolveServiceAccount(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_ACCOUNT_NOT_PROVISIONED');
  });

  it('rejects when the org carries no type at all', async () => {
    dbState.rows = [{ ...SERVICE_ROW, orgType: null }];

    const result = await resolveServiceAccount(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_ACCOUNT_NOT_PROVISIONED');
  });

  it('reports a database failure distinctly from a missing account', async () => {
    dbState.selectError = new Error('connection reset');
    const log = makeLog();

    const result = await resolveServiceAccount(claims(), log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SERVICE_ACCOUNT_LOOKUP_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('accepts the other seeded integrating DPG', async () => {
    dbState.rows = [
      { ...SERVICE_ROW, userId: 'usr_service_2', name: 'voice-dpg', orgType: 'voice' },
    ];

    const result = await resolveServiceAccount(
      claims({ client_id: 'voice-dpg', azp: 'voice-dpg' }),
      makeLog()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe('usr_service_2');
  });
});
