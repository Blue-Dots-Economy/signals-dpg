import { describe, it, expect } from 'vitest';
import { GeocodingSecretsSchema } from '../secrets';

describe('GeocodingSecretsSchema jitter radii', () => {
  it('defaults to 100/250 when unset', () => {
    const parsed = GeocodingSecretsSchema.parse({});
    expect(parsed.PII_LOCATION_JITTER_MIN_METERS).toBe(100);
    expect(parsed.PII_LOCATION_JITTER_MAX_METERS).toBe(250);
  });

  it('coerces string env values to numbers', () => {
    const parsed = GeocodingSecretsSchema.parse({
      PII_LOCATION_JITTER_MIN_METERS: '150',
      PII_LOCATION_JITTER_MAX_METERS: '400',
    });
    expect(parsed.PII_LOCATION_JITTER_MIN_METERS).toBe(150);
    expect(parsed.PII_LOCATION_JITTER_MAX_METERS).toBe(400);
  });

  it('rejects min greater than max', () => {
    expect(() =>
      GeocodingSecretsSchema.parse({
        PII_LOCATION_JITTER_MIN_METERS: '300',
        PII_LOCATION_JITTER_MAX_METERS: '250',
      }),
    ).toThrow();
  });
});
