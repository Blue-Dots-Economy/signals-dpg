import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// One shared queue: each `db.select()` chain resolves to the next queued rows,
// which keeps the drizzle builder chain (select→from→where→limit) simple to fake.
const { rowQueue } = vi.hoisted(() => ({ rowQueue: [] as unknown[][] }));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rowQueue.shift() ?? [])),
        })),
      })),
    })),
  },
}));

vi.mock('@api/db/postgres/schema/auth', () => ({
  user: { id: 'user.id', email: 'user.email' },
}));

vi.mock('@dpg/database', () => ({
  items: {
    item_state: 'items.item_state',
    item_network: 'items.item_network',
    item_id: 'items.item_id',
  },
}));

import { resolveOwnerEmail, resolveProviderServiceName } from '../resolve_owner';

describe('resolveOwnerEmail', () => {
  beforeEach(() => {
    rowQueue.length = 0;
  });

  it('returns the email for a known user', async () => {
    rowQueue.push([{ email: 'a@b.com' }]);

    await expect(resolveOwnerEmail('u1')).resolves.toBe('a@b.com');
  });

  it('returns null for an unknown user (no rows)', async () => {
    rowQueue.push([]);

    await expect(resolveOwnerEmail('nope')).resolves.toBeNull();
  });

  it('returns null for a phone-only user with no email', async () => {
    rowQueue.push([{ email: null }]);

    await expect(resolveOwnerEmail('u1')).resolves.toBeNull();
  });
});

describe('resolveProviderServiceName', () => {
  beforeEach(() => {
    rowQueue.length = 0;
  });

  it('returns jobProviderName from the item state', async () => {
    rowQueue.push([{ state: { jobProviderName: 'Acme Corp' } }]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBe(
      'Acme Corp',
    );
  });

  it('returns null when the item is unknown', async () => {
    rowQueue.push([]);

    await expect(
      resolveProviderServiceName('missing', 'blue_dot'),
    ).resolves.toBeNull();
  });

  it('returns null when item_state has no jobProviderName', async () => {
    rowQueue.push([{ state: { somethingElse: 'x' } }]);

    await expect(
      resolveProviderServiceName('i1', 'blue_dot'),
    ).resolves.toBeNull();
  });

  it('treats a whitespace-only name as absent', async () => {
    rowQueue.push([{ state: { jobProviderName: '   ' } }]);

    await expect(
      resolveProviderServiceName('i1', 'blue_dot'),
    ).resolves.toBeNull();
  });

  it('ignores a non-string jobProviderName', async () => {
    rowQueue.push([{ state: { jobProviderName: 42 } }]);

    await expect(
      resolveProviderServiceName('i1', 'blue_dot'),
    ).resolves.toBeNull();
  });

  it('returns null when item_state itself is missing', async () => {
    rowQueue.push([{ state: undefined }]);

    await expect(
      resolveProviderServiceName('i1', 'blue_dot'),
    ).resolves.toBeNull();
  });
});
