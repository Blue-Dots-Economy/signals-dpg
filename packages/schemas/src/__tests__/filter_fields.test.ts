import { describe, it, expect } from 'vitest';
import {
  expandFilterValues,
  getFilterFieldEntries,
  hasFilterableMarkers,
  isBooleanProperty,
  resolveRangeBuckets,
} from '../filter_fields';

const fields = (schema: unknown) => getFilterFieldEntries(schema).map((e) => e.field);

describe('getFilterFieldEntries (infra#57)', () => {
  it('without any marker keeps every declared, non-private field', () => {
    const schema = {
      properties: {
        natureOfJob: { type: 'string', enum: ['Full-time'] },
        role: { type: 'string' },
        phone: { type: 'string', private: true },
      },
    };
    expect(hasFilterableMarkers(schema)).toBe(false);
    expect(fields(schema)).toEqual(['natureOfJob', 'role']);
  });

  it('once any field is marked, keeps only the marked fields', () => {
    const schema = {
      properties: {
        natureOfJob: { type: 'string', enum: ['Full-time'], filterable: true },
        category: { type: 'string', enum: ['GEN', 'OBC'] },
        isGovernmentJob: { type: 'boolean', filterable: true },
        role: { type: 'string' },
      },
    };
    expect(hasFilterableMarkers(schema)).toBe(true);
    expect(fields(schema)).toEqual(['natureOfJob', 'isGovernmentJob']);
  });

  it('never returns a private field, even when it is marked filterable', () => {
    const schema = {
      properties: {
        gender: { type: 'string', enum: ['Male'], filterable: true },
        phone: { type: 'string', enum: ['1'], private: true, filterable: true },
      },
    };
    expect(fields(schema)).toEqual(['gender']);
  });

  it('treats only a literal `true` as the marker', () => {
    const schema = {
      properties: {
        a: { type: 'string', filterable: 'true' },
        b: { type: 'string', filterable: 1 },
      },
    };
    expect(hasFilterableMarkers(schema)).toBe(false);
    expect(fields(schema)).toEqual(['a', 'b']);
  });

  it('returns nothing for a missing or malformed schema', () => {
    expect(fields(undefined)).toEqual([]);
    expect(fields({})).toEqual([]);
    expect(fields({ properties: [] })).toEqual([]);
    expect(fields({ properties: { a: true, b: null } })).toEqual([]);
  });
});

describe('isBooleanProperty', () => {
  it('detects JSON Schema booleans only', () => {
    expect(isBooleanProperty({ type: 'boolean' })).toBe(true);
    expect(isBooleanProperty({ type: 'string' })).toBe(false);
    expect(isBooleanProperty(null)).toBe(false);
  });
});

describe('x-range-filter (infra#57)', () => {
  const buckets = [
    { label: '0-3 LPA', min: 0, max: 25000 },
    { label: '25+ LPA', min: 208333 },
  ];
  const schemaWith = (rangeFilter: unknown, maxField: Record<string, unknown> = { type: 'number' }) => ({
    properties: {
      salaryMin: { type: 'number', 'x-range-filter': rangeFilter },
      salaryMax: maxField,
    },
  });
  const rangeOf = (schema: unknown) =>
    getFilterFieldEntries(schema).find((e) => e.field === 'salaryMin')?.range;

  it('parses a valid range filter onto the entry', () => {
    expect(rangeOf(schemaWith({ title: 'Salary Ranges', max_field: 'salaryMax', buckets }))).toEqual({
      title: 'Salary Ranges',
      maxField: 'salaryMax',
      buckets,
    });
  });

  it('ignores the marker when max_field is private or undeclared', () => {
    expect(rangeOf(schemaWith({ max_field: 'salaryMax', buckets }, { type: 'number', private: true }))).toBeUndefined();
    expect(rangeOf(schemaWith({ max_field: 'nope', buckets }))).toBeUndefined();
  });

  it('drops buckets with no bound, no label, or min above max', () => {
    const range = rangeOf(
      schemaWith({
        max_field: 'salaryMax',
        buckets: [{ label: 'open' }, { min: 1 }, { label: 'bad', min: 5, max: 1 }, buckets[1]],
      }),
    );
    expect(range?.buckets).toEqual([buckets[1]]);
  });

  it('resolves only declared bucket labels', () => {
    const range = rangeOf(schemaWith({ max_field: 'salaryMax', buckets }))!;
    expect(resolveRangeBuckets(range, ['25+ LPA', '99 LPA'])).toEqual([buckets[1]]);
  });
});

describe('x-filter-include-values (infra#57)', () => {
  const entry = getFilterFieldEntries({
    properties: {
      genderPreference: { type: 'string', enum: ['Male', 'Female', 'Any'], 'x-filter-include-values': ['Any'] },
    },
  })[0];

  it('adds the include values to a selection, without duplicates', () => {
    expect(entry.includeValues).toEqual(['Any']);
    expect(expandFilterValues(entry, ['Female'])).toEqual(['Female', 'Any']);
    expect(expandFilterValues(entry, ['Any'])).toEqual(['Any']);
  });

  it('keeps an empty selection empty', () => {
    expect(expandFilterValues(entry, [])).toEqual([]);
  });
});
