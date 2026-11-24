/**
 * Runs the shared phone cases: a copy of bluedots-schemas `schemas/phone-cases.json`.
 * CI fails when the copy differs from that file.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { isSupportedCountry, type CountryCode } from 'libphonenumber-js/max';
import { parsePhone, readPhoneCountries } from '../phone_rules';

const Country = z.custom<CountryCode>((v) => typeof v === 'string' && isSupportedCountry(v));

const PhoneCases = z.object({
  parse: z.array(
    z.object({
      input: z.string(),
      countries: z.tuple([Country], Country),
      kind: z.enum(['mobile', 'any']),
      value: z.string().optional(),
      reason: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  countryLists: z.array(
    z.object({
      input: z.string(),
      value: z.array(z.string()).optional(),
      valid: z.literal(false).optional(),
    }),
  ),
});

const cases = PhoneCases.parse(
  JSON.parse(readFileSync(new URL('./fixtures/phone-cases.json', import.meta.url), 'utf8')),
);

describe('shared phone cases', () => {
  it.each(cases.parse)('parses $input for $countries as $kind', (c) => {
    const result = parsePhone(c.input, { countries: c.countries, kind: c.kind });
    if (c.value !== undefined) {
      expect(result).toEqual({ ok: true, value: c.value });
    } else {
      expect(result).toMatchObject({
        ok: false,
        error: { reason: c.reason, ...(c.message ? { message: c.message } : {}) },
      });
    }
  });

  it.each(cases.countryLists)('reads PHONE_COUNTRIES $input', (c) => {
    const result = readPhoneCountries(c.input);
    if (c.valid === false) expect(result.ok).toBe(false);
    else expect(result).toEqual({ ok: true, value: c.value });
  });
});
