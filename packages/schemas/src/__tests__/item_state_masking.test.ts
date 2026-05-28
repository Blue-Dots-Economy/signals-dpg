import { describe, expect, it } from 'vitest';
import { maskPrivateState } from '../item_state_masking';

const profileSchema = {
  type: 'object',
  properties: {
    email:    { type: 'string', format: 'email',   private: true },
    phone:    { type: 'string', format: 'phone',   private: true },
    dob:      { type: 'string',                    private: true },
    name:     { type: 'string',                    private: true },
    aadhaar:  { type: 'string',                    private: true },
    bio:      { type: 'string',                    private: true },
    address: {
      type: 'object', private: true,
      properties: {
        line1: { type: 'string' },
        city:  { type: 'string' },
      },
    },
    references: {
      type: 'array', private: true,
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } },
      },
    },
  },
} as const;

describe('maskPrivateState', () => {
  it('masks an email by format', () => {
    const out = maskPrivateState(profileSchema, { email: 'aniket@example.com' });
    expect(out.email).toBe('a***@example.com');
  });

  it('masks a phone by format with last 4 visible', () => {
    const out = maskPrivateState(profileSchema, { phone: '+919876543210' });
    expect(out.phone).toBe('+91-XX-XXXX-X3210');
  });

  it('masks a dob by key-name heuristic', () => {
    const out = maskPrivateState(profileSchema, { dob: '1990-01-15' });
    expect(out.dob).toBe('XXXX-XX-XX');
  });

  it('masks a name by key-name heuristic', () => {
    const out = maskPrivateState(profileSchema, { name: 'Aniket' });
    expect(out.name).toBe('A***');
  });

  it('masks an aadhaar by key-name heuristic with last 4 visible', () => {
    const out = maskPrivateState(profileSchema, { aadhaar: '123456789012' });
    expect(out.aadhaar).toBe('XXXXXXXX9012');
  });

  it('falls back to length-preserving X for unknown fields', () => {
    const out = maskPrivateState(profileSchema, { bio: 'hello' });
    expect(out.bio).toBe('XXXXX');
  });

  it('recurses into nested object schemas', () => {
    const out = maskPrivateState(profileSchema, {
      address: { line1: '221B Baker St', city: 'London' },
    });
    expect(out.address).toEqual({
      line1: 'XXXXXXXXXXXXX',
      city:  'XXXXXX',
    });
  });

  it('recurses into arrays of objects', () => {
    const out = maskPrivateState(profileSchema, {
      references: [
        { name: 'Watson', email: 'w@x.com' },
        { name: 'Holmes', email: 'h@y.org' },
      ],
    });
    expect(out.references).toEqual([
      { name: 'W***', email: 'w***@x.com' },
      { name: 'H***', email: 'h***@y.org' },
    ]);
  });

  it('passes null and undefined through unchanged', () => {
    const out = maskPrivateState(profileSchema, { email: null, phone: undefined });
    expect(out.email).toBeNull();
    expect(out.phone).toBeUndefined();
  });

  it('stringifies non-string scalars before masking', () => {
    const schema = { type: 'object', properties: { age: { type: 'number', private: true } } };
    const out = maskPrivateState(schema, { age: 42 });
    expect(out.age).toBe('XX');
  });
});
