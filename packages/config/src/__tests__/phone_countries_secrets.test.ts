import { describe, it, expect } from 'vitest';
import { AuthSecretsSchema } from '../secrets';

const base = { AUTH_SECRET: 'test-secret' };

describe('AuthSecretsSchema PHONE_COUNTRIES', () => {
  it('defaults to India when unset or blank', () => {
    expect(AuthSecretsSchema.parse(base).PHONE_COUNTRIES).toEqual(['IN']);
    expect(AuthSecretsSchema.parse({ ...base, PHONE_COUNTRIES: '' }).PHONE_COUNTRIES).toEqual([
      'IN',
    ]);
  });

  it('reads the listed countries, first one first', () => {
    const parsed = AuthSecretsSchema.parse({ ...base, PHONE_COUNTRIES: 'IN:+91,GB:+44' });
    expect(parsed.PHONE_COUNTRIES).toEqual(['IN', 'GB']);
  });

  it.each([
    ['an unknown country', 'IN:+91,XX:+99'],
    ['a wrong dial code', 'IN:+44'],
    ['a malformed separator', 'IN=+91,GB:+44'],
  ])('fails to load with %s, so the api does not start', (_label, value) => {
    expect(() => AuthSecretsSchema.parse({ ...base, PHONE_COUNTRIES: value })).toThrow();
  });
});
