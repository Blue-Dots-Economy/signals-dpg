import { describe, it, expect } from 'vitest';
import { resolve_display_name } from '../resolve_display_name.js';

describe('resolve_display_name', () => {
  it('returns the declared field value when present and non-empty', () => {
    const schema = {
      display_name_field: 'organisation_name',
      properties: { organisation_name: { type: 'string' } },
    };
    expect(
      resolve_display_name({
        schema,
        item_state: { organisation_name: 'Helping Hands' },
        item_id: 'itm_01',
      }),
    ).toBe('Helping Hands');
  });

  it('falls back to item_id when display_name_field is not declared', () => {
    const schema = { properties: { foo: { type: 'string' } } };
    expect(
      resolve_display_name({
        schema,
        item_state: { foo: 'whatever' },
        item_id: 'itm_02',
      }),
    ).toBe('itm_02');
  });

  it('falls back to item_id when value is missing in item_state', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: {}, item_id: 'itm_03' }),
    ).toBe('itm_03');
  });

  it('falls back to item_id when value is empty string (after trim)', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: { name: '   ' }, item_id: 'itm_04' }),
    ).toBe('itm_04');
  });

  it('falls back to item_id when value is null', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: { name: null }, item_id: 'itm_05' }),
    ).toBe('itm_05');
  });

  it('falls back to item_id when item_state is null', () => {
    const schema = { display_name_field: 'name', properties: { name: { type: 'string' } } };
    expect(
      resolve_display_name({ schema, item_state: null, item_id: 'itm_06' }),
    ).toBe('itm_06');
  });

  it('falls back to item_id when value is not a string', () => {
    const schema = { display_name_field: 'count', properties: { count: { type: 'integer' } } };
    expect(
      resolve_display_name({ schema, item_state: { count: 42 }, item_id: 'itm_07' }),
    ).toBe('itm_07');
  });
});
