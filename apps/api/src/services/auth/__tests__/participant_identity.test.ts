import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Keycloak identity creation for admin-onboarded participants.
 *
 * What matters here is that the `sub == user.id` invariant survives, and that
 * every failure is *reported* rather than swallowed — an onboarded participant
 * with no realm identity can never log in, which is the bug this closes.
 */

const mockAuthConfig = { keycloak_enabled: true };
const mockKeycloakConfig = {
  internal_base_url: 'http://keycloak:8080' as string | undefined,
  realm: 'bluedots',
  api_client_id: 'signals-api',
  api_client_secret: 'shh' as string | undefined,
};
vi.mock('@/config', () => ({
  authConfig: mockAuthConfig,
  keycloakConfig: mockKeycloakConfig,
}));

type Rep = {
  id: string;
  username: string;
  email?: string;
  attributes: Record<string, string[]>;
};
const createUserPreservingId =
  vi.fn<(user: Rep) => Promise<{ kind: string; detail?: string; assignedId?: string }>>();

vi.mock('@/services/auth/keycloak_admin', () => ({
  KeycloakAdminClient: class {
    createUserPreservingId = createUserPreservingId;
  },
}));

const { createParticipantKeycloakIdentity, resetParticipantIdentityState } = await import(
  '../participant_identity.js'
);

const makeLog = () =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

const USER_ID = '2cc676ff-0d6b-44f3-92ff-5abc04fd3c25';
const INPUT = {
  userId: USER_ID,
  name: 'Asha Rao',
  email: 'asha@example.org',
  phoneNumber: '+919876543220',
};

beforeEach(() => {
  resetParticipantIdentityState();
  mockAuthConfig.keycloak_enabled = true;
  mockKeycloakConfig.internal_base_url = 'http://keycloak:8080';
  mockKeycloakConfig.api_client_secret = 'shh';
  createUserPreservingId.mockReset().mockResolvedValue({ kind: 'created' });
});

describe('provider modes', () => {
  it('is a no-op under AUTH_PROVIDER=betterauth', async () => {
    mockAuthConfig.keycloak_enabled = false;

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result).toEqual({ ok: true, created: false });
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('creates the identity when Keycloak is enabled', async () => {
    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result).toEqual({ ok: true, created: true });
    expect(createUserPreservingId).toHaveBeenCalledTimes(1);
  });
});

describe('the sub == user.id invariant', () => {
  it('sends the signals user id as the Keycloak id, unchanged', async () => {
    await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(createUserPreservingId.mock.calls[0]![0].id).toBe(USER_ID);
  });

  it('carries the phone as the phoneNumber attribute the OTP flow reads', async () => {
    await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    const rep = createUserPreservingId.mock.calls[0]![0];
    expect(rep.attributes.phoneNumber).toEqual(['+919876543220']);
    expect(rep.attributes.phoneNumberVerified).toEqual(['false']);
  });

  it('fails when Keycloak did not preserve the id', async () => {
    createUserPreservingId.mockResolvedValue({
      kind: 'created_with_different_id',
      assignedId: 'some-other-id',
    });

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result).toEqual({
      ok: false,
      code: 'IDENTITY_CREATE_FAILED',
      message: 'Keycloak did not preserve the user id',
    });
  });
});

describe('failure reporting', () => {
  it('treats an existing identity with the same id as success (idempotent retry)', async () => {
    createUserPreservingId.mockResolvedValue({ kind: 'already_exists' });

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result).toEqual({ ok: true, created: false });
  });

  it('reports a conflict when another realm user owns the identifiers', async () => {
    createUserPreservingId.mockResolvedValue({ kind: 'conflict', detail: 'added=0 skipped=1' });

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('IDENTITY_CONFLICT');
  });

  it('fails closed when the admin client is not configured', async () => {
    mockKeycloakConfig.api_client_secret = undefined;

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('IDENTITY_PROVIDER_NOT_CONFIGURED');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('reports NO_IDENTIFIER when the row has neither email nor phone', async () => {
    const result = await createParticipantKeycloakIdentity({
      ...INPUT,
      email: null,
      phoneNumber: null,
      log: makeLog(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('NO_IDENTIFIER');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('does not throw when Keycloak is unreachable', async () => {
    createUserPreservingId.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await createParticipantKeycloakIdentity({ ...INPUT, log: makeLog() });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('IDENTITY_CREATE_FAILED');
  });

  it('logs a structured failure entry with operation and status', async () => {
    createUserPreservingId.mockRejectedValue(new Error('boom'));
    const log = makeLog();

    await createParticipantKeycloakIdentity({ ...INPUT, log });

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'createParticipantKeycloakIdentity',
        status: 'failure',
        error: 'boom',
      }),
    );
  });
});

describe('phone-only participants', () => {
  it('creates the identity from the phone alone', async () => {
    const result = await createParticipantKeycloakIdentity({
      ...INPUT,
      email: null,
      log: makeLog(),
    });

    expect(result).toEqual({ ok: true, created: true });
    const rep = createUserPreservingId.mock.calls[0]![0];
    expect(rep.id).toBe(USER_ID);
    expect(rep.attributes.phoneNumber).toEqual(['+919876543220']);
  });
});
