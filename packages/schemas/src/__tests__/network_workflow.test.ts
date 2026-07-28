import { describe, it, expect } from 'vitest';
import {
  parseNetworkConfigDocument,
  getInteractionPiiRevealStatuses,
  NetworkActionInteractionSchema,
} from '../network_workflow';

const minimalStatusRules = [{ status: 'new', when: 'default' }];

const baseConfig = {
  id: 'test_net',
  domains: [
    { id: 'seeker', item_schemas: { profile_1_0: { type: 'object' } }, status_rules: minimalStatusRules },
    { id: 'provider', item_schemas: { profile_1_0: { type: 'object' } }, status_rules: minimalStatusRules },
  ],
  instances: [],
  cross_network_origins: [],
  actions: {
    connect: {
      interactions: [
        {
          from_network: 'test_net',
          from_domain: 'seeker',
          to_network: 'test_net',
          to_domain: 'provider',
          requirement_schema: { type: 'object' },
          event_schema: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['created', 'accepted', 'rejected', 'cancelled'],
              },
            },
          },
          reveals_pii_on_status: ['accepted'],
        },
      ],
    },
  },
};

describe('network_workflow pause_enabled', () => {
  it('defaults to true when omitted', () => {
    expect(parseNetworkConfigDocument(baseConfig).pause_enabled).toBe(true);
  });

  it('accepts an explicit false', () => {
    expect(
      parseNetworkConfigDocument({ ...baseConfig, pause_enabled: false }).pause_enabled,
    ).toBe(false);
  });
});

describe('network_workflow reveals_pii_on_status', () => {
  it('parses a valid reveals_pii_on_status list', () => {
    const parsed = parseNetworkConfigDocument(baseConfig);
    const interaction = parsed.actions.connect.interactions[0];
    expect(interaction.reveals_pii_on_status).toEqual(['accepted']);
  });

  it('defaults reveals_pii_on_status to an empty array when omitted', () => {
    const { reveals_pii_on_status: _omit, ...interactionWithout } =
      baseConfig.actions.connect.interactions[0];
    const cfg = {
      ...baseConfig,
      actions: {
        connect: {
          interactions: [interactionWithout],
        },
      },
    };
    const parsed = parseNetworkConfigDocument(cfg);
    expect(parsed.actions.connect.interactions[0].reveals_pii_on_status).toEqual([]);
  });

  it('throws at parse time if a reveal status is not in the event_schema enum', () => {
    const bad = {
      ...baseConfig,
      actions: {
        connect: {
          interactions: [
            {
              ...baseConfig.actions.connect.interactions[0],
              reveals_pii_on_status: ['accepted', 'completed'],
            },
          ],
        },
      },
    };
    expect(() => parseNetworkConfigDocument(bad)).toThrow(/completed/);
  });

  it('throws if reveals_pii_on_status is set but event_schema is absent', () => {
    const bad = {
      ...baseConfig,
      actions: {
        connect: {
          interactions: [
            {
              from_network: 'test_net',
              from_domain: 'seeker',
              to_network: 'test_net',
              to_domain: 'provider',
              requirement_schema: { type: 'object' },
              reveals_pii_on_status: ['accepted'],
            },
          ],
        },
      },
    };
    expect(() => parseNetworkConfigDocument(bad)).toThrow(/event_schema/);
  });

  it('getInteractionPiiRevealStatuses returns the list for a configured interaction', () => {
    const parsed = parseNetworkConfigDocument(baseConfig);
    const statuses = getInteractionPiiRevealStatuses(parsed, {
      actionType: 'connect',
      fromNetwork: 'test_net',
      fromDomain: 'seeker',
      toNetwork: 'test_net',
      toDomain: 'provider',
    });
    expect(statuses).toEqual(['accepted']);
  });

  it('getInteractionPiiRevealStatuses returns [] when not configured', () => {
    const { reveals_pii_on_status: _omit, ...interactionWithout } =
      baseConfig.actions.connect.interactions[0];
    const parsed = parseNetworkConfigDocument({
      ...baseConfig,
      actions: { connect: { interactions: [interactionWithout] } },
    });
    const statuses = getInteractionPiiRevealStatuses(parsed, {
      actionType: 'connect',
      fromNetwork: 'test_net',
      fromDomain: 'seeker',
      toNetwork: 'test_net',
      toDomain: 'provider',
    });
    expect(statuses).toEqual([]);
  });
});

function validInteractionFixture() {
  return {
    from_network: 'test_net',
    from_domain: 'seeker',
    to_network: 'test_net',
    to_domain: 'provider',
    requirement_schema: { type: 'object' },
    event_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['created', 'accepted', 'rejected', 'cancelled'],
        },
      },
    },
    reveals_pii_on_status: ['accepted'],
  };
}

describe('network_workflow domain card config', () => {
  function configWithCard(card: unknown) {
    return {
      ...baseConfig,
      domains: [
        { id: 'seeker', item_schemas: { profile_1_0: { type: 'object' } }, status_rules: minimalStatusRules, card },
        { id: 'provider', item_schemas: { profile_1_0: { type: 'object' } }, status_rules: minimalStatusRules },
      ],
    };
  }

  it('preserves a card block through parsing (not stripped by Zod)', () => {
    const parsed = parseNetworkConfigDocument(
      configWithCard({
        title_field: 'name',
        avatar_from: 'name',
        default_fields: ['category', 'area'],
      })
    );
    expect(parsed.domains[0].card).toEqual({
      title_field: 'name',
      avatar_from: 'name',
      default_fields: ['category', 'area'],
    });
  });

  it('defaults default_fields to [] when omitted', () => {
    const parsed = parseNetworkConfigDocument(configWithCard({ title_field: 'name' }));
    expect(parsed.domains[0].card?.default_fields).toEqual([]);
  });

  it('leaves card undefined when the domain has no card block', () => {
    const parsed = parseNetworkConfigDocument(baseConfig);
    expect(parsed.domains[0].card).toBeUndefined();
  });

  it('rejects unknown keys inside card (strict)', () => {
    expect(() =>
      parseNetworkConfigDocument(configWithCard({ title_field: 'name', bogus: true }))
    ).toThrow();
  });
});
