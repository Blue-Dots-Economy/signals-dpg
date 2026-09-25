import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SsoIdentity } from '../types.js';

const tx = { tag: 'tx' };
vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { transaction: async (fn: (t: unknown) => unknown) => fn(tx) },
}));
const countActiveProfiles = vi.fn();
vi.mock('@/services/item_service', () => ({
  countActiveProfiles: (...a: unknown[]) => countActiveProfiles(...a),
}));
const create_profile_item = vi.fn();
vi.mock('@/lib/profile_item', () => ({
  create_profile_item: (...a: unknown[]) => create_profile_item(...a),
}));
const tagUserWithDefaultAggregator = vi.fn();
vi.mock('@/services/aggregator/default_aggregator', () => ({
  tagUserWithDefaultAggregator: (...a: unknown[]) => tagUserWithDefaultAggregator(...a),
}));
const publishItemEvent = vi.fn();
vi.mock('@/utils/publish_item_event', () => ({
  publishItemEvent: (...a: unknown[]) => publishItemEvent(...a),
}));
const invalidateItemFetchCache = vi.fn(async () => undefined);
vi.mock('@/utils/item_fetch_cache_invalidate', () => ({
  invalidateItemFetchCache: (...a: unknown[]) => invalidateItemFetchCache(...(a as [])),
}));
const isServedDomainBinding = vi.fn(() => true);
const resolveServedNetworkForDomain = vi.fn(() => 'blue_dot');
vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: (...a: unknown[]) => isServedDomainBinding(...(a as [])),
  resolveServedNetworkForDomain: (...a: unknown[]) => resolveServedNetworkForDomain(...(a as [])),
}));

const { bootstrapSsoProfile } = await import('../sso_profile_bootstrap.js');

const IDENTITY: SsoIdentity = {
  provider: 'ncs',
  providerUserId: 'u-1',
  subject: 'ncs:u-1',
  fullName: 'Ameya Kulkarni',
  phone: '+919730862967',
  phoneVerified: true,
  email: 'ameya@gmail.com',
  emailVerified: false,
  role: 'JOBSEEKER',
  attributes: {
    fullName: 'Ameya Kulkarni',
    mobileNumber: '9730862967',
    email: 'ameya@gmail.com',
    status: 'ACTIVE',
  },
};

const MAPPING = {
  item_type: 'profile_1.0',
  role_to_domain: { JOBSEEKER: 'seeker' },
  fields: { fullName: 'name', mobileNumber: 'phone', email: 'email', missing: 'nope' },
  feature_routes: {},
};

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

beforeEach(() => {
  vi.clearAllMocks();
  countActiveProfiles.mockResolvedValue(0);
  create_profile_item.mockResolvedValue({ item_id: 'item-1' });
});

describe('bootstrapSsoProfile', () => {
  it('creates a draft profile from the mapped partner fields', async () => {
    const result = await bootstrapSsoProfile('user-1', IDENTITY, MAPPING, log);

    expect(result).toEqual({ created: true, itemId: 'item-1' });
    expect(tagUserWithDefaultAggregator).toHaveBeenCalledWith(tx, 'user-1', 'blue_dot', 'seeker');
    expect(create_profile_item).toHaveBeenCalledWith({
      tx,
      user_id: 'user-1',
      network: 'blue_dot',
      domain: 'seeker',
      item_type: 'profile_1.0',
      // Normalised phone rather than the raw 10 digits; unmapped/absent fields dropped.
      payload: { name: 'Ameya Kulkarni', phone: '+919730862967', email: 'ameya@gmail.com' },
    });
    expect(publishItemEvent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: 'item-1', op: 'upsert', item_domain: 'seeker' }),
      log
    );
  });

  it('does nothing when the user already has a profile there', async () => {
    countActiveProfiles.mockResolvedValue(1);
    expect(await bootstrapSsoProfile('user-1', IDENTITY, MAPPING, log)).toEqual({
      created: false,
    });
    expect(create_profile_item).not.toHaveBeenCalled();
    expect(publishItemEvent).not.toHaveBeenCalled();
  });

  it('does nothing for an unmapped role', async () => {
    expect(
      await bootstrapSsoProfile('user-1', { ...IDENTITY, role: 'EMPLOYER' }, MAPPING, log)
    ).toEqual({ created: false });
    expect(countActiveProfiles).not.toHaveBeenCalled();
  });

  it('does nothing when the domain is not served here', async () => {
    isServedDomainBinding.mockReturnValueOnce(false);
    expect(await bootstrapSsoProfile('user-1', IDENTITY, MAPPING, log)).toEqual({
      created: false,
    });
  });

  it('uses the mapped network when one is configured', async () => {
    await bootstrapSsoProfile('user-1', IDENTITY, { ...MAPPING, network: 'purple_dot' }, log);
    expect(resolveServedNetworkForDomain).not.toHaveBeenCalled();
    expect(create_profile_item).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'purple_dot' })
    );
  });

  it('never throws: a failed create is logged and reported as not created', async () => {
    create_profile_item.mockRejectedValue(new Error('schema says no'));
    expect(await bootstrapSsoProfile('user-1', IDENTITY, MAPPING, log)).toEqual({
      created: false,
    });
    expect(log.error).toHaveBeenCalled();
  });
});
