import { describe, it, expect } from 'vitest';
import { isValidTimeZone } from '../time_zone';

describe('isValidTimeZone', () => {
  it('accepts IANA zones and UTC, rejects anything else', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
