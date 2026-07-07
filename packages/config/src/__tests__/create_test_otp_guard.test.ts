import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertCreateTestOtpSafe } from '../secrets.js';
import { ConfigError } from '../config_error.js';

afterEach(() => vi.restoreAllMocks());

describe('assertCreateTestOtpSafe', () => {
  it('throws ConfigError when production + CREATE_TEST_OTP=true', () => {
    expect(() => assertCreateTestOtpSafe('production', true)).toThrow(ConfigError);
    expect(() => assertCreateTestOtpSafe('production', true)).toThrow(/production/);
  });

  it('does not throw in production when disabled', () => {
    expect(() => assertCreateTestOtpSafe('production', false)).not.toThrow();
  });

  it('warns (does not throw) in development when enabled', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(() => assertCreateTestOtpSafe('development', true)).not.toThrow();
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.stringContaining('000000'),
      expect.objectContaining({ code: 'CREATE_TEST_OTP_ENABLED' })
    );
  });

  it('is a no-op in development when disabled', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(() => assertCreateTestOtpSafe('development', false)).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
  });
});
