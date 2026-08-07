import { describe, expect, it } from 'vitest';
import { maskPrivateState } from '../item_state_masking';

const schema = {
  type: 'object',
  properties: {
    email: { type: 'string', format: 'email', private: true },
    phone: { type: 'string', format: 'tel', private: true },
    name: { type: 'string', private: true },
    passport: { type: 'string', private: true },
    // A `format` that is not a string must be ignored by the format lookup.
    weird: { type: 'string', format: 42, private: true },
  },
} as const;

describe('maskPrivateState boundary values', () => {
  it('substitutes X for a missing email local part', () => {
    expect(maskPrivateState(schema, { email: '@example.com' }).email).toBe('X***@example.com');
  });

  it('emits an empty domain when the email has no @', () => {
    expect(maskPrivateState(schema, { email: 'nope' }).email).toBe('n***@');
  });

  it('leaves a phone of 3 characters or fewer untouched (nothing to hide)', () => {
    expect(maskPrivateState(schema, { phone: '911' }).phone).toBe('911');
    expect(maskPrivateState(schema, { phone: '9' }).phone).toBe('9');
  });

  it('masks a 4-character phone as first-3 + ***', () => {
    expect(maskPrivateState(schema, { phone: '9110' }).phone).toBe('911***');
  });

  it('returns an empty string for an empty name rather than a bare ***', () => {
    expect(maskPrivateState(schema, { name: '' }).name).toBe('');
  });

  it('reveals only the last 4 digits of a government id, padding to the original length', () => {
    expect(maskPrivateState(schema, { passport: 'A1234567' }).passport).toBe('XXXX4567');
  });

  it('emits no visible tail for a government id with fewer than 4 digits', () => {
    // digits = '1', tail = '1', so 'X'.repeat(len - 1) + '1'.
    expect(maskPrivateState(schema, { passport: 'AB-1' }).passport).toBe('XXX1');
  });

  it('fully redacts a government id that contains no digits at all', () => {
    expect(maskPrivateState(schema, { passport: 'PENDING' }).passport).toBe('XXXXXXX');
  });

  it('ignores a non-string format marker and falls back to key/first-char rules', () => {
    expect(maskPrivateState(schema, { weird: 'zebra' }).weird).toBe('z***');
  });

  it('masks boolean and numeric leaves via their string form', () => {
    const s = {
      type: 'object',
      properties: { verified: { type: 'boolean' }, score: { type: 'number' } },
    };
    const out = maskPrivateState(s, { verified: true, score: 0 });
    expect(out.verified).toBe('t***');
    expect(out.score).toBe('0***');
  });

  it('recurses into a nested object even when the parent has no declared properties', () => {
    const out = maskPrivateState({ type: 'object' }, { extra: { street: 'Baker St', zip: '12345' } });
    expect(out.extra).toEqual({ street: '***', zip: '1***' });
  });
});
