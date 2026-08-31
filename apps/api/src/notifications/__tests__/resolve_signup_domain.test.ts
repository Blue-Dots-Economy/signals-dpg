import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared queue: each db.select() chain resolves to the next queued rows,
// and `throwNext` makes the chain reject to exercise the best-effort catch.
const { rowQueue, state } = vi.hoisted(() => ({
  rowQueue: [] as unknown[][],
  state: { throwNext: false },
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() =>
            state.throwNext
              ? Promise.reject(new Error('db down'))
              : Promise.resolve(rowQueue.shift() ?? []),
          ),
        })),
      })),
    })),
  },
}));

vi.mock('@api/db/postgres/schema/auth', () => ({
  user: { id: 'user.id', domains: 'user.domains' },
}));

const { resolveSignupDomain } = await import('../resolve_signup_domain.js');

beforeEach(() => {
  rowQueue.length = 0;
  state.throwNext = false;
});

describe('resolveSignupDomain', () => {
  it('returns the first domain on the user row', async () => {
    rowQueue.push([{ domains: ['provider'] }]);
    expect(await resolveSignupDomain('u1')).toBe('provider');
  });

  it('returns null when the domains array is empty', async () => {
    rowQueue.push([{ domains: [] }]);
    expect(await resolveSignupDomain('u1')).toBeNull();
  });

  it('returns null when no user row is found', async () => {
    rowQueue.push([]);
    expect(await resolveSignupDomain('u1')).toBeNull();
  });

  it('returns null (never throws) on a DB error', async () => {
    state.throwNext = true;
    await expect(resolveSignupDomain('u1')).resolves.toBeNull();
  });
});
