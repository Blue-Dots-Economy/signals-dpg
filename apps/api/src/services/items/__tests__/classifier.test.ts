import { describe, it, expect } from 'vitest';
import { classify_item } from '../classifier.js';

const schema = (required: string[]) => ({
  type: 'object',
  properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
  required,
});

describe('classify_item', () => {
  it('all required populated + consent accepted → live', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'live' });
  });

  it('all required populated but consent pending → draft', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'draft',
        consent_accepted: false,
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

  it('vacuous required (empty) but consent pending → draft', () => {
    expect(
      classify_item({
        schema: schema([]),
        merged_state: {},
        current_status: 'draft',
        consent_accepted: false,
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

  it('retired is terminal — never recomputes out (complete state + consent)', () => {
    expect(
      classify_item({
        schema: schema(['a', 'b']),
        merged_state: { a: 'x', b: 'y' },
        current_status: 'retired',
        consent_accepted: true,
      }),
    ).toEqual({ lifecycle_status: 'retired' });
  });
});
