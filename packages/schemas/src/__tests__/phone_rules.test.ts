/**
 * Per-country phone rules. The cases match aggregator-dpg's `phone-parse.test.ts`,
 * so both repos accept and refuse the same numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePhone,
  phoneCountryInfo,
  readPhoneCountries,
  PHONE_E164_SHAPE,
  PHONE_INPUT_SHAPE,
  type PhoneRules,
} from '../phone_rules';

const INDIA_MOBILE: PhoneRules = { countries: ['IN'], kind: 'mobile' };
const INDIA_ANY: PhoneRules = { countries: ['IN'], kind: 'any' };
const IN_GB_AU_MOBILE: PhoneRules = {
  countries: ['IN', 'GB', 'AU'],
  kind: 'mobile',
};
const GB_FIRST_MOBILE: PhoneRules = { countries: ['GB', 'IN'], kind: 'mobile' };
const US_MOBILE: PhoneRules = { countries: ['US'], kind: 'mobile' };

describe('parsePhone', () => {
  it.each([
    ['+919876543210'],
    ['9876543210'],
    ['+91 98765 43210'],
    ['987-654-3210'],
    ['(987) 654 3210'],
    ['09876543210'],
    ['00919876543210'],
    ['  +919876543210  '],
  ])('reads %s as +919876543210', (raw) => {
    expect(parsePhone(raw, INDIA_MOBILE)).toEqual({
      ok: true,
      value: '+919876543210',
    });
  });

  it('accepts other listed countries by their own rules', () => {
    expect(parsePhone('+44 7911 123456', IN_GB_AU_MOBILE)).toEqual({
      ok: true,
      value: '+447911123456',
    });
    expect(parsePhone('+61 412 345 678', IN_GB_AU_MOBILE)).toEqual({
      ok: true,
      value: '+61412345678',
    });
  });

  it('refuses a number with too many digits for its country', () => {
    expect(parsePhone('+614123456789', IN_GB_AU_MOBILE)).toMatchObject({
      ok: false,
      error: { reason: 'invalid', message: 'phone is not a valid +61 number' },
    });
    expect(parsePhone('+4479111234567', IN_GB_AU_MOBILE)).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
  });

  it('refuses a country that is not listed', () => {
    expect(parsePhone('+61412345678', INDIA_MOBILE)).toMatchObject({
      ok: false,
      error: {
        reason: 'country_not_allowed',
        message: 'phone numbers starting +61 are not accepted',
      },
    });
  });

  it('allows every country that shares a listed calling code', () => {
    // +44 7911 is a Guernsey range; GB covers all of +44.
    expect(parsePhone('+447911123456', GB_FIRST_MOBILE)).toEqual({
      ok: true,
      value: '+447911123456',
    });
    expect(parsePhone('+1 416 555 0123', US_MOBILE)).toEqual({
      ok: true,
      value: '+14165550123',
    });
  });

  it('reads a number without + in the first listed country', () => {
    expect(parsePhone('07911 123456', GB_FIRST_MOBILE)).toEqual({
      ok: true,
      value: '+447911123456',
    });
    expect(parsePhone('447911123456', INDIA_MOBILE)).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
  });

  it('refuses a landline for a mobile field but takes it for a contact field', () => {
    expect(parsePhone('+915876543210', INDIA_MOBILE)).toMatchObject({
      ok: false,
      error: { reason: 'not_mobile', message: 'phone must be a mobile number' },
    });
    expect(parsePhone('+915876543210', INDIA_ANY)).toEqual({
      ok: true,
      value: '+915876543210',
    });
    expect(parsePhone('080 1234 5678', INDIA_ANY)).toEqual({
      ok: true,
      value: '+918012345678',
    });
  });

  it('takes US numbers, which do not mark mobiles, in a mobile field', () => {
    expect(parsePhone('+1 202 555 0123', US_MOBILE)).toEqual({
      ok: true,
      value: '+12025550123',
    });
  });

  it('refuses a valid number shorter than the 10 digits a stored phone needs', () => {
    expect(parsePhone('+298211234', { countries: ['FO'], kind: 'mobile' })).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
  });

  it('refuses repeated zeros', () => {
    expect(parsePhone('0000000000', INDIA_ANY)).toMatchObject({
      ok: false,
      error: { reason: 'invalid' },
    });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['abc', 'not_a_number'],
    ['++91 98', 'not_a_number'],
  ])('refuses %j as %s', (raw, reason) => {
    expect(parsePhone(raw, INDIA_MOBILE)).toMatchObject({
      ok: false,
      error: { reason },
    });
  });
});

describe('readPhoneCountries', () => {
  it('refuses two countries on one dial code, and countries too short to store', () => {
    expect(readPhoneCountries('US:+1,CA:+1')).toMatchObject({ ok: false });
    expect(readPhoneCountries('IN:+91,FO:+298')).toMatchObject({ ok: false });
  });

  it('caps the phone box at the longest mobile or landline', () => {
    expect(phoneCountryInfo('IN').nationalDigits).toBe(10);
    expect(phoneCountryInfo('GB').nationalDigits).toBe(10);
    expect(phoneCountryInfo('AT').nationalDigits).toBe(13);
    expect(phoneCountryInfo('DE').nationalDigits).toBe(13); // E.164 allows 15 digits with the code
  });

  it.each([[undefined], [''], ['  ']])('defaults %j to India', (raw) => {
    expect(readPhoneCountries(raw)).toEqual({ ok: true, value: ['IN'] });
  });

  it('keeps the order, so the first entry is the default', () => {
    expect(readPhoneCountries('GB:+44, IN:+91,au:61')).toEqual({
      ok: true,
      value: ['GB', 'IN', 'AU'],
    });
  });

  it.each([
    ['IN=+91,GB:+44', 'is not in the form XX:+NN'],
    ['XX:+99', 'has an unknown country XX'],
    ['GB:+91', 'has the wrong dial code; GB is +44'],
    ['IN:+91,IN:+91', 'is listed twice'],
    ['IN:+91,', 'is not in the form XX:+NN'],
  ])('refuses %j', (raw, why) => {
    const result = readPhoneCountries(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(why);
  });
});

describe('phoneCountryInfo', () => {
  it.each([
    ['IN', '+91', 10],
    ['GB', '+44', 10],
    ['AU', '+61', 9],
    ['SG', '+65', 8],
  ] as const)('describes %s', (iso, code, digits) => {
    const info = phoneCountryInfo(iso);
    expect(info).toMatchObject({ iso, code, nationalDigits: digits });
    expect(info.sample).toHaveLength(digits);
    expect(parsePhone(`${code}${info.sample}`, { countries: [iso], kind: 'mobile' }).ok).toBe(true);
  });
});

describe('shapes', () => {
  it('PHONE_E164_SHAPE takes only + and 10-15 digits', () => {
    expect(PHONE_E164_SHAPE.test('+6581234567')).toBe(true);
    for (const bad of ['919876543210', '+0123456789', '+9112345', '+1234567890123456']) {
      expect(PHONE_E164_SHAPE.test(bad)).toBe(false);
    }
  });

  it('PHONE_INPUT_SHAPE takes typed spacing and punctuation', () => {
    expect(PHONE_INPUT_SHAPE.test('+91 (98765) 43-210')).toBe(true);
    expect(PHONE_INPUT_SHAPE.test('98765abc')).toBe(false);
  });
});
