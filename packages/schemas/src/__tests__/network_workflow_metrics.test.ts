import { describe, it, expect } from 'vitest';
import { NetworkConfigSchema } from '../network_workflow';

const baseConfig = {
  id: 'test_net',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': {
          type: 'object',
          properties: { name: { type: 'string' }, secret: { type: 'string', private: true } },
        },
      },
      status_rules: [
        { status: 'new', when: { item_age_days: { lte: 7 } } },
        { status: 'inactive', when: 'default' },
      ],
    },
  ],
  instances: [],
  actions: {},
};

describe('NetworkConfigSchema metrics extensions', () => {
  it('accepts a domain with valid status_rules and display_name_field', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'name';
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects status_rules without a default tail', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [{ status: 'new', when: { item_age_days: { lte: 7 } } }];
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/default.*tail/);
  });

  it('rejects status with value outside CANONICAL_STATUSES', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [
      { status: 'satisfied', when: { item_age_days: { lte: 7 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('rejects metric_categories with unknown bucket key', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.actions = {
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: { shortlisted: ['accepted'] },
          },
        ],
      },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('accepts canonical metric_categories keys', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.actions = {
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
    };
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects display_name_field pointing at a private property', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'secret';
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/private/);
  });

  it('rejects display_name_field pointing at a missing property', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].item_schemas['profile_1.0'].display_name_field = 'nonexistent';
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow(/does not exist/);
  });

  it('accepts status_rules using days_since_last (bucket-scoped) predicate', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [
      { status: 'active', when: { days_since_last: { buckets: ['accept', 'create'], lte: 30 } } },
      { status: 'at_risk', when: { count: { buckets: ['reject'], between: [1, 5] } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects bucket-scoped predicate referencing an unknown bucket name', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].status_rules = [
      { status: 'active', when: { days_since_last: { buckets: ['shortlisted'], lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });
});
