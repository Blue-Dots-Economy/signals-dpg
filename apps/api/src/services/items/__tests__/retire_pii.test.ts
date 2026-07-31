import { describe, it, expect } from 'vitest';
import { buildRetiredItemState } from '../retire_pii.js';

// name/email/phone are private:true (the usual PII model); headline/bio are
// public; skills is a public array kept on retire.
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', private: true },
    email: { type: 'string', private: true },
    phone: { type: 'string', private: true },
    headline: { type: 'string' },
    bio: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
  },
} as Record<string, unknown>;

describe('buildRetiredItemState', () => {
  it('drops private:true fields and keeps non-PII public fields', () => {
    const stored = {
      // private fields appear here as masked placeholders in real storage
      name: '***',
      email: '***',
      phone: '***',
      headline: 'Senior plumber',
      bio: '10 years experience',
      skills: ['pipes', 'welding'],
    };
    expect(buildRetiredItemState(schema, stored)).toEqual({
      headline: 'Senior plumber',
      bio: '10 years experience',
      skills: ['pipes', 'welding'],
    });
  });

  it('scrubs identity keys even when the schema left them public (backstop)', () => {
    const publicSchema = {
      type: 'object',
      properties: {
        name: { type: 'string' }, // NOT marked private
        phone_number: { type: 'string' },
        headline: { type: 'string' },
      },
    } as Record<string, unknown>;
    const stored = { name: 'Asha', phone_number: '+919876543210', headline: 'Tutor' };
    expect(buildRetiredItemState(publicSchema, stored)).toEqual({ headline: 'Tutor' });
  });

  it('drops a NESTED non-private identity field (e.g. contact.name)', () => {
    const nestedSchema = {
      type: 'object',
      properties: {
        headline: { type: 'string' },
        contact: {
          type: 'object',
          properties: {
            name: { type: 'string' }, // nested, NOT private
            city: { type: 'string' },
          },
        },
      },
    } as Record<string, unknown>;
    const stored = { headline: 'Tutor', contact: { name: 'Asha', city: 'Pune' } };
    expect(buildRetiredItemState(nestedSchema, stored)).toEqual({
      headline: 'Tutor',
      contact: { city: 'Pune' },
    });
  });

  it('drops unknown/extra keys not declared in the schema', () => {
    const stored = {
      headline: 'Plumber',
      skills: ['pipes'],
      secret_note: 'call me at 99999', // not in schema → must be dropped
    };
    expect(buildRetiredItemState(schema, stored)).toEqual({
      headline: 'Plumber',
      skills: ['pipes'],
    });
  });

  it('returns an empty object when the schema is unknown (fail-safe, no leak)', () => {
    expect(buildRetiredItemState(null, { name: 'x', anything: 'y' })).toEqual({});
  });
});
