import { describe, it, expect } from 'vitest';
import {
  evaluate_status_rules,
  type RuleInput,
  type StatusRule,
} from '../evaluate_status_rules.js';

const NOW = new Date('2026-05-26T00:00:00Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);

const baseInput = (overrides: Partial<RuleInput> = {}): RuleInput => ({
  item_age_days: 10,
  count: { create: 0, accept: 0, reject: 0, cancel: 0 },
  days_since_last: { create: null, accept: null, reject: null, cancel: null },
  ...overrides,
});

describe('evaluate_status_rules', () => {
  it('matches new on item_age_days lte', () => {
    const rules: StatusRule[] = [
      { status: 'new', when: { item_age_days: { lte: 7 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 7 }))).toBe('new');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 8 }))).toBe('inactive');
  });

  it('matches active via days_since_last with buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { days_since_last: { buckets: ['accept'], lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ days_since_last: { create: null, accept: 20, reject: null, cancel: null } }),
      ),
    ).toBe('active');
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ days_since_last: { create: null, accept: 35, reject: null, cancel: null } }),
      ),
    ).toBe('inactive');
  });

  it('days_since_last predicate is false when no action in those buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { days_since_last: { buckets: ['accept'], lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput())).toBe('inactive');
  });

  it('between operator is inclusive both ends', () => {
    const rules: StatusRule[] = [
      { status: 'at_risk', when: { days_since_last: { buckets: ['create'], between: [31, 90] } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 31, accept: null, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 90, accept: null, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 30, accept: null, reject: null, cancel: null } })),
    ).toBe('inactive');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: 91, accept: null, reject: null, cancel: null } })),
    ).toBe('inactive');
  });

  it('count predicate sums across listed buckets', () => {
    const rules: StatusRule[] = [
      { status: 'active', when: { count: { buckets: ['create', 'accept'], gte: 1 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ count: { create: 0, accept: 1, reject: 0, cancel: 0 } })),
    ).toBe('active');
    expect(
      evaluate_status_rules(rules, baseInput({ count: { create: 0, accept: 0, reject: 5, cancel: 5 } })),
    ).toBe('inactive');
  });

  it('all combinator ANDs children', () => {
    const rules: StatusRule[] = [
      {
        status: 'inactive',
        when: {
          all: [
            { count: { buckets: ['create', 'accept', 'reject'], eq: 0 } },
            { item_age_days: { gt: 90 } },
          ],
        },
      },
      { status: 'new', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 100 }))).toBe('inactive');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 50 }))).toBe('new');
    expect(
      evaluate_status_rules(
        rules,
        baseInput({ item_age_days: 100, count: { create: 1, accept: 0, reject: 0, cancel: 0 } }),
      ),
    ).toBe('new');
  });

  it('any combinator ORs children', () => {
    const rules: StatusRule[] = [
      {
        status: 'at_risk',
        when: {
          any: [
            { days_since_last: { buckets: ['accept'], between: [31, 90] } },
            { days_since_last: { buckets: ['reject'], between: [31, 90] } },
          ],
        },
      },
      { status: 'inactive', when: 'default' },
    ];
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: null, accept: 50, reject: null, cancel: null } })),
    ).toBe('at_risk');
    expect(
      evaluate_status_rules(rules, baseInput({ days_since_last: { create: null, accept: null, reject: 50, cancel: null } })),
    ).toBe('at_risk');
    expect(evaluate_status_rules(rules, baseInput())).toBe('inactive');
  });

  it('first-match-wins ordering', () => {
    const rules: StatusRule[] = [
      { status: 'new', when: { item_age_days: { lte: 7 } } },
      { status: 'active', when: { item_age_days: { lte: 30 } } },
      { status: 'inactive', when: 'default' },
    ];
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 5 }))).toBe('new');
    expect(evaluate_status_rules(rules, baseInput({ item_age_days: 20 }))).toBe('active');
  });
});
