import { describe, it, expect } from 'vitest';
import { profile_completion_pct } from '../profile_completion.js';

const seeker_schema = {
  type: 'object' as const,
  required: ['Full Name', 'Phone Number'],
  properties: {
    'Full Name':     { type: 'string' as const },
    'Phone Number':  { type: 'string' as const },
    'Email Address': { type: 'string' as const },  // optional — ignored by required-only
    'Grade':         { type: 'string' as const },  // optional — ignored by required-only
  },
};

describe('profile_completion_pct (required-only)', () => {
  it('returns 0 when no required field is populated', () => {
    expect(profile_completion_pct({}, seeker_schema)).toBe(0);
  });

  it('returns 100 when all required populated (optionals irrelevant)', () => {
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
    }, seeker_schema)).toBe(100);
  });

  it('1 of 2 required → 50', () => {
    expect(profile_completion_pct({ 'Full Name': 'A' }, seeker_schema)).toBe(50);
  });

  it('optional fields do NOT contribute (still 50 with all optionals filled)', () => {
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Email Address': 'a@b.com',
      'Grade': 'XI',
    }, seeker_schema)).toBe(50);
  });

  it('empty string and empty array are not populated', () => {
    expect(profile_completion_pct(
      { 'Full Name': '', 'Phone Number': [] }, seeker_schema,
    )).toBe(0);
  });

  it('boolean false counts as populated', () => {
    const yn_schema = {
      type: 'object' as const,
      required: ['Open To Remote'],
      properties: { 'Open To Remote': { type: 'boolean' as const } },
    };
    expect(profile_completion_pct({ 'Open To Remote': false }, yn_schema)).toBe(100);
  });

  it('numeric 0 counts as populated', () => {
    const yrs = {
      type: 'object' as const,
      required: ['Years Experience'],
      properties: { 'Years Experience': { type: 'number' as const } },
    };
    expect(profile_completion_pct({ 'Years Experience': 0 }, yrs)).toBe(100);
  });

  it('vacuously complete (no required fields) → 100', () => {
    expect(profile_completion_pct({}, {
      type: 'object' as const,
      required: [],
      properties: { a: { type: 'string' as const } },
    })).toBe(100);
  });

  it('no schema / no required key → 100 (vacuous, matches classifier)', () => {
    expect(profile_completion_pct({ foo: 'bar' }, { type: 'object' as const })).toBe(100);
    expect(profile_completion_pct({ foo: 'bar' }, null)).toBe(100);
    expect(profile_completion_pct({ foo: 'bar' }, undefined)).toBe(100);
  });

  it('null/undefined payload with required fields → 0', () => {
    expect(profile_completion_pct(null, seeker_schema)).toBe(0);
    expect(profile_completion_pct(undefined, seeker_schema)).toBe(0);
  });

  it('extra payload keys are ignored', () => {
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
      'extra_key_not_in_schema': 'whatever',
    }, seeker_schema)).toBe(100);
  });
});
