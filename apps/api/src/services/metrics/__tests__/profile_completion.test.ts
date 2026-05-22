import { describe, it, expect } from 'vitest';
import { profile_completion_pct } from '../profile_completion.js';

const seeker_schema = {
  type: 'object' as const,
  required: ['Full Name', 'Phone Number'],
  properties: {
    'Full Name':     { type: 'string' as const },
    'Phone Number':  { type: 'string' as const },
    'Email Address': { type: 'string' as const },  // optional
    'Grade':         { type: 'string' as const },  // optional
  },
};

describe('profile_completion_pct', () => {
  it('returns 0 for empty payload', () => {
    expect(profile_completion_pct({}, seeker_schema)).toBe(0);
  });

  it('returns 100 when all required + all optional populated', () => {
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
      'Email Address': 'a@b.com',
      'Grade': 'XI',
    }, seeker_schema)).toBe(100);
  });

  it('weights required as 1.0 and optional as 0.5', () => {
    // 2 required filled (weight 2.0) of total weight 3.0 = 66.67 → 67
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
    }, seeker_schema)).toBe(67);
  });

  it('half-completed optional weighted correctly', () => {
    // 2 required (2.0) + 1 optional (0.5) of total 3.0 = 83.33 → 83
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
      'Email Address': 'a@b.com',
    }, seeker_schema)).toBe(83);
  });

  it('caps at 100', () => {
    const optional_only = {
      type: 'object' as const,
      required: [],
      properties: { a: { type: 'string' as const }, b: { type: 'string' as const } },
    };
    expect(profile_completion_pct({ a: 'x', b: 'y' }, optional_only)).toBe(100);
  });

  it('treats empty string and empty array as not populated', () => {
    expect(profile_completion_pct(
      { 'Full Name': '', 'Phone Number': [] }, seeker_schema,
    )).toBe(0);
  });

  it('treats boolean false as populated', () => {
    const yn_schema = {
      type: 'object' as const,
      required: ['Open To Remote'],
      properties: { 'Open To Remote': { type: 'boolean' as const } },
    };
    expect(profile_completion_pct({ 'Open To Remote': false }, yn_schema)).toBe(100);
  });

  it('treats numeric 0 as populated', () => {
    const yrs = {
      type: 'object' as const,
      required: ['Years Experience'],
      properties: { 'Years Experience': { type: 'number' as const } },
    };
    expect(profile_completion_pct({ 'Years Experience': 0 }, yrs)).toBe(100);
  });

  it('returns 0 when schema has no properties', () => {
    expect(profile_completion_pct({ foo: 'bar' }, {
      type: 'object' as const,
    })).toBe(0);
  });

  it('returns 0 when schema is null/undefined', () => {
    expect(profile_completion_pct({ foo: 'bar' }, null)).toBe(0);
    expect(profile_completion_pct({ foo: 'bar' }, undefined)).toBe(0);
  });

  it('returns 0 when payload is null/undefined', () => {
    expect(profile_completion_pct(null, seeker_schema)).toBe(0);
    expect(profile_completion_pct(undefined, seeker_schema)).toBe(0);
  });

  it('only counts keys that exist in schema.properties (ignores extra payload keys)', () => {
    // extra key in payload should NOT inflate completion
    expect(profile_completion_pct({
      'Full Name': 'A',
      'Phone Number': '9876543210',
      'extra_key_not_in_schema': 'whatever',
    }, seeker_schema)).toBe(67);
  });
});
