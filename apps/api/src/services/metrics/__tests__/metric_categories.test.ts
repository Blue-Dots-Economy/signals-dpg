import { describe, it, expect } from 'vitest';
import {
  resolve_metric_categories,
  discover_metric_categories,
} from '../metric_categories.js';
import type { NetworkConfigDocument } from '@dpg/schemas';

const baseConfig = (interaction: Record<string, unknown>): NetworkConfigDocument => ({
  id: 'blue_dot',
  domains: [],
  instances: [],
  cross_network_origins: [],
  actions: {
    apply: {
      interactions: [interaction as never],
    },
  },
} as unknown as NetworkConfigDocument);

describe('resolve_metric_categories', () => {
  it('returns the metric_categories triple for a matching interaction', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
      metric_categories: {
        shortlisted: ['shortlisted'],
        rejected: ['rejected'],
        pending: ['created', 'submitted'],
      },
    });
    const result = resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'seeker',
      toDomain: 'provider',
    });
    expect(result).toEqual({
      shortlisted: ['shortlisted'],
      rejected: ['rejected'],
      pending: ['created', 'submitted'],
    });
  });

  it("returns null when interaction has metric_categories: null (out of scope)", () => {
    const cfg = baseConfig({
      from_domain: 'provider',
      to_domain: 'seeker',
      requirement_schema: {},
      metric_categories: null,
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'provider',
      toDomain: 'seeker',
    })).toBeNull();
  });

  it('returns null when the interaction has no metric_categories key at all', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'seeker',
      toDomain: 'provider',
    })).toBeNull();
  });

  it('returns null when no matching interaction exists', () => {
    const cfg = baseConfig({
      from_domain: 'seeker',
      to_domain: 'provider',
      requirement_schema: {},
      metric_categories: { shortlisted: ['x'], rejected: [], pending: [] },
    });
    expect(resolve_metric_categories(cfg, {
      actionType: 'apply',
      fromDomain: 'provider',  // direction reversed — no match
      toDomain: 'seeker',
    })).toBeNull();
  });
});

const configWithActions = (
  actions: Record<string, { interactions: Array<Record<string, unknown>> }>,
): NetworkConfigDocument =>
  ({
    id: 'test',
    domains: [],
    instances: [],
    cross_network_origins: [],
    actions,
  }) as unknown as NetworkConfigDocument;

describe('discover_metric_categories', () => {
  it('discovers a non-apply action by name (purple_dot connect)', () => {
    const cfg = configWithActions({
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              pending: ['created'],
              shortlisted: ['accepted'],
              rejected: ['rejected', 'cancelled'],
            },
          },
          {
            from_domain: 'provider',
            to_domain: 'seeker',
            requirement_schema: {},
            metric_categories: null,
          },
        ],
      },
    });
    expect(discover_metric_categories(cfg)).toEqual({
      actionType: 'connect',
      fromDomain: 'seeker',
      toDomain: 'provider',
      categories: {
        pending: ['created'],
        shortlisted: ['accepted'],
        rejected: ['rejected', 'cancelled'],
      },
    });
  });

  it('discovers the apply action when blue_dot-shaped', () => {
    const cfg = configWithActions({
      apply: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              shortlisted: ['shortlisted'],
              rejected: ['rejected'],
              pending: ['created', 'submitted'],
            },
          },
        ],
      },
    });
    const result = discover_metric_categories(cfg);
    expect(result?.actionType).toBe('apply');
    expect(result?.fromDomain).toBe('seeker');
    expect(result?.toDomain).toBe('provider');
  });

  it('returns null when no interaction declares metric_categories (yellow_dot today)', () => {
    const cfg = configWithActions({
      apply: {
        interactions: [
          { from_domain: 'seeker', to_domain: 'provider', requirement_schema: {} },
        ],
      },
    });
    expect(discover_metric_categories(cfg)).toBeNull();
  });

  it('returns null when metric_categories is present but all buckets are empty', () => {
    const cfg = configWithActions({
      apply: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: { shortlisted: [], rejected: [], pending: [] },
          },
        ],
      },
    });
    expect(discover_metric_categories(cfg)).toBeNull();
  });

  it('skips earlier interactions/actions with null metric_categories', () => {
    const cfg = configWithActions({
      noop: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: null,
          },
        ],
      },
      connect: {
        interactions: [
          {
            from_domain: 'seeker',
            to_domain: 'provider',
            requirement_schema: {},
            metric_categories: {
              pending: ['created'],
              shortlisted: ['accepted'],
              rejected: ['rejected'],
            },
          },
        ],
      },
    });
    expect(discover_metric_categories(cfg)?.actionType).toBe('connect');
  });
});
