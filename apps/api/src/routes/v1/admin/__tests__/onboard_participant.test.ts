import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan 2 Task 4 — failing tests for POST /api/v1/admin/onboard_participant.
 *
 * These drive Task 5's implementation. They mount the onboarding route in
 * isolation (no global preHandler chain) and stub `request.acting_org`
 * directly so the route's own org_type guard runs without re-executing
 * the acting_org preHandler covered by Plan 1 Task 3.
 *
 * Mocks (all via vi.mock so they're hoisted ahead of the route import):
 *   1. `@api/db/postgres/drizzle_config` — db.select / db.update /
 *      db.transaction. Inside the transaction we hand the callback a `tx`
 *      stub that supports `select`, `update`, and `insert`. The
 *      attribution UPDATE the route runs is captured into dbState so
 *      tests can assert on it.
 *   2. The better-auth instance at `@/routes/auth/create_auth` — exports
 *      `authInstance` with an `api.signUpEmail` mock that either returns
 *      `{ user: { id } }` (happy path) or rejects with a PG 23505-shaped
 *      error (race).
 *   3. `@/lib/profile_item` — `create_profile_item` returns a deterministic
 *      `{ item_id }` so the route can return it in the response.
 */

// ---- mock @api/db/postgres/drizzle_config ----
const dbState: {
  existingUserRows: Array<{
    id: string;
    email: string | null;
    phoneNumber: string | null;
  }>;
  signUpMode: 'ok' | 'unique_violation';
  signUpUserId: string;
  attributionUpdates: Array<{ id: string; set: Record<string, unknown> }>;
  deletes: Array<{ user_id: string }>;
} = {
  existingUserRows: [],
  signUpMode: 'ok',
  signUpUserId: 'usr_test_default',
  attributionUpdates: [],
  deletes: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(dbState.existingUserRows)),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        dbState.attributionUpdates.push({
          id: dbState.signUpUserId,
          set: values,
        });
        return Promise.resolve();
      }),
    })),
  }));
  const transaction = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      // Tx supports the same select / update / insert operations as the
      // top-level db client. The route only needs select+update on the
      // user row; insert is provided for completeness in case the
      // implementation grows.
      const tx = { select, update, insert: vi.fn() };
      return cb(tx);
    },
  );
  const deleteFn = vi.fn(() => ({
    where: vi.fn(() => {
      // The route calls `db.delete(user).where(eq(user.id, user_id))`
      // for orphan cleanup. We can't easily introspect the drizzle
      // where-clause object, so we record the current signUpUserId —
      // that's the user_id the route will have captured in scope.
      dbState.deletes.push({ user_id: dbState.signUpUserId });
      return Promise.resolve();
    }),
  }));
  return {
    db: { select, update, transaction, delete: deleteFn },
  };
});

// ---- partial-mock @dpg/database — keep all real exports (schemas /
// helpers @dpg/schemas pulls in), but stub ensureItemPartition so the
// route doesn't touch a real DB. ----
vi.mock('@dpg/database', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@dpg/database')>();
  return {
    ...actual,
    ensureItemPartition: vi.fn(async () => {}),
  };
});

// ---- mock the better-auth instance ----
vi.mock('@/routes/auth/create_auth', () => {
  return {
    authInstance: {
      api: {
        signUpEmail: vi.fn(async () => {
          if (dbState.signUpMode === 'unique_violation') {
            const err: Error & { code?: string } = new Error(
              'duplicate key value violates unique constraint',
            );
            err.code = '23505';
            throw err;
          }
          return { user: { id: dbState.signUpUserId } };
        }),
      },
    },
  };
});

// ---- mock the profile_item helper ----
vi.mock('@/lib/profile_item', () => ({
  create_profile_item: vi.fn(async () => ({ item_id: 'item_test_default' })),
}));

// Import the route module AFTER the mocks. This import FAILS today —
// Task 5 hasn't written `onboard_participant.ts` yet — and that's the
// whole point of the failing-test step.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { onboard_participant } from '../onboard_participant.js';

const buildApp = async (
  acting: {
    org_id?: string;
    org_type?: 'aggregator' | 'voice' | 'network_service';
  } = {},
): Promise<FastifyInstance> => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Stub the acting_org preHandler — inject the test's chosen acting_org
  // so the route's INVALID_ACTING_ORG guard sees what we want.
  app.addHook('preHandler', async (req) => {
    (req as unknown as { acting_org: unknown }).acting_org = {
      org_id: acting.org_id ?? 'org_bbmp',
      org_type: acting.org_type ?? 'aggregator',
      service_user_id: 'svc_aggregator_dpg',
    };
  });
  await app.register(onboard_participant);
  return app;
};

