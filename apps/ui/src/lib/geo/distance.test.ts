import { describe, it, expect } from 'vitest';
import { haversineMeters, nearestDistanceMeters } from './distance';

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9716, lng: 77.5946 })).toBe(0);
  });

  it('matches a known reference distance (approximately)', () => {
    // Bengaluru MG Road ↔ Whitefield, ~15.5 km apart.
    const mgRoad = { lat: 12.9758, lng: 77.6045 };
    const whitefield = { lat: 12.9698, lng: 77.75 };
    const meters = haversineMeters(mgRoad, whitefield);
    expect(meters).toBeGreaterThan(14_000);
    expect(meters).toBeLessThan(17_000);
  });

  it('computes the half-diagonal radius from a map center to a bounds corner', () => {
    // Simulates MapView's viewport emission: center of the visible map vs. the
    // north-east corner of `map.getBounds()`. The result should be a sensible,
    // strictly-positive radius that scales with how "zoomed out" the bounds are.
    const center = { lat: 20.5937, lng: 78.9629 };
    const tightCorner = { lat: 20.6937, lng: 79.0629 }; // ~0.1° away (city-level zoom)
    const wideCorner = { lat: 25.5937, lng: 83.9629 }; // ~5° away (region-level zoom)

    const tightRadius = haversineMeters(center, tightCorner);
    const wideRadius = haversineMeters(center, wideCorner);

    expect(tightRadius).toBeGreaterThan(0);
    expect(wideRadius).toBeGreaterThan(tightRadius);
  });

  it('is symmetric', () => {
    const a = { lat: 28.6139, lng: 77.209 };
    const b = { lat: 19.076, lng: 72.8777 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('nearestDistanceMeters', () => {
  it('returns Infinity when there are no locations', () => {
    expect(nearestDistanceMeters({ lat: 0, lng: 0 }, undefined)).toBe(Infinity);
    expect(nearestDistanceMeters({ lat: 0, lng: 0 }, [])).toBe(Infinity);
  });

  it('returns the distance to the closest of several locations', () => {
    const from = { lat: 0, lng: 0 };
    const near = { lat: 0.01, lng: 0.01 };
    const far = { lat: 10, lng: 10 };
    expect(nearestDistanceMeters(from, [far, near])).toBeCloseTo(haversineMeters(from, near), 6);
  });
});
