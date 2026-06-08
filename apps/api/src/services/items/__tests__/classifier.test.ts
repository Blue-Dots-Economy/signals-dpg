import { describe, it, expect } from 'vitest';
import { classify_item } from '../classifier.js';

const schema = (required: string[]) => ({
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  required,
});

describe('classify_item', () => {
  it('all required populated → live, 100', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('one of two required missing → draft, 50', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'draft', completion_pct: 50 });
  });

  it('vacuous required (empty) → live, 100', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('paused is sticky against the classifier; pct still recomputes', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'paused',
      }),
    ).toEqual({ lifecycle_status: 'paused', completion_pct: 100 });
  });

  it('optional fields contribute 0 to completion_pct', () => {
    expect(
      classify_item({
        schema: schema(['a']),
        merged_state: { a: 'x', b: 'y', c: 'z' },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('empty string + empty array are not populated', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: '', b: [] },
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'draft', completion_pct: 0 });
  });

  it('schema with no required key → vacuous live', () => {
    expect(
      classify_item({
        schema: { type: 'object', properties: {} },
        merged_state: {},
        current_status: 'draft',
      }),
    ).toEqual({ lifecycle_status: 'live', completion_pct: 100 });
  });

  it('paused is sticky even when required incomplete', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x' },
        current_status: 'paused',
      }),
    ).toEqual({ lifecycle_status: 'paused', completion_pct: 50 });
  });
});
