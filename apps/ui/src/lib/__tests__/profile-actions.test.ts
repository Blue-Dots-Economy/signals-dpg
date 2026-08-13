import { describe, it, expect } from 'vitest';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import {
  getActionsForDomain,
  resolveTargetInstanceUrl,
  computeOpenActionItemIds,
} from '@/lib/profile-actions';

const network = {
  id: 'blue_dot',
  actions: {
    apply: {
      interactions: [
        {
          from_domain: 'seeker',
          to_domain: 'provider',
          requirement_schema: { type: 'object' },
          event_schema: { type: 'object' },
          reveals_pii_on_status: ['accepted'],
        },
        {
          from_domain: 'provider',
          to_domain: 'seeker',
          requirement_schema: undefined,
          event_schema: undefined,
          reveals_pii_on_status: undefined,
        },
      ],
    },
    connect: { interactions: [] },
  },
  instances: [{ domain_id: 'provider', instance_url: 'https://provider.example' }],
} as unknown as DotNetworkSchema;

const item = (over: Partial<Item> = {}): Item =>
  ({ item_id: 'x', item_domain: 'provider', item_instance_url: undefined, ...over }) as Item;

describe('getActionsForDomain', () => {
  it('returns [] when the network is null', () => {
    expect(getActionsForDomain(null, 'seeker', 'provider')).toEqual([]);
  });

  it('flattens only interactions matching source -> target', () => {
    const actions = getActionsForDomain(network, 'seeker', 'provider');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action_type: 'apply',
      from_domain: 'seeker',
      to_domain: 'provider',
    });
  });

  it('is directional — the reverse pair yields the reverse interaction', () => {
    expect(getActionsForDomain(network, 'provider', 'seeker').map((a) => a.action_type)).toEqual([
      'apply',
    ]);
  });

  it('returns [] when no interaction matches the pair', () => {
    expect(getActionsForDomain(network, 'seeker', 'seeker')).toEqual([]);
  });
});

describe('resolveTargetInstanceUrl', () => {
  it('uses the item instance URL when it is non-localhost', () => {
    expect(
      resolveTargetInstanceUrl(
        item({ item_instance_url: 'https://a.example' }),
        network,
        'https://api.example',
      ),
    ).toBe('https://a.example');
  });

  it('skips a localhost item URL in production and falls back to the network instance', () => {
    expect(
      resolveTargetInstanceUrl(
        item({ item_instance_url: 'http://localhost:2742' }),
        network,
        'https://api.example',
      ),
    ).toBe('https://provider.example');
  });

  it('keeps a localhost item URL when the deployment itself is localhost', () => {
    expect(
      resolveTargetInstanceUrl(
        item({ item_instance_url: 'http://localhost:2742' }),
        network,
        'http://localhost:2742',
      ),
    ).toBe('http://localhost:2742');
  });

  it('falls back to the current API URL when nothing else resolves', () => {
    expect(
      resolveTargetInstanceUrl(item({ item_domain: 'seeker' }), network, 'https://api.example'),
    ).toBe('https://api.example');
  });
});

describe('computeOpenActionItemIds', () => {
  const rows = [
    { action_status: 'created', source_item_id: 'me', target_item_id: 'a' },
    { action_status: 'pending', source_item_id: 'b', target_item_id: 'me' },
    { action_status: 'accepted', source_item_id: 'me', target_item_id: 'c' }, // terminal → excluded
    { action_status: 'created', source_item_id: 'x', target_item_id: 'y' }, // unrelated
  ];

  it('is empty without an active profile', () => {
    expect(computeOpenActionItemIds(rows, null).size).toBe(0);
  });

  it('collects the counterpart id in either direction, skipping terminal statuses', () => {
    const set = computeOpenActionItemIds(rows, 'me');
    expect(set.has('a')).toBe(true); // me -> a (open)
    expect(set.has('b')).toBe(true); // b -> me (open)
    expect(set.has('c')).toBe(false); // accepted (terminal)
    expect(set.has('y')).toBe(false); // unrelated pair
    expect(set.size).toBe(2);
  });
});
