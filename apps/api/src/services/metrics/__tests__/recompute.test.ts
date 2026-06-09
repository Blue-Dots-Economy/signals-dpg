import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, insertMock, valuesMock } = vi.hoisted(() => {
  const executeMock = vi.fn();
  const valuesMock = vi.fn((_rows: Array<Record<string, unknown>>) => ({
    onConflictDoUpdate: vi.fn(async () => undefined),
  }));
  const insertMock = vi.fn(() => ({ values: valuesMock }));
  return { executeMock, insertMock, valuesMock };
});

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { execute: executeMock, insert: insertMock },
}));
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'purple_dot',
    domains: [
      {
        id: 'seeker',
        item_schemas: {
          'profile_1.0': {
            type: 'object',
            required: ['beneficiary_name'],
            properties: { beneficiary_name: { type: 'string', private: true } },
          },
        },
        status_rules: [
          { status: 'new', when: { item_age_days: { lte: 7 } } },
          { status: 'inactive', when: 'default' },
        ],
      },
    ],
    actions: {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              create: ['created'],
              accept: ['accepted'],
              reject: ['rejected'],
              cancel: ['cancelled'],
            },
          },
        ],
      },
    },
  })),
}));
vi.mock('../schema_lookup.js', () => ({
  get_item_schema: vi.fn(async () => ({
    type: 'object',
    required: ['beneficiary_name'],
    properties: { beneficiary_name: { type: 'string', private: true } },
  })),
}));

import { recompute_aggregator_domain_metrics } from '../recompute.js';

describe('recompute_aggregator_domain_metrics', () => {
  beforeEach(() => {
    executeMock.mockReset();
    insertMock.mockClear();
    valuesMock.mockClear();
  });

  it('returns processed: 0 when no items exist for the (aggregator, domain)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(0);
  });

  it('computes and upserts one item with empty action counts → status new (age <= 7)', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ item_network: 'purple_dot' }] });
    const now = new Date();
    const created = new Date(now.getTime() - 3 * 86_400_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          item_id: 'itm_1',
          item_network: 'purple_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          owner_user_id: 'u_1',
          onboarded_by_org_id: 'org_1',
          onboarded_via: 'bulk',
          item_state: { beneficiary_name: 'Asha' },
          profile_created_at: created,
          profile_last_updated_at: created,
          initiated_create: 0,
          initiated_accept: 0,
          initiated_reject: 0,
          initiated_cancel: 0,
          received_create: 0,
          received_accept: 0,
          received_reject: 0,
          received_cancel: 0,
          last_initiated_create_at: null,
          last_initiated_accept_at: null,
          last_initiated_reject_at: null,
          last_initiated_cancel_at: null,
          last_received_create_at: null,
          last_received_accept_at: null,
          last_received_reject_at: null,
          last_received_cancel_at: null,
        },
      ],
    });

    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(1);
    expect(insertMock).toHaveBeenCalledOnce();

    const inserted = valuesMock.mock.calls[0]![0][0]!;
    expect(inserted.initiated).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
    expect(inserted.received).toEqual({ create: 0, accept: 0, reject: 0, cancel: 0 });
    // Sparse last-at maps: no actions occurred → empty objects.
    expect(inserted.lastInitiatedAt).toEqual({});
    expect(inserted.lastReceivedAt).toEqual({});
  });

  it('assembles directional maps + sparse last-at maps from split columns', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ item_network: 'purple_dot' }] });
    const now = new Date();
    const created = new Date(now.getTime() - 3 * 86_400_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          item_id: 'itm_2',
          item_network: 'purple_dot',
          item_domain: 'seeker',
          item_type: 'profile_1.0',
          owner_user_id: 'u_2',
          onboarded_by_org_id: 'org_1',
          onboarded_via: 'bulk',
          item_state: { beneficiary_name: 'Ravi' },
          profile_created_at: created,
          profile_last_updated_at: created,
          initiated_create: 2,
          initiated_accept: 0,
          initiated_reject: 1,
          initiated_cancel: 0,
          received_create: 0,
          received_accept: 3,
          received_reject: 0,
          received_cancel: 0,
          last_initiated_create_at: new Date('2026-05-01T00:00:00Z'),
          last_initiated_accept_at: null,
          last_initiated_reject_at: new Date('2026-05-02T00:00:00Z'),
          last_initiated_cancel_at: null,
          last_received_create_at: null,
          last_received_accept_at: new Date('2026-05-03T00:00:00Z'),
          last_received_reject_at: null,
          last_received_cancel_at: null,
        },
      ],
    });

    const result = await recompute_aggregator_domain_metrics('org_1', 'seeker');
    expect(result.processed).toBe(1);

    const inserted = valuesMock.mock.calls[0]![0][0]!;
    expect(inserted.initiated).toEqual({ create: 2, accept: 0, reject: 1, cancel: 0 });
    expect(inserted.received).toEqual({ create: 0, accept: 3, reject: 0, cancel: 0 });
    // Only buckets with a timestamp appear; absent buckets are omitted.
    expect(inserted.lastInitiatedAt).toEqual({
      create: '2026-05-01T00:00:00.000Z',
      reject: '2026-05-02T00:00:00.000Z',
    });
    expect(inserted.lastReceivedAt).toEqual({ accept: '2026-05-03T00:00:00.000Z' });
  });
});
