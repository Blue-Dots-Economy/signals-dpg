import { describe, it, expect } from 'vitest';
import { resolveCardFields } from '../resolve-card-fields';

// ALIMCO providers: CRR Number and Type of Professional only apply to an RCI
// provider, and `professional_type` sits in the card's default rows.
const schema = {
  type: 'object',
  properties: {
    organisation_name: { type: 'string', title: 'Organisation' },
    provider_category: { type: 'string', title: 'Category', enum: ['NGO', 'RCI'] },
    crr_number: { type: 'string', title: 'CRR Number', 'x-show-if': { provider_category: ['RCI'] } },
    professional_type: {
      type: 'string',
      title: 'Type of Professional',
      'x-show-if': { provider_category: ['RCI'] },
    },
  },
} as never;

const card = {
  title_field: 'organisation_name',
  default_fields: ['provider_category', 'professional_type'],
};

const keys = (r: ReturnType<typeof resolveCardFields>) => ({
  default: r.defaultRows.map((row) => row.key),
  extra: r.extraRows.map((row) => row.key),
});

describe('resolveCardFields honours x-show-if', () => {
  it('shows the conditional fields when the item satisfies the condition', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', provider_category: 'RCI', crr_number: '42', professional_type: 'Other' },
      card,
    );
    expect(keys(resolved)).toEqual({
      default: ['provider_category', 'professional_type'],
      extra: ['organisation_name', 'crr_number'],
    });
  });

  it('drops an empty conditional default row instead of rendering a placeholder', () => {
    const resolved = resolveCardFields(schema, { organisation_name: 'A', provider_category: 'NGO' }, card);
    expect(keys(resolved).default).toEqual(['provider_category']);
  });

  it('hides values left over from before the category changed', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', provider_category: 'NGO', crr_number: '42', professional_type: 'Other' },
      card,
    );
    expect(keys(resolved)).toEqual({ default: ['provider_category'], extra: ['organisation_name'] });
  });

  it('hides them under an explicit extra_fields list too', () => {
    const resolved = resolveCardFields(
      schema,
      { organisation_name: 'A', provider_category: 'NGO', crr_number: '42' },
      { ...card, extra_fields: ['crr_number', 'organisation_name'] },
    );
    expect(keys(resolved).extra).toEqual(['organisation_name']);
  });

  it('leaves a field without x-show-if alone', () => {
    const resolved = resolveCardFields(schema, { organisation_name: 'A' }, card);
    expect(keys(resolved).default).toEqual(['provider_category']);
  });
});
