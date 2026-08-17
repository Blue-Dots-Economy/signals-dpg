import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * POST /api/v1/admin/participant — WRITE-FAILURE paths.
 *
 * `participant.test.ts` covers the happy dispatch matrix (6 verdicts) and
 * `participant_group.test.ts` covers participant_read / participant_decrypt.
 * This file targets the branches neither exercises:
 *
 *  - signUpAndOnboardUser: signUpEmail 23505 (direct + `cause.code`) → 409,
 *    generic signUp failure → 500, updateExecutor failure → orphan cleanup
 *    (incl. cleanup-of-cleanup failure), typed-service-error propagation, and
 *    unique-constraint-by-message → 409.
 *  - ensureItemPartition failure → 500 PARTITION_SETUP_FAILED (both branches).
 *  - update_item / insert_item catch blocks: curated message only when an
 *    errorCode is present (no raw SQL/PII leak), warn-vs-error logger choice.
 *  - The age gates: minor age taken from the user ON FILE, AGE_REQUIRED on a
 *    guardian-gated domain, and network-config load failure → not gated.
 *  - account_only existing user with age only → age persisted + drafts promoted.
 *  - readItemsForUser's no-served-networks fallback filter.
 *
 * The handler is invoked directly (it is a named export) with a fake
 * request/reply, so no fastify/Zod layer is involved.
 */

const { state } = vi.hoisted(() => ({
  state: {
    servedDomains: [{ network: 'blue_dot', domain: 'seeker' }] as Array<{
      network: string;
      domain: string;
    }>,
    userRows: [] as Array<{
      id: string;
      email: string | null;
      phoneNumber: string | null;
      onboardedByOrgId: string | null;
      age: number | null;
    }>,
    itemsRows: [] as Array<Record<string, unknown>>,
    itemOwner: null as string | null,
    /** Captured where-expression from the readItemsForUser select. */
    itemsWhere: null as unknown,
    signUpFail: null as unknown,
    signUpUserId: 'usr_new_1',
    partitionFail: null as unknown,
    profileItemFail: null as unknown,
    updateItemFail: null as unknown,
    consentFail: null as unknown,
    /** Thrown after the transaction callback resolves (commit failure). */
    txCommitFail: null as unknown,
    deleteFail: null as unknown,
    deletes: 0,
    updates: [] as Array<Record<string, unknown>>,
    txCalls: 0,
    consentRecorded: 0,
    gated: false,
    networkConfigFail: null as unknown,
  },
}));

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    get served_domains() {
      return state.servedDomains;
    },
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {},
  databases: {},
  matchScore: {},
  notification: {},
  networkRuntime: {},
  schemaRegistry: {},
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
  auth_middleware: async () => {},
}));

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: {
      signUpEmail: vi.fn(async (_args: unknown) => {
        if (state.signUpFail) throw state.signUpFail;
        return { user: { id: state.signUpUserId } };
      }),
    },
  },
}));

vi.mock('@dpg/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/database')>();
  return {
    ...actual,
    ensureItemPartition: vi.fn(async (..._a: unknown[]) => {
      if (state.partitionFail) throw state.partitionFail;
    }),
  };
});

vi.mock('@api/db/postgres/drizzle_config', () => {
  const classify = (proj: Record<string, unknown>) => {
    const keys = Object.keys(proj);
    if (keys.includes('onboardedByOrgId')) return 'user';
    // The ownership pre-flight now also reads the item's key columns (#557).
    if (keys.includes('created_by') && !keys.includes('item_state')) return 'item_owner';
    return 'items_list';
  };

  const select = vi.fn((proj: Record<string, unknown>) => {
    const mode = classify(proj);
    return {
      from: vi.fn((_t: unknown) => ({
        where: vi.fn((whereArg: unknown) => {
          if (mode === 'items_list') state.itemsWhere = whereArg;
          return {
            limit: vi.fn((_n: number) => {
              if (mode === 'user') return Promise.resolve(state.userRows);
              if (mode === 'item_owner') {
                return Promise.resolve(
                  state.itemOwner
                    ? [
                        {
                          created_by: state.itemOwner,
                          item_network: 'blue_dot',
                          item_domain: 'seeker',
                          item_type: 'profile_1.0',
                        },
                      ]
                    : [],
                );
              }
              return Promise.resolve([]);
            }),
            orderBy: vi.fn((_c: unknown) =>
              Promise.resolve(mode === 'items_list' ? state.itemsRows : []),
            ),
          };
        }),
      })),
    };
  });

  const update = vi.fn((_t: unknown) => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn((_w: unknown) => {
        state.updates.push(values);
        return Promise.resolve();
      }),
    })),
  }));

  const deleteFn = vi.fn((_t: unknown) => ({
    where: vi.fn((_w: unknown) => {
      if (state.deleteFail) return Promise.reject(state.deleteFail);
      state.deletes += 1;
      return Promise.resolve();
    }),
  }));

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
    state.txCalls += 1;
    const result = await cb({ select, update, insert: vi.fn() });
    if (state.txCommitFail) throw state.txCommitFail;
    return result;
  });

  return { db: { select, update, delete: deleteFn, transaction } };
});

