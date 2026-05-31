import { describe, it, expect } from 'vitest';
import {
  findMetricCategoryAsymmetries,
  parseNetworkConfigDocument,
} from '../network_workflow';

const TRACKED = {
  create: ['created'],
  accept: ['accepted'],
  reject: ['rejected'],
  cancel: ['cancelled'],
};

const makeConfig = (interactions: unknown[]) =>
  parseNetworkConfigDocument({
    id: 'test_net',
    domains: [
      {
        id: 'seeker',
        item_schemas: {},
        status_rules: [{ status: 'inactive', when: 'default' }],
      },
      {
        id: 'provider',
        item_schemas: {},
        status_rules: [{ status: 'inactive', when: 'default' }],
      },
    ],
    instances: [],
    actions: { connect: { interactions } },
  });

describe('findMetricCategoryAsymmetries', () => {
  it('flags a tracked interaction whose reverse exists but is null', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker',
        to_domain: 'provider',
        requirement_schema: {},
        metric_categories: TRACKED,
      },
      {
        from_domain: 'provider',
        to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: null,
      },
    ]);
    const result = findMetricCategoryAsymmetries(cfg);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      action_type: 'connect',
      tracked: { from_domain: 'seeker', to_domain: 'provider' },
      untracked: { from_domain: 'provider', to_domain: 'seeker' },
    });
  });

  it('flags when the reverse exists with all-empty (effectively untracked) categories', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker',
        to_domain: 'provider',
        requirement_schema: {},
        metric_categories: TRACKED,
      },
      {
        from_domain: 'provider',
        to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: { create: [], accept: [], reject: [], cancel: [] },
      },
    ]);
    expect(findMetricCategoryAsymmetries(cfg)).toHaveLength(1);
  });

  it('does not flag when both directions are tracked', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker',
        to_domain: 'provider',
        requirement_schema: {},
        metric_categories: TRACKED,
      },
      {
        from_domain: 'provider',
        to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: TRACKED,
      },
    ]);
    expect(findMetricCategoryAsymmetries(cfg)).toEqual([]);
  });

  it('does not flag a one-directional action with no reverse interaction', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker',
        to_domain: 'provider',
        requirement_schema: {},
        metric_categories: TRACKED,
      },
    ]);
    expect(findMetricCategoryAsymmetries(cfg)).toEqual([]);
  });

  it('does not flag when neither direction is tracked', () => {
    const cfg = makeConfig([
      {
        from_domain: 'seeker',
        to_domain: 'provider',
        requirement_schema: {},
        metric_categories: null,
      },
      {
        from_domain: 'provider',
        to_domain: 'seeker',
        requirement_schema: {},
        metric_categories: null,
      },
    ]);
    expect(findMetricCategoryAsymmetries(cfg)).toEqual([]);
  });
});
