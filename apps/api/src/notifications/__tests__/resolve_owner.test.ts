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
    item_domain: 'items.item_domain',
    item_type: 'items.item_type',
  },
}));

// The provider resolvers read the item's own network config to find which
// item_state field holds the public name / the offering. Mocked here so the
// test stays a pure unit (the real module loads the whole schema stack).
const { networkConfig } = vi.hoisted(() => ({
  networkConfig: { value: null as unknown, throws: false },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(() => {
    if (networkConfig.throws) return Promise.reject(new Error('config unavailable'));
    return Promise.resolve(networkConfig.value);
  }),
}));

/** Config for one provider domain declaring the given schema field names. */
function configWith(fields: { display_name_field?: string; offering_field?: string }) {
  return {
    domains: [{ id: 'provider', item_schemas: { 'profile_1.0': { ...fields } } }],
  };
}

import {
  resolveOwnerEmail,
  resolveOwnerNameEmail,
  resolveOrgName,
  resolveProviderOffering,
  resolveProviderServiceName,
} from '../resolve_owner';

/** Every provider-item row the resolvers read carries the partition keys. */
function providerRow(state: Record<string, unknown> | undefined) {
  return { state, domain: 'provider', type: 'profile_1.0' };
}

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
    networkConfig.value = configWith({ display_name_field: 'jobProviderName' });
    networkConfig.throws = false;
  });

  it('returns the schema-declared display field from the item state', async () => {
    rowQueue.push([providerRow({ jobProviderName: 'Acme Corp' })]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBe('Acme Corp');
  });

  it('honours a network that declares a different display field', async () => {
    // purple_dot: the provider's public name is `organisation_name`, not the
    // blue_dot `jobProviderName` this resolver used to hardcode.
    networkConfig.value = configWith({ display_name_field: 'organisation_name' });
    rowQueue.push([providerRow({ organisation_name: 'ALIMCO Kanpur' })]);

    await expect(resolveProviderServiceName('i1', 'purple_dot')).resolves.toBe('ALIMCO Kanpur');
  });

  it('falls back to the domain card title field when no display field is declared', async () => {
    networkConfig.value = {
      domains: [{ id: 'provider', item_schemas: { 'profile_1.0': {} }, card: { title_field: 'organisation_name' } }],
    };
    rowQueue.push([providerRow({ organisation_name: 'ALIMCO Kanpur' })]);

    await expect(resolveProviderServiceName('i1', 'purple_dot')).resolves.toBe('ALIMCO Kanpur');
  });

  it('falls back to jobProviderName when the config lookup fails', async () => {
    networkConfig.throws = true;
    rowQueue.push([providerRow({ jobProviderName: 'Acme Corp' })]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBe('Acme Corp');
  });

  it('returns null when the item is unknown', async () => {
    rowQueue.push([]);

    await expect(resolveProviderServiceName('missing', 'blue_dot')).resolves.toBeNull();
  });

  it('returns null when item_state has no such field', async () => {
    rowQueue.push([providerRow({ somethingElse: 'x' })]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBeNull();
  });

  it('treats a whitespace-only name as absent', async () => {
    rowQueue.push([providerRow({ jobProviderName: '   ' })]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBeNull();
  });

  it('ignores a non-string name', async () => {
    rowQueue.push([providerRow({ jobProviderName: 42 })]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBeNull();
  });

  it('returns null when item_state itself is missing', async () => {
    rowQueue.push([providerRow(undefined)]);

    await expect(resolveProviderServiceName('i1', 'blue_dot')).resolves.toBeNull();
  });
});

describe('resolveProviderOffering', () => {
  beforeEach(() => {
    rowQueue.length = 0;
    networkConfig.value = configWith({ offering_field: 'services_offered' });
    networkConfig.throws = false;
  });

  it('joins a multi-select array into a readable phrase', async () => {
    rowQueue.push([providerRow({ services_offered: ['Assistive Devices', 'Counselling & Mentorship'] })]);

    await expect(resolveProviderOffering('i1', 'purple_dot')).resolves.toBe(
      'Assistive Devices, Counselling & Mentorship',
    );
  });

  it('passes a plain string field through', async () => {
    rowQueue.push([providerRow({ services_offered: 'Assistive Devices' })]);

    await expect(resolveProviderOffering('i1', 'purple_dot')).resolves.toBe('Assistive Devices');
  });

  it('drops blank and non-string entries from the array', async () => {
    rowQueue.push([providerRow({ services_offered: ['Education', '  ', 7, null] })]);

    await expect(resolveProviderOffering('i1', 'purple_dot')).resolves.toBe('Education');
  });

  it('returns null for an array with nothing usable in it', async () => {
    rowQueue.push([providerRow({ services_offered: ['  ', null] })]);

    await expect(resolveProviderOffering('i1', 'purple_dot')).resolves.toBeNull();
  });

  it('returns null when the network declares no offering field', async () => {
    networkConfig.value = configWith({ display_name_field: 'jobProviderName' });
    rowQueue.push([providerRow({ services_offered: ['Assistive Devices'] })]);

    await expect(resolveProviderOffering('i1', 'blue_dot')).resolves.toBeNull();
  });

  it('returns null when the config lookup fails', async () => {
    networkConfig.throws = true;
    rowQueue.push([providerRow({ services_offered: ['Assistive Devices'] })]);

    await expect(resolveProviderOffering('i1', 'purple_dot')).resolves.toBeNull();
  });

  it('returns null when the item is unknown', async () => {
    rowQueue.push([]);

    await expect(resolveProviderOffering('missing', 'purple_dot')).resolves.toBeNull();
  });
});
