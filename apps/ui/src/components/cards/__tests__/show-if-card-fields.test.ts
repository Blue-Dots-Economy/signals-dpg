import { describe, it, expect } from 'vitest';
import { resolveCardFields } from '../resolve-card-fields';

// Licence Number and Licence Type only apply when `category` is `licensed`,
// and `licence_type` sits in the card's default rows.
const schema = {
  type: 'object',
  properties: {
    organisation_name: { type: 'string', title: 'Organisation' },
    category: { type: 'string', title: 'Category', enum: ['individual', 'licensed'] },
    licence_number: { type: 'string', title: 'Licence Number', 'x-show-if': { category: ['licensed'] } },
    licence_type: {
      type: 'string',
      title: 'Licence Type',
      'x-show-if': { category: ['licensed'] },
    },
  },
} as never;

const card = {
  title_field: 'organisation_name',
  default_fields: ['category', 'licence_type'],
};

const keys = (r: ReturnType<typeof resolveCardFields>) => ({
  default: r.defaultRows.map((row) => row.key),
  extra: r.extraRows.map((row) => row.key),
});

describe('resolveCardFields honours x-show-if', () => {
  it('shows the conditional fields when the item satisfies the condition', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', category: 'licensed', licence_number: '42', licence_type: 'Other' },
      card,
    );
    expect(keys(resolved)).toEqual({
      default: ['category', 'licence_type'],
      extra: ['organisation_name', 'licence_number'],
    });
  });

  it('drops an empty conditional default row instead of rendering a placeholder', () => {
    const resolved = resolveCardFields(schema, { organisation_name: 'A', category: 'individual' }, card);
    expect(keys(resolved).default).toEqual(['category']);
  });

  it('hides values left over from before the category changed', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', category: 'individual', licence_number: '42', licence_type: 'Other' },
      card,
    );
    expect(keys(resolved)).toEqual({ default: ['category'], extra: ['organisation_name'] });
  });

  it('hides them under an explicit extra_fields list too', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', category: 'individual', licence_number: '42' },
      { ...card, extra_fields: ['licence_number', 'organisation_name'] },
    );
    expect(keys(resolved).extra).toEqual(['organisation_name']);
  });

  it('leaves a field without x-show-if alone', () => {
    const resolved = resolveCardFields(schema, { organisation_name: 'A' }, card);
    expect(keys(resolved).default).toEqual(['category']);
  });
});
