import { describe, it, expect } from 'vitest';
import { SignalsSearchSecretsSchema } from '../secrets.js';

describe('SignalsSearchSecretsSchema', () => {
  it('parses and surfaces both vars when set', () => {
    const parsed = SignalsSearchSecretsSchema.parse({
      SIGNALS_SEARCH_URL: 'https://signals-search.example.com',
      SIGNALS_SEARCH_API_KEY: 'test-key-123',
    });

    expect(parsed.SIGNALS_SEARCH_URL).toBe('https://signals-search.example.com');
    expect(parsed.SIGNALS_SEARCH_API_KEY).toBe('test-key-123');
  });

  it('does not throw and leaves both undefined when unset', () => {
    const parsed = SignalsSearchSecretsSchema.parse({});

    expect(parsed.SIGNALS_SEARCH_URL).toBeUndefined();
    expect(parsed.SIGNALS_SEARCH_API_KEY).toBeUndefined();
  });
});
