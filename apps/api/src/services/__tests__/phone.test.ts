import { describe, it, expect, vi } from 'vitest';

vi.mock('@/config', () => ({ authConfig: { phone_countries: ['IN'] } }));

import {
  ContactPhoneField,
  MobilePhoneField,
  cleanMobilePhone,
  parseKnownPhone,
} from '@/services/phone';

describe('MobilePhoneField', () => {
  it('cleans a spaced mobile to E.164', () => {
    expect(MobilePhoneField.parse('98765 43210')).toBe('+919876543210');
  });

  it.each([
    ['a landline-range number', '+918020123456'],
    ['a country not listed', '+447400123456'],
    ['letters', '9876543210abc'],
  ])('refuses %s', (_label, raw) => {
    expect(MobilePhoneField.safeParse(raw).success).toBe(false);
  });
});

describe('ContactPhoneField', () => {
  it('accepts a landline, since it is a number to call back', () => {
    expect(ContactPhoneField.parse('+918020123456')).toBe('+918020123456');
  });

  it('still refuses a country not listed', () => {
    expect(ContactPhoneField.safeParse('+447400123456').success).toBe(false);
  });
});

describe('cleanMobilePhone', () => {
  it('passes an absent phone through', () => {
    expect(cleanMobilePhone(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('cleans a spaced mobile and refuses letters or a landline', () => {
    expect(cleanMobilePhone('98765 43210')).toEqual({ ok: true, value: '+919876543210' });
    expect(cleanMobilePhone('9876543210abc').ok).toBe(false);
    expect(cleanMobilePhone('+918020123456').ok).toBe(false);
  });
});

describe('parseKnownPhone', () => {
  it('reads any valid number from any country, for finding stored users', () => {
    expect(parseKnownPhone('+918020123456')).toEqual({ ok: true, value: '+918020123456' });
    expect(parseKnownPhone('+447400123456')).toEqual({ ok: true, value: '+447400123456' });
    expect(parseKnownPhone('+9112345').ok).toBe(false);
  });
});
