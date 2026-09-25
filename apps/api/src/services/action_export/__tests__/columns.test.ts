import { describe, it, expect } from 'vitest';
import { resolveProfileColumns, valueAtPath } from '../columns';

const schema = {
  type: 'object',
  properties: {
    beneficiary_name: { type: 'string', private: true },
    mobile_number: { type: 'string', private: true },
    guardian: {
      type: 'object',
      properties: { name: { type: 'string' }, phone: { type: 'string' } },
    },
    looking_for: { type: 'array', items: { type: 'string' } },
  },
};

describe('resolveProfileColumns', () => {
  it('"*" → every property in schema order, nested objects flattened', () => {
    const r = resolveProfileColumns(schema, '*');
    expect(r).toEqual({
      ok: true,
      columns: [
        { header: 'beneficiary_name', path: ['beneficiary_name'] },
        { header: 'mobile_number', path: ['mobile_number'] },
        { header: 'guardian.name', path: ['guardian', 'name'] },
        { header: 'guardian.phone', path: ['guardian', 'phone'] },
        { header: 'looking_for', path: ['looking_for'] },
      ],
    });
  });

  it('a field list keeps schema order and expands a picked object', () => {
    const r = resolveProfileColumns(schema, ['looking_for', 'guardian', 'beneficiary_name']);
    expect(r.ok && r.columns.map((c) => c.header)).toEqual([
      'beneficiary_name',
      'guardian.name',
      'guardian.phone',
      'looking_for',
    ]);
  });

  it('accepts a flattened column name directly', () => {
    const r = resolveProfileColumns(schema, ['guardian.phone']);
    expect(r.ok && r.columns.map((c) => c.header)).toEqual(['guardian.phone']);
  });

  it('reports every unknown field', () => {
    expect(resolveProfileColumns(schema, ['mobile', 'beneficiary_name', 'nme'])).toEqual({
      ok: false,
      unknown: ['mobile', 'nme'],
    });
  });

  it('an object property with no declared sub-properties is one column', () => {
    const r = resolveProfileColumns(
      { type: 'object', properties: { meta: { type: 'object' } } },
      '*'
    );
    expect(r.ok && r.columns).toEqual([{ header: 'meta', path: ['meta'] }]);
  });

  it('a schema with no properties yields no profile columns', () => {
    expect(resolveProfileColumns({ type: 'object' }, '*')).toEqual({ ok: true, columns: [] });
  });
});

describe('valueAtPath', () => {
  it('walks nested objects and tolerates gaps', () => {
    const state = { guardian: { phone: '98' }, a: 1 };
    expect(valueAtPath(state, ['guardian', 'phone'])).toBe('98');
    expect(valueAtPath(state, ['a'])).toBe(1);
    expect(valueAtPath(state, ['guardian', 'name'])).toBeUndefined();
    expect(valueAtPath(state, ['a', 'b'])).toBeUndefined();
  });
});
