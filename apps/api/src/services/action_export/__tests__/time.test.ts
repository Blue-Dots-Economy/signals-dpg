import { describe, it, expect } from 'vitest';
import { formatIsoInZone, filenameStamp, isValidTimeZone } from '../time';

// #771 follow-up: EXPORT_TIMEZONE — export timestamps in a configured zone,
// always carrying their offset so they stay unambiguous.

const at = new Date('2026-09-25T06:39:43.123Z');

describe('formatIsoInZone', () => {
  it('UTC keeps the Z form', () => {
    expect(formatIsoInZone(at, 'UTC')).toBe('2026-09-25T06:39:43Z');
  });

  it('Asia/Kolkata → local wall time with +05:30', () => {
    expect(formatIsoInZone(at, 'Asia/Kolkata')).toBe('2026-09-25T12:09:43+05:30');
  });

  it('negative offsets and date rollover', () => {
    expect(formatIsoInZone(new Date('2026-01-01T02:00:00Z'), 'America/New_York')).toBe(
      '2025-12-31T21:00:00-05:00'
    );
  });

  it('follows daylight saving', () => {
    expect(formatIsoInZone(new Date('2026-07-01T12:00:00Z'), 'Europe/London')).toBe(
      '2026-07-01T13:00:00+01:00'
    );
    expect(formatIsoInZone(new Date('2026-01-01T12:00:00Z'), 'Europe/London')).toBe(
      '2026-01-01T12:00:00Z'
    );
  });

  it('midnight renders as 00, not 24', () => {
    expect(formatIsoInZone(new Date('2026-09-24T18:30:00Z'), 'Asia/Kolkata')).toBe(
      '2026-09-25T00:00:00+05:30'
    );
  });
});

describe('filenameStamp', () => {
  it('no colons (Windows-safe); offset compact', () => {
    expect(filenameStamp(at, 'UTC')).toBe('2026-09-25T06-39-43Z');
    expect(filenameStamp(at, 'Asia/Kolkata')).toBe('2026-09-25T12-09-43+0530');
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and UTC, rejects junk', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('IST+5')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
