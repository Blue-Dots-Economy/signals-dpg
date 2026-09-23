import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit tests for the native api-key verifier that replaced better-auth's
 * `verifyApiKey` (#517).
 *
 * `auth_middleware.test.ts` mocks this module, so without this file the actual
 * auth decision — the hash, the `enabled` filter, expiry and `remaining` — has
 * no direct coverage at all. It is the most security-sensitive code in the
 * change: it is what stands between an arbitrary `x-api-key` header and a
 * service identity.
 *
 * The db is injected rather than module-mocked wherever possible: `verifyApiKey`
 * takes an `executor` for exactly this reason, so most cases here exercise the
 * real query-building path.
 */

// Column stubs so the `where` conditions are inspectable by identity.
vi.mock('@api/db/postgres/schema/auth', () => ({
  apikey: {
    key: 'apikey.key',
    enabled: 'apikey.enabled',
    userId: 'apikey.user_id',
    referenceId: 'apikey.reference_id',
    remaining: 'apikey.remaining',
    expiresAt: 'apikey.expires_at',
  },
}));

// The module imports `db` at load purely as the executor default; importing the
// real one would open a Postgres connection in a unit test.
vi.mock('@api/db/postgres/drizzle_config', () => ({ db: {} }));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conds: unknown[]) => ({ op: 'and', conds }),
}));

import { verifyApiKey, hashApiKey } from '../verify_api_key';

// ---------------------------------------------------------------------------

/** Captures what the verifier asked the db for, and replays a canned row. */
function fakeExecutor(rows: unknown[]) {
  const seen: { where?: unknown; limit?: number; projection?: unknown } = {};
  const executor = {
    select: (projection: unknown) => {
      seen.projection = projection;
      return {
        from: () => ({
          where: (cond: unknown) => {
            seen.where = cond;
            return {
              limit: (n: number) => {
                seen.limit = n;
                return Promise.resolve(rows);
              },
            };
          },
        }),
      };
    },
  };
  return { executor: executor as never, seen };
}

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);

describe('hashApiKey', () => {
  /**
   * A GOLDEN value, not a re-derivation. It was produced independently by
   * Postgres — the same expression `provision_service_users.sql` uses to seed a
   * key:
   *
   *   translate(encode(digest('sk_signals_issue517_golden','sha256'),'base64'),
   *             '+/=', '-_')
   *
   * Three implementations must agree on this hash or service auth breaks across
   * repos: this file, that SQL, and signals-search's own verifier (#516). If
   * this assertion ever fails, the contract has been broken — do not "fix" it by
   * updating the constant.
   */
  it('matches the hash Postgres produces for the same key', () => {
    expect(hashApiKey('sk_signals_issue517_golden')).toBe(
      '8kyX-6JzBOGZBg1stcReKmTKCAwcZWz0xmK4uON9dX8'
    );
  });

  it('is base64url and unpadded — the two properties better-auth relied on', () => {
    const h = hashApiKey('any-key');
    // 32 bytes -> 43 base64url chars once the '=' padding is dropped.
    expect(h).toHaveLength(43);
    expect(h).not.toContain('=');
    expect(h).not.toMatch(/[+/]/);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic and input-sensitive', () => {
    expect(hashApiKey('k')).toBe(hashApiKey('k'));
    expect(hashApiKey('k')).not.toBe(hashApiKey('k '));
  });
});

describe('verifyApiKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('looks the key up by HASH, never by the raw key', async () => {
    const { executor, seen } = fakeExecutor([]);
    await verifyApiKey('sk_signals_issue517_golden', executor);

    const conds = (seen.where as { conds: Array<{ val: unknown; col: unknown }> }).conds;
    const keyCond = conds.find((c) => c.col === 'apikey.key');
    expect(keyCond?.val).toBe('8kyX-6JzBOGZBg1stcReKmTKCAwcZWz0xmK4uON9dX8');
    // The raw key must never reach the query.
    expect(JSON.stringify(seen.where)).not.toContain('sk_signals_issue517_golden');
  });

  it('filters `enabled` in SQL, so a disabled key is indistinguishable from an unknown one', async () => {
    const { executor, seen } = fakeExecutor([]);
    await verifyApiKey('k', executor);

    const conds = (seen.where as { conds: Array<{ col: unknown; val: unknown }> }).conds;
    expect(conds).toContainEqual({ op: 'eq', col: 'apikey.enabled', val: true });
    expect(seen.limit).toBe(1);
  });

  it('resolves a valid key to its owner id', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: 'ref1', remaining: null, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({
      valid: true,
      userId: 'u1',
    });
  });

  it('falls back to referenceId when userId is null', async () => {
    const { executor } = fakeExecutor([
      { userId: null, referenceId: 'ref-9', remaining: null, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({
      valid: true,
      userId: 'ref-9',
    });
  });

  it('is valid with a null owner when neither id is set', async () => {
    const { executor } = fakeExecutor([
      { userId: null, referenceId: null, remaining: null, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({
      valid: true,
      userId: null,
    });
  });

  it('rejects an unknown key', async () => {
    const { executor } = fakeExecutor([]);
    await expect(verifyApiKey('nope', executor)).resolves.toEqual({ valid: false });
  });

  // ── expiry ──────────────────────────────────────────────────────────────
  // NULL means "never expires", which is the shape every seeded service key has
  // (provision_service_users.sql sets no expires_at).

  it('accepts a key with no expiry', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: null, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toMatchObject({ valid: true });
  });

  it('accepts a key whose expiry is in the future', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: null, expiresAt: future() },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toMatchObject({ valid: true });
  });

  it('rejects an expired key', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: null, expiresAt: past() },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({ valid: false });
  });

  // ── remaining ───────────────────────────────────────────────────────────
  // Read, never written — the same stance signals-search takes, so two writers
  // never race on a counter neither owns.

  it('treats a null `remaining` as unlimited', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: null, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toMatchObject({ valid: true });
  });

  it('accepts a key with quota left', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: 1, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toMatchObject({ valid: true });
  });

  it('rejects an exhausted quota', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: 0, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({ valid: false });
  });

  it('rejects a negative quota', async () => {
    const { executor } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: -1, expiresAt: null },
    ]);
    await expect(verifyApiKey('k', executor)).resolves.toEqual({ valid: false });
  });

  it('does not decrement `remaining` — it issues no write at all', async () => {
    const { executor, seen } = fakeExecutor([
      { userId: 'u1', referenceId: null, remaining: 5, expiresAt: null },
    ]);
    // A write would need `update`/`insert`, which the injected executor does not
    // expose — reaching for one would throw rather than silently pass.
    await expect(verifyApiKey('k', executor)).resolves.toMatchObject({ valid: true });
    expect(seen.projection).toBeDefined();
  });

  it('propagates a db failure rather than returning invalid', async () => {
    // Failing closed as `{ valid: false }` would turn a database outage into a
    // fleet-wide 403 that looks like every partner rotating a bad key at once.
    const executor = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error('db down')) }),
        }),
      }),
    } as never;
    await expect(verifyApiKey('k', executor)).rejects.toThrow('db down');
  });
});
