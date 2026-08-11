import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config_error';

describe('ConfigError', () => {
  it('is an Error subclass carrying the given message', () => {
    const err = new ConfigError('CREATE_TEST_OTP must not be enabled');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toBe('CREATE_TEST_OTP must not be enabled');
  });

  it('reports the name "ConfigError" so boot failures are identifiable in logs', () => {
    const err = new ConfigError('boom');

    expect(err.name).toBe('ConfigError');
    expect(String(err)).toBe('ConfigError: boom');
    expect(err.stack).toContain('ConfigError');
  });

  it('is distinguishable from a plain Error when caught', () => {
    const caught = ((): unknown => {
      try {
        throw new ConfigError('unsafe config');
      } catch (err) {
        return err;
      }
    })();

    expect(caught instanceof ConfigError).toBe(true);
    expect(new Error('unsafe config') instanceof ConfigError).toBe(false);
  });
});