describe('POST /admin/onboard_participant', () => {
  beforeEach(() => {
    dbState.existingUserRows = [];
    dbState.signUpMode = 'ok';
    dbState.signUpUserId = `usr_test_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    dbState.attributionUpdates = [];
    dbState.deletes = [];
  });

  it('400 when neither email nor phone_number is provided', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when terms_accepted is false', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'A',
        terms_accepted: false,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when privacy_accepted is false', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: false,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when channel is not one of bulk|link|voice|self', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'mystery',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when phone_number does not match E.164', async () => {
    const app = await buildApp();
    for (const bad of ['9876543210', '+91-9876543210', 'phone', '++91']) {
      const res = await app.inject({
        method: 'POST',
        url: '/onboard_participant',
        payload: {
          phone_number: bad,
          name: 'A',
          terms_accepted: true,
          privacy_accepted: true,
          channel: 'bulk',
          profile: {},
        },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('403 INVALID_ACTING_ORG when caller acts as network_service', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('409 USER_ALREADY_EXISTS when email already in DB', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: 'demo@example.com', phoneNumber: null },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        email: 'demo@example.com',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('USER_ALREADY_EXISTS');
    expect(res.json().message).toContain('email');
  });

  it('409 USER_ALREADY_EXISTS when phone_number already in DB', async () => {
    dbState.existingUserRows = [
      { id: 'usr_existing', email: null, phoneNumber: '+919876543210' },
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'A',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('USER_ALREADY_EXISTS');
    expect(res.json().message).toContain('phone');
  });

  it('happy path — creates user, writes attribution, returns ids', async () => {
    dbState.signUpUserId = 'usr_anita_001';
    const app = await buildApp({ org_id: 'org_bbmp', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'Anita',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        source_id: 'bulk_upload_42',
        profile: { whoIAm: { education: 'XII' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe('usr_anita_001');
    expect(body.profile_item_id).toBe('item_test_default');
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Attribution was written
    expect(dbState.attributionUpdates).toHaveLength(1);
    expect(dbState.attributionUpdates[0].set).toMatchObject({
      onboardedByOrgId: 'org_bbmp',
      onboardedVia: 'bulk',
      onboardedSourceId: 'bulk_upload_42',
    });
  });

  it('happy path — voice channel + no source_id stores null source_id', async () => {
    dbState.signUpUserId = 'usr_voice_001';
    const app = await buildApp({
      org_id: 'org_bbmp_voice',
      org_type: 'voice',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        email: 'voice_user@example.com',
        name: 'Voice User',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'voice',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.attributionUpdates[0].set).toMatchObject({
      onboardedByOrgId: 'org_bbmp_voice',
      onboardedVia: 'voice',
      onboardedSourceId: null,
    });
  });

  it('uses network/domain/item_type from body when provided', async () => {
    const mock = await import('@/lib/profile_item');
    const spy = vi.mocked(mock.create_profile_item);
    spy.mockClear();
    const app = await buildApp({ org_id: 'org_bbmp', org_type: 'aggregator' });
    await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'Y',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        network: 'onest_yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
        profile: {},
      },
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'onest_yellow_dot',
        domain: 'student',
        item_type: 'profile_1.0',
      }),
    );
  });

  it('defaults to blue_dot/seeker/profile_1.0 when network/domain/item_type not in body', async () => {
    const mock = await import('@/lib/profile_item');
    const spy = vi.mocked(mock.create_profile_item);
    spy.mockClear();
    const app = await buildApp({ org_id: 'org_bbmp', org_type: 'aggregator' });
    await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543220',
        name: 'D',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'blue_dot',
        domain: 'seeker',
        item_type: 'profile_1.0',
      }),
    );
  });

  it('409 on PG 23505 from signUpEmail (uniqueness race)', async () => {
    dbState.signUpMode = 'unique_violation';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        email: 'race@example.com',
        name: 'Race',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('USER_ALREADY_EXISTS');
  });

  it('deletes the orphan user when the transaction throws', async () => {
    // Make create_profile_item throw an ItemServiceError-shaped error so the
    // tx rolls back. signUp succeeded on its own connection (not part of
    // the tx), so the route must compensate by deleting the orphan user.
    const profileMock = await import('@/lib/profile_item');
    vi.mocked(profileMock.create_profile_item).mockImplementationOnce(
      async () => {
        const err: Error & { statusCode?: number; errorCode?: string } =
          new Error('Domain "seeker" is not served by network "blue_dot"');
        err.statusCode = 400;
        err.errorCode = 'UNSERVED_DOMAIN';
        throw err;
      },
    );

    dbState.signUpUserId = 'usr_orphan_test';
    const app = await buildApp({ org_id: 'org_bbmp', org_type: 'aggregator' });
    const res = await app.inject({
      method: 'POST',
      url: '/onboard_participant',
      payload: {
        phone_number: '+919876543210',
        name: 'OrphanTest',
        terms_accepted: true,
        privacy_accepted: true,
        channel: 'bulk',
        profile: {},
      },
    });

    // Typed downstream error surfaced faithfully.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('UNSERVED_DOMAIN');
    // Compensation ran exactly once for the user we just signed up.
    expect(dbState.deletes.length).toBe(1);
    expect(dbState.deletes[0].user_id).toBe('usr_orphan_test');
  });
});
