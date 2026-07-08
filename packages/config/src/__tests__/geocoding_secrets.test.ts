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

  it('rejects a min below the 50m privacy floor (e.g. door precision)', () => {
    expect(() =>
      GeocodingSecretsSchema.parse({ PII_LOCATION_JITTER_MIN_METERS: '1' }),
    ).toThrow();
  });

  it('rejects a max above the 1000m ceiling (e.g. proximity-breaking)', () => {
    expect(() =>
      GeocodingSecretsSchema.parse({ PII_LOCATION_JITTER_MAX_METERS: '5000' }),
    ).toThrow();
  });

  it('accepts the boundary values 50 and 1000', () => {
    const parsed = GeocodingSecretsSchema.parse({
      PII_LOCATION_JITTER_MIN_METERS: '50',
      PII_LOCATION_JITTER_MAX_METERS: '1000',
    });
    expect(parsed.PII_LOCATION_JITTER_MIN_METERS).toBe(50);
    expect(parsed.PII_LOCATION_JITTER_MAX_METERS).toBe(1000);
  });
});
