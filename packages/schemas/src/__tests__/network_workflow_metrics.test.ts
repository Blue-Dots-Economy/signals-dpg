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

  it('accepts structured dashboard_tiles (profile + user groups) on a domain', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].dashboard_tiles = {
      profile: [
        { field: 'total_items', label: 'Profiles Registered' },
        { field: 'complete_profiles', label: 'Profiles Done' },
      ],
      user: [
        { field: 'total_users', label: 'Total Seekers' },
        { field: 'avg_items_per_user', label: 'Avg Profiles per Seeker' },
      ],
    };
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects an unknown key in a dashboard_tiles entry', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].dashboard_tiles = {
      profile: [{ field: 'total_items', label: 'Total', not_a_key: 'x' }],
    };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('rejects an unknown group key in dashboard_tiles', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.domains[0].dashboard_tiles = { not_a_group: [{ field: 'x', label: 'y' }] };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('accepts directional dashboard_buckets at the network root', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.dashboard_buckets = {
      by_status: { new: 'New', active: 'Active', at_risk: 'At Risk', inactive: 'Inactive' },
      by_initiated_action_status: { create: 'Applied', accept: 'Accepted', reject: 'Rejected', cancel: 'Withdrawn' },
      by_received_action_status: { create: 'Applications', accept: 'Shortlisted', reject: 'Rejected', cancel: 'Cancelled' },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).not.toThrow();
  });

  it('rejects the removed by_action_status key in dashboard_buckets', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.dashboard_buckets = {
      by_action_status: { create: 'Applied', accept: 'Shortlisted', reject: 'Rejected', cancel: 'Withdrawn' },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });

  it('rejects unknown bucket key in a directional action-status map', () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.dashboard_buckets = {
      by_initiated_action_status: { shortlisted: 'foo' },
    };
    expect(() => NetworkConfigSchema.parse(cfg)).toThrow();
  });
});