vi.mock('@/lib/profile_item', () => ({
  create_profile_item: vi.fn(async (_input: Record<string, unknown>) => {
    if (state.profileItemFail) throw state.profileItemFail;
    return { item_id: 'itm_created_1' };
  }),
}));

vi.mock('@/services/item_service', () => ({
  updateItemInternal: vi.fn(async (..._a: unknown[]) => {
    if (state.updateItemFail) throw state.updateItemFail;
    return {
      row: {
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_id: 'itm_existing_1',
      },
    };
  }),
}));

vi.mock('@/services/participant_consent', () => ({
  recordParticipantConsent: vi.fn(async (..._a: unknown[]) => {
    if (state.consentFail) throw state.consentFail;
    return { recorded: state.consentRecorded, promoted: false };
  }),
  // Returns the keys of the drafts it promoted (#557) — the route publishes one
  // item event per key, so this must be an array, not void.
  promoteEligibleDraftsForUser: vi.fn(
    async (_tx: unknown, _userId: string) => [] as Array<Record<string, string>>,
  ),
}));

vi.mock('@/utils/publish_item_event', () => {
  const publishItemEvent = vi.fn(async (..._a: unknown[]) => {});
  return {
    publishItemEvent,
    // Real fan-out + de-dupe over the mocked single publish, so assertions on
    // publishItemEvent still see exactly the events the route emitted.
    publishItemEvents: vi.fn(
      async (keys: Array<Record<string, string>>, op: string, logger?: unknown) => {
        const seen = new Set<string>();
        for (const k of keys) {
          const id = `${k.item_network}/${k.item_domain}/${k.item_type}/${k.item_id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          await publishItemEvent({ ...k, op }, logger);
        }
      },
    ),
  };
});

vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: vi.fn(
    (input: { item_state: Record<string, unknown> }) => ({
      mergedState: input.item_state,
    }),
  ),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async (_id: string) => {
    if (state.networkConfigFail) throw state.networkConfigFail;
    return { id: 'blue_dot' };
  }),
}));

vi.mock('@/services/minor', () => ({
  isMinor: (age: number) => age < 18,
  guardianConsentRequired: (..._a: unknown[]) => state.gated,
}));

// Imported after the mocks.
import { participant_handler } from '../participant.js';
import { ensureItemPartition } from '@dpg/database';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal } from '@/services/item_service';
import {
  recordParticipantConsent,
  promoteEligibleDraftsForUser,
} from '@/services/participant_consent';
import { publishItemEvent } from '@/utils/publish_item_event';

type HandlerRequest = Parameters<typeof participant_handler>[0];
type HandlerReply = Parameters<typeof participant_handler>[1];

type FakeReply = {
  code: (c: number) => FakeReply;
  send: (b: Record<string, unknown>) => FakeReply;
};

const log = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: vi.fn((..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: vi.fn((..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: vi.fn((..._a: any[]) => {}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: vi.fn((..._a: any[]) => {}),
};

const run = async (opts: {
  body: Record<string, unknown>;
  acting?: { org_id: string; org_type: string } | null;
}) => {
  const captured: { statusCode: number; body: Record<string, unknown> } = {
    statusCode: 0,
    body: {},
  };
  const reply: FakeReply = {
    code: (c: number) => {
      captured.statusCode = c;
      return reply;
    },
    send: (b: Record<string, unknown>) => {
      captured.body = b;
      return reply;
    },
  };
  const request = {
    body: { channel: 'bulk', name: 'Demo', ...opts.body },
    acting_org:
      opts.acting === null
        ? undefined
        : (opts.acting ?? { org_id: 'org_agg_1', org_type: 'aggregator' }),
    log,
  } as unknown as HandlerRequest;

  await participant_handler(request, reply as unknown as HandlerReply);
  return captured;
};

const EXISTING_USER = {
  id: 'usr_existing_1',
  email: 'demo@example.com',
  phoneNumber: null,
  onboardedByOrgId: 'org_agg_1',
  age: null as number | null,
};

const itemRow = (over: Record<string, unknown> = {}) => ({
  item_id: 'itm_existing_1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  lifecycle_status: 'live',
  item_state: { whoIAm: { education: 'XII' } },
  item_locations: [],
  item_private_state: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
  ...over,
});

class FakeServiceError extends Error {
  statusCode: number;
  errorCode: string;
  constructor(statusCode: number, errorCode: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

/** Walk a drizzle SQL expression tree collecting referenced column names. */
const columnNames = (node: unknown, out = new Set<string>()): Set<string> => {
  if (!node || typeof node !== 'object') return out;
  const n = node as { name?: unknown; queryChunks?: unknown[] };
  if (typeof n.name === 'string') out.add(n.name);
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) columnNames(chunk, out);
  }
  return out;
};

describe('POST /admin/participant — write/failure paths', () => {
  beforeEach(() => {
    state.servedDomains = [{ network: 'blue_dot', domain: 'seeker' }];
    state.userRows = [];
    state.itemsRows = [];
    state.itemOwner = null;
    state.itemsWhere = null;
    state.signUpFail = null;
    state.signUpUserId = 'usr_new_1';
    state.partitionFail = null;
    state.profileItemFail = null;
    state.updateItemFail = null;
    state.consentFail = null;
    state.txCommitFail = null;
    state.deleteFail = null;
    state.deletes = 0;
    state.updates = [];
    state.txCalls = 0;
    state.consentRecorded = 0;
    state.gated = false;
    state.networkConfigFail = null;
    log.warn.mockClear();
    log.error.mockClear();
    vi.mocked(ensureItemPartition).mockClear();
    vi.mocked(authInstance.api.signUpEmail).mockClear();
    vi.mocked(create_profile_item).mockClear();
    vi.mocked(updateItemInternal).mockClear();
    vi.mocked(recordParticipantConsent).mockClear();
    vi.mocked(promoteEligibleDraftsForUser).mockClear();
    vi.mocked(publishItemEvent).mockClear();
  });

  // --- signUpAndOnboardUser: signUpEmail failures -------------------------

  it('create_new_user: signUpEmail rejecting with pg 23505 → 409 USER_ALREADY_EXISTS with a retry hint', async () => {
    const err: Error & { code?: string } = new Error('insert blew up');
    err.code = '23505';
    state.signUpFail = err;

    const res = await run({ body: { email: 'a@b.com', item_state: { x: 1 } } });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('USER_ALREADY_EXISTS');
    expect(res.body.message).toContain('retry the request');
    // Nothing was written and no orphan cleanup was needed.
    expect(state.txCalls).toBe(0);
    expect(state.deletes).toBe(0);
  });

  it('create_new_user: signUpEmail rejecting with cause.code 23505 → 409 (nested pg code is read)', async () => {
    state.signUpFail = Object.assign(new Error('wrapped'), {
      cause: { code: '23505' },
    });

    const res = await run({
      body: { phone_number: '+919876543210', item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('USER_ALREADY_EXISTS');
    expect(log.warn).toHaveBeenCalled();
  });

  it('create_new_user: generic signUpEmail failure → 500 ONBOARD_FAILED, no orphan cleanup attempted', async () => {
    state.signUpFail = new Error('auth service unreachable');

    const res = await run({ body: { email: 'a@b.com', item_state: { x: 1 } } });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
    expect(state.deletes).toBe(0);
    expect(log.error).toHaveBeenCalled();
  });

  // --- signUpAndOnboardUser: updateExecutor failures ----------------------

  it('create_new_user: typed service error from create_profile_item is propagated verbatim and the orphan user is deleted', async () => {
    state.profileItemFail = new FakeServiceError(
      409,
      'PROFILE_LIMIT_REACHED',
      'maximum profiles per user reached',
    );

    const res = await run({ body: { email: 'a@b.com', item_state: { x: 1 } } });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'PROFILE_LIMIT_REACHED',
      message: 'maximum profiles per user reached',
    });
    // Orphan cleanup ran for the just-created user.
    expect(state.deletes).toBe(1);
    expect(vi.mocked(publishItemEvent)).not.toHaveBeenCalled();
  });

  it('create_new_user: commit failing with a unique-constraint message → 409 USER_ALREADY_EXISTS (no retry hint) + orphan cleanup', async () => {
    state.txCommitFail = new Error(
      'duplicate key value violates unique constraint "user_phone_number_unique"',
    );

    const res = await run({
      body: { email: 'a@b.com', phone_number: '+919876543210', item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'USER_ALREADY_EXISTS',
      message: 'email or phone already in use (race)',
    });
    expect(state.deletes).toBe(1);
  });

  it('create_new_user: transaction failure AND failing orphan cleanup → still 500 ONBOARD_FAILED, cleanup failure logged', async () => {
    state.txCommitFail = new Error('deadlock detected');
    state.deleteFail = new Error('connection terminated');

    const res = await run({ body: { email: 'a@b.com', item_state: { x: 1 } } });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('ONBOARD_FAILED');
    expect(state.deletes).toBe(0);
    // Both the cleanup failure and the onboard failure are logged at error.
    const messages = log.error.mock.calls.map((c) => c[1]);
    expect(messages).toContain(
      'failed to clean up orphan user — manual cleanup needed',
    );
    expect(messages).toContain('participant onboard failed');
  });

  it('account_only new user: consent write failing inside the transaction → 500 ONBOARD_FAILED and the orphan user is cleaned up', async () => {
    state.consentFail = new Error('consent ledger write failed');

    const res = await run({
      body: {
        email: 'a@b.com',
        compliance: [{ key: 'profile_terms', value: true }],
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('ONBOARD_FAILED');
    expect(state.deletes).toBe(1);
    // No item is ever created on the account_only path.
    expect(vi.mocked(create_profile_item)).not.toHaveBeenCalled();
  });

  // --- partition setup ----------------------------------------------------

  it('create_new_user: ensureItemPartition failing → 500 PARTITION_SETUP_FAILED before any signUp', async () => {
    state.partitionFail = new Error('cannot create partition');

    const res = await run({ body: { email: 'a@b.com', item_state: { x: 1 } } });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'PARTITION_SETUP_FAILED',
      message: 'failed to prepare storage for item type',
    });
    expect(vi.mocked(authInstance.api.signUpEmail)).not.toHaveBeenCalled();
  });

  it('insert_item: ensureItemPartition failing → 500 PARTITION_SETUP_FAILED and no transaction opened', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.partitionFail = new Error('cannot create partition');

    const res = await run({
      body: { email: EXISTING_USER.email, item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('PARTITION_SETUP_FAILED');
    expect(state.txCalls).toBe(0);
    expect(vi.mocked(create_profile_item)).not.toHaveBeenCalled();
  });

  // --- insert_item catch --------------------------------------------------

  it('insert_item: typed 4xx service error surfaces its status/code/message and logs at warn', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.profileItemFail = new FakeServiceError(
      422,
      'ITEM_VALIDATION_FAILED',
      'item_state failed schema validation',
    );

    const res = await run({
      body: { email: EXISTING_USER.email, item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      error: 'ITEM_VALIDATION_FAILED',
      message: 'item_state failed schema validation',
    });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(publishItemEvent)).not.toHaveBeenCalled();
  });

  it('insert_item: raw DB error → 500 INSERT_ITEM_FAILED with a curated message (no SQL/PII leak) logged at error', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.profileItemFail = new Error(
      'insert into items ... failed — params: ["Demo","+919876543210"]',
    );

    const res = await run({
      body: { email: EXISTING_USER.email, item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'INSERT_ITEM_FAILED',
      message: 'item insert failed',
    });
    expect(String(res.body.message)).not.toContain('919876543210');
    expect(log.error).toHaveBeenCalled();
  });

  // --- update_item catch --------------------------------------------------

  it('update_item: typed 4xx service error surfaces the curated message and logs at warn', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.itemOwner = EXISTING_USER.id;
    state.updateItemFail = new FakeServiceError(
      404,
      'ITEM_NOT_FOUND_OR_FORBIDDEN',
      'Item not found or does not belong to the authenticated user',
    );

    const res = await run({
      body: {
        email: EXISTING_USER.email,
        item_id: 'itm_existing_1',
        item_state: { x: 1 },
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
      message: 'Item not found or does not belong to the authenticated user',
    });
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('update_item: raw DB error → 500 UPDATE_FAILED with a curated message logged at error', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.itemOwner = EXISTING_USER.id;
    state.updateItemFail = new Error(
      'update items set item_state=$1 — params: ["secret@example.com"]',
    );

    const res = await run({
      body: {
        email: EXISTING_USER.email,
        item_id: 'itm_existing_1',
        item_state: { x: 1 },
      },
    });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'UPDATE_FAILED',
      message: 'item update failed',
    });
    expect(String(res.body.message)).not.toContain('secret@example.com');
    expect(log.error).toHaveBeenCalled();
    expect(vi.mocked(publishItemEvent)).not.toHaveBeenCalled();
  });

  // --- age gates ----------------------------------------------------------

  it('minor age already ON FILE (no age in body) → 400 U18_NOT_ALLOWED and no write at all', async () => {
    state.userRows = [{ ...EXISTING_USER, age: 15 }];

    const res = await run({
      body: { email: EXISTING_USER.email, item_state: { x: 1 } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('U18_NOT_ALLOWED');
    expect(state.txCalls).toBe(0);
    expect(vi.mocked(create_profile_item)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureItemPartition)).not.toHaveBeenCalled();
  });

  it('user_terms+user_privacy with no age anywhere on a guardian-gated domain → 400 AGE_REQUIRED before onboarding', async () => {
    state.gated = true;

    const res = await run({
      body: {
        email: 'a@b.com',
        item_state: { x: 1 },
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'AGE_REQUIRED',
      message: 'age is required with consent on this domain',
    });
    expect(vi.mocked(authInstance.api.signUpEmail)).not.toHaveBeenCalled();
  });

  it('network-config load failure during the age gate → treated as NOT gated, the request proceeds', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.networkConfigFail = new Error('config fetch failed');
    state.consentRecorded = 2;

    const res = await run({
      body: {
        email: EXISTING_USER.email,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.consent_recorded).toBe(2);
    expect(vi.mocked(recordParticipantConsent)).toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => c[1])).toContain(
      'network config load failed during age gate check',
    );
  });

  it('adult age already on file satisfies the gate — a returning user re-sending the consent pair is not rejected', async () => {
    state.userRows = [{ ...EXISTING_USER, age: 30 }];
    state.gated = true;

    const res = await run({
      body: {
        email: EXISTING_USER.email,
        compliance: [
          { key: 'user_terms', value: true },
          { key: 'user_privacy', value: true },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.user_existed).toBe(true);
  });

  // --- account_only existing user, age-only write -------------------------

  // The handler's own identifier guard. Unreachable over HTTP (the Zod schema
  // refine rejects the body first), so it can only be exercised by invoking the
  // handler directly as this suite does — it exists as defence in depth for
  // non-HTTP callers.
  it('defensive guard: neither email nor phone_number → 400 MISSING_IDENTIFIER, no lookup', async () => {
    const res = await run({ body: { email: undefined, phone_number: undefined } });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('MISSING_IDENTIFIER');
    expect(state.txCalls).toBe(0);
  });

  it('account_only existing user with age only (no compliance) → age persisted, drafts promoted, no consent write', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.itemsRows = [itemRow()];

    const res = await run({ body: { email: EXISTING_USER.email, age: 24 } });

    expect(res.statusCode).toBe(200);
    expect(state.txCalls).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].age).toBe(24);
    expect(vi.mocked(promoteEligibleDraftsForUser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordParticipantConsent)).not.toHaveBeenCalled();
    expect(res.body.items).toHaveLength(1);
  });

  it('account_only existing user age update failing → 500 CONSENT_WRITE_FAILED without leaking the raw error', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.txCommitFail = new Error(
      'update "user" set age=$1 — params: ["+919876543210"]',
    );

    const res = await run({ body: { email: EXISTING_USER.email, age: 24 } });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'CONSENT_WRITE_FAILED',
      message: 'failed to record consent',
    });
    expect(String(res.body.message)).not.toContain('919876543210');
  });

  // --- readItemsForUser network scoping -----------------------------------

  it('readItemsForUser filters on item_network when domains are served, and falls back to created_by only when none are', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.itemsRows = [itemRow()];

    const scoped = await run({ body: { email: EXISTING_USER.email } });
    expect(scoped.statusCode).toBe(200);
    const scopedCols = columnNames(state.itemsWhere);
    expect(scopedCols.has('created_by')).toBe(true);
    expect(scopedCols.has('item_network')).toBe(true);

    state.itemsWhere = null;
    state.servedDomains = [];

    const unscoped = await run({ body: { email: EXISTING_USER.email } });
    expect(unscoped.statusCode).toBe(200);
    expect(unscoped.body.items).toHaveLength(1);
    const unscopedCols = columnNames(state.itemsWhere);
    expect(unscopedCols.has('created_by')).toBe(true);
    expect(unscopedCols.has('item_network')).toBe(false);
  });

  it('serialises item timestamps to ISO strings and never returns item_private_state', async () => {
    state.userRows = [{ ...EXISTING_USER }];
    state.itemsRows = [itemRow({ item_private_state: 'enc:blob' })];

    const res = await run({ body: { email: EXISTING_USER.email } });

    const items = res.body.items as Array<Record<string, unknown>>;
    expect(items[0].created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(items[0].updated_at).toBe('2026-01-02T00:00:00.000Z');
    expect(items[0]).not.toHaveProperty('item_private_state');
  });
});
