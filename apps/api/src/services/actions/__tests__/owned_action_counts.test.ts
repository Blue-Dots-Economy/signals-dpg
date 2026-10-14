import { describe, it, expect, vi } from 'vitest';
import { parseNetworkConfigDocument } from '@dpg/schemas';

const groups: unknown[] = [];
vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ groupBy: async () => groups }) }),
    }),
  },
}));

const { countOwnedActionsForViews } = await import('../owned_action_counts');

const rules = [{ status: 'new', when: 'default' }];
const CFG = parseNetworkConfigDocument({
  id: 'n',
  domains: [
    { id: 'seeker', status_rules: rules, item_schemas: { p: { type: 'object' } } },
    { id: 'provider', status_rules: rules, item_schemas: { p: { type: 'object' } } },
  ],
  actions: {
    apply: {
      interactions: [
        {
          from_domain: 'seeker',
          to_domain: 'provider',
          requirement_schema: { type: 'object' },
          event_schema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['created', 'accepted', 'rejected'] } },
          },
          metric_categories: { create: ['created'], accept: ['accepted'], reject: ['rejected'] },
          reveals_pii_on_status: ['accepted'],
          export: { requester_domains: ['provider'] },
        },
      ],
    },
  },
});

const group = (status: string, side: 'received' | 'initiated', n: number) => ({
  action_type: 'apply',
  action_status: status,
  source_item_network: 'n',
  source_item_domain: 'seeker',
  source_item_type: 'p',
  target_item_network: 'n',
  target_item_domain: 'provider',
  target_item_type: 'p',
  source_item_owner: side === 'initiated' ? 'me' : 'them',
  target_item_owner: side === 'received' ? 'me' : 'them',
  n,
});

describe('countOwnedActionsForViews', () => {
  it('derives the saved-view totals from each interaction', async () => {
    groups.splice(0, groups.length, group('created', 'received', 3), group('accepted', 'received', 2), group('rejected', 'received', 1));
    const counts = await countOwnedActionsForViews('me', { getNetworkConfig: async () => CFG });
    expect(counts).toEqual({ all: 6, needs_response: 3, ready_to_export: 2, sent: 0 });
  });

  it('a seeker (not an export requester here) gets no ready_to_export; its sends count as sent', async () => {
    groups.splice(0, groups.length, group('accepted', 'initiated', 4));
    const counts = await countOwnedActionsForViews('me', { getNetworkConfig: async () => CFG });
    expect(counts).toEqual({ all: 4, needs_response: 0, ready_to_export: 0, sent: 4 });
  });

  it('an unresolvable interaction counts only toward all/sent (fail closed)', async () => {
    groups.splice(0, groups.length, group('created', 'received', 2));
    const onError = vi.fn();
    const counts = await countOwnedActionsForViews('me', { getNetworkConfig: async () => null, onError });
    expect(counts).toEqual({ all: 2, needs_response: 0, ready_to_export: 0, sent: 0 });
  });
});
