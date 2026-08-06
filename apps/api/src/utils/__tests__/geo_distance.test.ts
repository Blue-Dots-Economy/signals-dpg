import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  nearestLocationMeters,
  nearestDistanceMeters,
} from '../geo_distance.js';

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    const p = { lat: 12.9716, lng: 77.5946 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('returns ~556m for two points 0.005 degrees of latitude apart', () => {
    // 1 degree of latitude ≈ 111,320m (mean earth radius 6371000).
    // 0.005 deg * 111,319.49... ≈ 556.6m.
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.005, lng: 0 };
    const d = haversineMeters(a, b);
    expect(d).toBeGreaterThan(550);
    expect(d).toBeLessThan(563);
  });

  it('is symmetric', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: -5, lng: 30 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  it('handles antipodal-ish long distances without throwing', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0, lng: 179.9 };
    const d = haversineMeters(a, b);
    // Half the earth's circumference is ~20,015,086m.
    expect(d).toBeGreaterThan(19_900_000);
    expect(d).toBeLessThan(20_020_000);
  });
});

describe('nearestLocationMeters', () => {
  it('returns Infinity when locations is empty (sorts last)', () => {
    const center = { lat: 0, lng: 0 };
    expect(nearestLocationMeters(center, [])).toBe(Infinity);
  });

  it('returns the single distance when only one location is given', () => {
    const center = { lat: 0, lng: 0 };
    const loc = { lat: 0.005, lng: 0 };
    expect(nearestLocationMeters(center, [loc])).toBeCloseTo(
      haversineMeters(center, loc),
      6
    );
  });

  it('picks the minimum distance across multiple locations', () => {
    const center = { lat: 0, lng: 0 };
    const near = { lat: 0.001, lng: 0 }; // ~111m
    const mid = { lat: 0.01, lng: 0 }; // ~1113m
    const far = { lat: 1, lng: 0 }; // ~111km
    const nearest = nearestLocationMeters(center, [far, mid, near]);
    expect(nearest).toBeCloseTo(haversineMeters(center, near), 6);
  });

  it('returns 0 when one of the locations is the center itself', () => {
    const center = { lat: 12.9716, lng: 77.5946 };
    const far = { lat: 40, lng: -70 };
    expect(nearestLocationMeters(center, [far, center])).toBe(0);
  });
});

// #439 Task 7: item-to-item nearest distance (both sides are arrays of
// locations — a counterparty item can carry multiple points, unlike the
// single-center `nearestLocationMeters` above used by the cross-instance
// merge). Null-safe: returns null (never Infinity) when either side has no
// locations, so the caller can render "distance unknown" instead of a sort
// key that silently pushes the row to the back.
describe('nearestDistanceMeters', () => {
  it('returns the minimum pairwise haversine distance across both location sets', () => {
    const mine = [{ lat: 0, lng: 0 }];
    const theirsNear = { lat: 0.001, lng: 0 }; // ~111m
    const theirsFar = { lat: 1, lng: 0 }; // ~111km
    const theirs = [theirsFar, theirsNear];
    expect(nearestDistanceMeters(mine, theirs)).toBeCloseTo(
      haversineMeters(mine[0], theirsNear),
      6
    );
  });

  it('returns null when the first list is empty', () => {
    expect(nearestDistanceMeters([], [{ lat: 0, lng: 0 }])).toBeNull();
  });

  it('returns null when the second list is empty', () => {
    expect(nearestDistanceMeters([{ lat: 0, lng: 0 }], [])).toBeNull();
  });

  it('returns null when either list is null or undefined', () => {
    expect(nearestDistanceMeters(null, [{ lat: 0, lng: 0 }])).toBeNull();
    expect(nearestDistanceMeters([{ lat: 0, lng: 0 }], undefined)).toBeNull();
    expect(nearestDistanceMeters(undefined, null)).toBeNull();
  });

  it('returns 0 when the same point appears in both lists', () => {
    const p = { lat: 12.9716, lng: 77.5946 };
    expect(nearestDistanceMeters([{ lat: 40, lng: -70 }, p], [p])).toBe(0);
  });
});
