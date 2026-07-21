import { describe, it, expect } from 'vitest';
import { classify_item } from '../classifier.js';

const schema = (required: string[]) => ({
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  required,
});

const BOTH_GATES = ['schema_required', 'consent_required'] as const;

describe('classify_item', () => {
  it('all required populated + consent accepted → live', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: true,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('all required populated but consent pending → draft (consent_required gate)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('one of two required missing (consent accepted) → draft', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('vacuous required (empty) + consent accepted → live', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('vacuous required (empty) but consent pending, consent_required gate → draft', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
        consent_accepted: false,
        gates: BOTH_GATES,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('paused is sticky against the classifier (complete state + consent)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });

  it('optional fields do not affect live/draft (only required counts)', () => {
    expect(
      classify_item({
        schema: schema(['a']),
        merged_state: { a: 'x', b: 'y', c: 'z' },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('empty string + empty array are not populated → draft', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: '', b: [] },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('schema with no required key + consent accepted → vacuous live', () => {
    expect(
      classify_item({
        schema: { type: 'object', properties: {} },
        merged_state: {},
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('paused is sticky even when required incomplete', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'paused',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });
});

describe('classify_item — config-driven gates (go_live_required)', () => {
  it('default gates = schema_required only: complete + consent pending → live', () => {
    // No `gates` → DEFAULT_GO_LIVE_GATES (schema_required). Consent is ignored.
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('consent_required only: incomplete required but consent satisfied → live', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' }, // b missing — schema_required NOT a gate here
        current_status: 'draft',
        consent_accepted: true,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('consent_required only: consent not satisfied → draft even if complete', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'draft' });
  });

  it('both gates: needs complete AND consent', () => {
    const both = (state: Record<string, unknown>, consent: boolean) =>
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: state,
        current_status: 'draft',
        consent_accepted: consent,
        gates: BOTH_GATES,
      }).lifecycle_status;
    expect(both({ a: 'x', b: 'y' }, true)).toBe('live');
    expect(both({ a: 'x', b: 'y' }, false)).toBe('draft');
    expect(both({ a: 'x' }, true)).toBe('draft');
  });

  it('paused stays sticky regardless of which gates are configured', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
        consent_accepted: true,
        gates: ['consent_required'],
      }),
    ).toEqual({ lifecycle_status: 'paused' });
  });
});
