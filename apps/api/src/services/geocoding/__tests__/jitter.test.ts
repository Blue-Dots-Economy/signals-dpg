import { describe, it, expect } from 'vitest';
import { jitterCoordinate } from '../jitter';

// Haversine distance in metres between two coords.
function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const ORIGIN = { lat: 12.9716, lng: 77.5946 }; // Bangalore
const SECRET = Buffer.alloc(32, 0x42);

describe('jitterCoordinate', () => {
  it('offsets within [min, max] metres', () => {
    const out = jitterCoordinate(ORIGIN, 100, 250, SECRET);
    const d = distanceMeters(ORIGIN, out);
    expect(d).toBeGreaterThanOrEqual(100 - 1); // ~1m tolerance for haversine vs equirect
    expect(d).toBeLessThanOrEqual(250 + 1);
  });

  it('is deterministic for the same coordinate', () => {
    expect(jitterCoordinate(ORIGIN, 100, 250, SECRET)).toEqual(jitterCoordinate(ORIGIN, 100, 250, SECRET));
  });

  it('produces a different point from the input', () => {
    const out = jitterCoordinate(ORIGIN, 100, 250, SECRET);
    expect(out.lat === ORIGIN.lat && out.lng === ORIGIN.lng).toBe(false);
  });

  it('preserves label', () => {
    const out = jitterCoordinate({ ...ORIGIN, label: 'Home' }, 100, 250, SECRET);
    expect(out.label).toBe('Home');
  });

  it('omits label when absent', () => {
    expect('label' in jitterCoordinate(ORIGIN, 100, 250, SECRET)).toBe(false);
  });

  it('stays in range across many distinct points and high latitude', () => {
    for (let i = 0; i < 200; i++) {
      const c = { lat: 55 + i * 0.01, lng: -3 + i * 0.017 };
      const d = distanceMeters(c, jitterCoordinate(c, 100, 250, SECRET));
      expect(d).toBeGreaterThanOrEqual(100 - 2);
      expect(d).toBeLessThanOrEqual(250 + 2);
    }
  });

  it('produces a different point for a different secret', () => {
    const a = jitterCoordinate(ORIGIN, 100, 250, Buffer.alloc(32, 0x01));
    const b = jitterCoordinate(ORIGIN, 100, 250, Buffer.alloc(32, 0x02));
    expect(a.lat === b.lat && a.lng === b.lng).toBe(false);
  });

  it('handles a degenerate min==max radius (fixed distance)', () => {
    const d = distanceMeters(ORIGIN, jitterCoordinate(ORIGIN, 150, 150, SECRET));
    expect(d).toBeGreaterThanOrEqual(150 - 2);
    expect(d).toBeLessThanOrEqual(150 + 2);
  });
});
