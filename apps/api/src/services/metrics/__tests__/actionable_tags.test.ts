import { describe, it, expect } from 'vitest';
import { compute_actionable_tags } from '../actionable_tags.js';

describe('compute_actionable_tags', () => {
  it('returns empty when all required fields are populated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme', phone: '+91...' },
        schema: { required: ['name', 'phone'], properties: { name: {}, phone: {} } },
      }),
    ).toEqual([]);
  });

  it('emits missing_<slugified_field> for each unpopulated required field', () => {
    expect(
      compute_actionable_tags({
        payload: { name: 'Acme' },
        schema: { required: ['name', 'Phone Number', 'email_address'], properties: {} },
      }),
    ).toEqual(['missing_phone_number', 'missing_email_address']);
  });

  it('treats empty strings and empty arrays as unpopulated', () => {
    expect(
      compute_actionable_tags({
        payload: { name: '', tags: [] },
        schema: { required: ['name', 'tags'], properties: {} },
      }),
    ).toEqual(['missing_name', 'missing_tags']);
  });

  it('returns empty when schema has no required fields', () => {
    expect(compute_actionable_tags({ payload: {}, schema: {} })).toEqual([]);
  });
});
