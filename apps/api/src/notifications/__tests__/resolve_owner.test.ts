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
  user: { id: 'user.id', email: 'user.email', name: 'user.name' },
  organization: { id: 'organization.id', name: 'organization.name' },
}));

vi.mock('@dpg/database', () => ({
  items: {
    item_state: 'items.item_state',
    item_network: 'items.item_network',
    item_id: 'items.item_id',
  },
}));

import {
  resolveOwnerEmail,
  resolveOwnerNameEmail,
  resolveOrgName,
  resolveProviderServiceName,
} from '../resolve_owner';

describe('resolveOwnerNameEmail', () => {
  beforeEach(() => {
    rowQueue.length = 0;
  });

  it('returns name + email for a known user', async () => {
    rowQueue.push([{ name: 'Asha', email: 'a@b.com' }]);
    expect(await resolveOwnerNameEmail('u1')).toEqual({ found: true, name: 'Asha', email: 'a@b.com' });
  });

  it('returns nulls for an unknown user', async () => {
    expect(await resolveOwnerNameEmail('missing')).toEqual({ found: false, name: null, email: null });
  });

  it('folds a synthetic @no-email.local address to null (found stays true) (#592 Blocker 2)', async () => {
    rowQueue.push([{ name: 'Asha', email: 'abc-123@no-email.local' }]);
    // Phone-only signup: better-auth persisted a synthetic address. It is
    // deliverable to nobody, so the owner reads as no-email (found still true).
    expect(await resolveOwnerNameEmail('u1')).toEqual({ found: true, name: 'Asha', email: null });
  });
});

describe('resolveOwnerEmail', () => {
  beforeEach(() => {
    rowQueue.length = 0;
  });

  it('returns a real email', async () => {
    rowQueue.push([{ email: 'a@b.com' }]);
    expect(await resolveOwnerEmail('u1')).toBe('a@b.com');
  });

  it('folds a synthetic @no-email.local address to null (#592 Blocker 2)', async () => {
    rowQueue.push([{ email: 'ABC-123@No-Email.Local' }]); // case-insensitive suffix
    expect(await resolveOwnerEmail('u1')).toBeNull();
  });
});

describe('resolveOrgName', () => {
  beforeEach(() => {
    rowQueue.length = 0;
  });

  it('returns the org display name', async () => {
    rowQueue.push([{ name: 'SkillBridge Network' }]);
    expect(await resolveOrgName('org-1')).toBe('SkillBridge Network');
  });

  it('returns null for an unknown or blank org', async () => {
    rowQueue.push([]);
    expect(await resolveOrgName('missing')).toBeNull();
    rowQueue.push([{ name: '  ' }]);
    expect(await resolveOrgName('blank')).toBeNull();
  });
});

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
