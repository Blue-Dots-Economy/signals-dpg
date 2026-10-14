import { describe, it, expect } from 'vitest';
import { humanizeKey, resolveProfileColumns, valueAtPath } from '../columns';

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

describe('humanizeKey', () => {
  it('turns snake_case and camelCase keys into words', () => {
    expect(humanizeKey('service_cities')).toBe('Service Cities');
    expect(humanizeKey('nameOfLastRoleHeld')).toBe('Name Of Last Role Held');
    expect(humanizeKey('item2Type')).toBe('Item2 Type');
  });
});

describe('resolveProfileColumns', () => {
  it('labels a column with the schema title the UI shows, nested as Parent – Child', () => {
    const r = resolveProfileColumns(
      {
        properties: {
          workExperience: { type: 'string', title: 'Work experience' },
          guardian: { type: 'object', title: 'Guardian', properties: { phone: { type: 'string', title: ' Phone ' } } },
        },
      },
      '*'
    );
    expect(r.ok && r.columns.map((c) => c.label)).toEqual(['Work experience', 'Guardian – Phone']);
  });

  it('"*" → every property in schema order, nested objects flattened', () => {
    const r = resolveProfileColumns(schema, '*');
    expect(r).toEqual({
      ok: true,
      columns: [
        { header: 'beneficiary_name', label: 'Beneficiary Name', path: ['beneficiary_name'] },
        { header: 'mobile_number', label: 'Mobile Number', path: ['mobile_number'] },
        { header: 'guardian.name', label: 'Guardian – Name', path: ['guardian', 'name'] },
        { header: 'guardian.phone', label: 'Guardian – Phone', path: ['guardian', 'phone'] },
        { header: 'looking_for', label: 'Looking For', path: ['looking_for'] },
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
    expect(r.ok && r.columns).toEqual([{ header: 'meta', label: 'Meta', path: ['meta'] }]);
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
