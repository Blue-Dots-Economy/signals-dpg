import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The single `user`-insert both identity paths share. What matters here is that
 * the row shape does not drift (the two callers previously produced it two
 * different ways), that the id invariant is enforced, and that a concurrent
 * create is told apart from a genuine identifier clash.
 */

const dbState = {
  inserted: [] as Array<{ via: string; values: Record<string, unknown> }>,
  insertError: null as unknown,
  selectRows: [] as unknown[],
};

function makeExecutor(via: string) {
  return {
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (dbState.insertError) throw dbState.insertError;
        dbState.inserted.push({ via, values });
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbState.selectRows,
        }),
      }),
    }),
  };
}

vi.mock('@api/db/postgres/drizzle_config', () => ({ db: makeExecutor('db') }));

const { insertLocalUser } = await import('../user_writer.js');
type Executor = Parameters<typeof insertLocalUser>[2];

/**
 * Drizzle's real `insert`/`select` return deep builder types no hand-rolled
 * double can satisfy, so the fake is cast at the boundary. The production type
 * stays strict — a real transaction handle does satisfy it.
 */
const asExecutor = (e: ReturnType<typeof makeExecutor>) => e as unknown as Executor;

const ID = '11111111-2222-3333-4444-555555555555';

const makeLog = () =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as FastifyBaseLogger;

const baseInput = {
  id: ID,
  name: 'Asha',
  email: 'asha@example.org',
  emailVerified: false,
  phoneNumber: '+911234567890',
  phoneNumberVerified: false,
};

beforeEach(() => {
  dbState.inserted = [];
  dbState.insertError = null;
  dbState.selectRows = [];
});

describe('row shape', () => {
  it('applies the defaults both callers previously produced independently', async () => {
    const result = await insertLocalUser(baseInput, makeLog());

    expect(result.ok).toBe(true);
    const [{ values }] = dbState.inserted;
    expect(values.id).toBe(ID);
    expect(values.role).toBe('user');
    // Empty strings, not null — this is what both live paths actually wrote.
    expect(values.image).toBe('');
    expect(values.banReason).toBe('');
    expect(values.banned).toBe(false);
    expect(values.banExpires).toBeNull();
    expect(values.createdAt).toBeInstanceOf(Date);
    // One timestamp for both columns, so a row never looks pre-modified.
    expect(values.updatedAt).toEqual(values.createdAt);
  });

  it('leaves tags to the database default', async () => {
    await insertLocalUser(baseInput, makeLog());

    expect(dbState.inserted[0].values.tags).toBeUndefined();
  });

  it('does NOT default the consent booleans', async () => {
    // The two callers disagree and both are right: first-login provisioning sets
    // them true (the consent screens were passed), admin onboarding leaves them
    // alone because consent lives in the ledger (#309). Defaulting either way
    // would silently change one of them.
    await insertLocalUser(baseInput, makeLog());

    const [{ values }] = dbState.inserted;
    expect(values.termsAccepted).toBeUndefined();
    expect(values.privacyAccepted).toBeUndefined();
  });

  it('writes a null email rather than synthesising one', async () => {
    // The whole point of dropping signUpEmail: a phone-only participant should
    // have no email, not a <uuid>@no-email.local address.
    await insertLocalUser({ ...baseInput, email: null }, makeLog());

    expect(dbState.inserted[0].values.email).toBeNull();
  });

  it('lets extra columns through, and lets them win over a default', async () => {
    await insertLocalUser(
      { ...baseInput, extra: { termsAccepted: true, role: 'admin', age: 30 } },
      makeLog()
    );

    const [{ values }] = dbState.inserted;
    expect(values.termsAccepted).toBe(true);
    expect(values.age).toBe(30);
    expect(values.role).toBe('admin');
  });
});

describe('the id invariant', () => {
  it.each([
    ['a prefixed service-account id', `usr_${ID}`],
    ['a non-UUID string', 'not-a-uuid'],
    ['an empty id', ''],
  ])('refuses %s', async (_label, id) => {
    const log = makeLog();

    const result = await insertLocalUser({ ...baseInput, id }, log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USER_WRITE_FAILED');
    // Nothing written — a row whose id cannot be a Keycloak subject would be a
    // user who can never log in.
    expect(dbState.inserted).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });

  it('accepts an uppercase UUID', async () => {
    const result = await insertLocalUser({ ...baseInput, id: ID.toUpperCase() }, makeLog());

    expect(result.ok).toBe(true);
  });
});

describe('concurrent create vs identifier clash', () => {
  const unique = Object.assign(new Error('duplicate key value'), { code: '23505' });

  it('reports created:false and returns the winning row', async () => {
    dbState.insertError = unique;
    dbState.selectRows = [{ id: ID, name: 'Asha', email: 'asha@example.org', role: 'user' }];
    const log = makeLog();

    const result = await insertLocalUser(baseInput, log);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    if (result.created) return;
    // Returned so the caller can answer from it without a second read.
    expect(result.existing.id).toBe(ID);
    expect(log.warn).toHaveBeenCalled();
  });

  it('reports IDENTITY_CONFLICT when no row exists under that id', async () => {
    // The violation was on email/phone, so a DIFFERENT row holds them. Merging
    // or re-keying would repoint domain data.
    dbState.insertError = unique;
    dbState.selectRows = [];

    const result = await insertLocalUser(baseInput, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('IDENTITY_CONFLICT');
  });

  it('recognises the pg code nested under cause', async () => {
    dbState.insertError = { message: 'wrapped', cause: { code: '23505' } };
    dbState.selectRows = [{ id: ID, name: 'Asha', email: null, role: 'user' }];

    const result = await insertLocalUser(baseInput, makeLog());

    expect(result.ok).toBe(true);
  });

  it('reports any other failure as USER_WRITE_FAILED', async () => {
    dbState.insertError = new Error('connection reset');
    const log = makeLog();

    const result = await insertLocalUser(baseInput, log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USER_WRITE_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('transaction seam', () => {
  it('inserts through a supplied executor rather than the shared db', async () => {
    // Admin onboarding needs the insert to roll back with the profile-item
    // creation beside it, so it hands in its transaction handle.
    const tx = makeExecutor('tx');

    await insertLocalUser(baseInput, makeLog(), asExecutor(tx));

    expect(dbState.inserted).toHaveLength(1);
    expect(dbState.inserted[0].via).toBe('tx');
  });

  it('re-reads through the same executor on a race', async () => {
    const tx = makeExecutor('tx');
    dbState.insertError = Object.assign(new Error('dup'), { code: '23505' });
    dbState.selectRows = [{ id: ID, name: 'Asha', email: null, role: 'user' }];

    const result = await insertLocalUser(baseInput, makeLog(), asExecutor(tx));

    expect(result.ok).toBe(true);
  });

  it('defaults to the shared db when no executor is given', async () => {
    await insertLocalUser(baseInput, makeLog());

    expect(dbState.inserted[0].via).toBe('db');
  });
});
