import { describe, it, expect } from 'vitest';
import { collect_tracked_interactions } from '../metric_categories.js';
import type { NetworkConfigDocument } from '@dpg/schemas';

const makeConfig = (interactions: unknown[]): NetworkConfigDocument =>
  ({
    id: 'test',
    domains: [],
    instances: [],
    actions: { connect: { interactions } },
  }) as unknown as NetworkConfigDocument;

describe('collect_tracked_interactions', () => {
  it('returns empty list when no interactions declare metric_categories', () => {
    const cfg = makeConfig([
      { from_domain: 'seeker', to_domain: 'provider', metric_categories: null, requirement_schema: {} },
    ]);
    expect(collect_tracked_interactions(cfg)).toEqual([]);
  });

  it('returns each interaction with non-empty canonical map', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: ['created'], accept: ['accepted'], reject: ['rejected'], cancel: ['cancelled'] },
      },
      {
        from_domain: 'provider', to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: null,
      },
    ]);
    const result = collect_tracked_interactions(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      actionType: 'connect',
      fromDomain: 'seeker',
      toDomain: 'provider',
      categories: { create: ['created'], accept: ['accepted'], reject: ['rejected'], cancel: ['cancelled'] },
    });
  });

  it('treats an interaction with all-empty buckets as untracked', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: [], accept: [], reject: [], cancel: [] },
      },
    ]);
    expect(collect_tracked_interactions(cfg)).toEqual([]);
  });

  it('partial maps fill missing buckets with empty arrays', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker', to_domain: 'provider',
        requirement_schema: {},
        metric_categories: { create: ['created'] },
      },
    ]);
    const result = collect_tracked_interactions(cfg);
    expect(result[0].categories).toEqual({
      create: ['created'],
      accept: [],
      reject: [],
      cancel: [],
    });
  });
});
