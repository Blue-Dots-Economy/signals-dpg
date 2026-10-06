import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  geocodingConfig: { country: undefined as string | undefined, boundary_path: undefined as string | undefined },
}));
vi.mock('@/config', () => cfg);

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBoundary,
  isPointInBoundary,
  findLocationOutsideCountry,
  loadCountryBoundary,
  resetCountryBoundaryForTests,
} from '../country_boundary';

// A 10°×10° square (lng 70–80, lat 10–20) with a 2°×2° hole (lng 74–76, lat 14–16),
// plus a separate 1°×1° "island" (lng 90–91, lat 10–11).
const square = [[70, 10], [80, 10], [80, 20], [70, 20], [70, 10]];
const hole = [[74, 14], [76, 14], [76, 16], [74, 16], [74, 14]];
const island = [[90, 10], [91, 10], [91, 11], [90, 11], [90, 10]];
const geojson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { ISO_A2: 'IN' },
      geometry: { type: 'MultiPolygon', coordinates: [[square, hole], [island]] },
    },
  ],
};

describe('parseBoundary', () => {
  it('accepts a FeatureCollection, a Feature, and bare Polygon/MultiPolygon geometry', () => {
    expect(parseBoundary(geojson)).toHaveLength(2);
    expect(parseBoundary(geojson.features[0])).toHaveLength(2);
    expect(parseBoundary({ type: 'Polygon', coordinates: [square] })).toHaveLength(1);
  });

  it('throws on anything without polygon geometry', () => {
    expect(() => parseBoundary({ type: 'Point', coordinates: [1, 2] })).toThrow();
    expect(() => parseBoundary({ type: 'FeatureCollection', features: [] })).toThrow();
    expect(() => parseBoundary('nope')).toThrow();
  });
});

describe('isPointInBoundary', () => {
  const polys = parseBoundary(geojson);

  it('is true inside the outer ring and on a separate island', () => {
    expect(isPointInBoundary({ lat: 12, lng: 72 }, polys, 0)).toBe(true);
    expect(isPointInBoundary({ lat: 10.5, lng: 90.5 }, polys, 0)).toBe(true);
  });

  it('is false outside every polygon and inside a hole', () => {
    expect(isPointInBoundary({ lat: 25, lng: 85 }, polys, 0)).toBe(false);
    expect(isPointInBoundary({ lat: 15, lng: 75 }, polys, 0)).toBe(false);
  });

  it('accepts a point just outside the border within the tolerance', () => {
    // ~1.1 km east of the lng=80 edge at lat 15.
    const nearBorder = { lat: 15, lng: 80.01 };
    expect(isPointInBoundary(nearBorder, polys, 0)).toBe(false);
    expect(isPointInBoundary(nearBorder, polys, 2000)).toBe(true);
    expect(isPointInBoundary({ lat: 15, lng: 80.1 }, polys, 2000)).toBe(false);
  });
});

describe('findLocationOutsideCountry', () => {
  let dir: string;
  beforeEach(() => {
    resetCountryBoundaryForTests();
    dir = mkdtempSync(join(tmpdir(), 'boundary-'));
    cfg.geocodingConfig.country = 'IN';
    cfg.geocodingConfig.boundary_path = join(dir, 'IN.geojson');
    writeFileSync(cfg.geocodingConfig.boundary_path, JSON.stringify(geojson));
  });

  it('returns the first point outside the country', async () => {
    const outside = { lat: 23.81, lng: 90.41 };
    await expect(
      findLocationOutsideCountry([{ lat: 12, lng: 72 }, outside]),
    ).resolves.toEqual(outside);
  });

  it('applies the 15 km border tolerance', async () => {
    // At lat 15, 1° of longitude is ~107.5 km: lng 80.12 is ~13 km east of the
    // lng=80 edge, lng 80.16 is ~17 km east.
    const within = { lat: 15, lng: 80.12 };
    const beyond = { lat: 15, lng: 80.16 };
    await expect(findLocationOutsideCountry([within])).resolves.toBeNull();
    await expect(findLocationOutsideCountry([within, beyond])).resolves.toEqual(beyond);
  });

  it('returns null when every point is inside', async () => {
    await expect(findLocationOutsideCountry([{ lat: 12, lng: 72 }])).resolves.toBeNull();
  });

  it('skips the check when no country is configured', async () => {
    cfg.geocodingConfig.country = undefined;
    await expect(findLocationOutsideCountry([{ lat: 23.81, lng: 90.41 }])).resolves.toBeNull();
  });

  it('fails open (skips the check) when the boundary file is missing or invalid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    cfg.geocodingConfig.boundary_path = join(dir, 'missing.geojson');
    await expect(findLocationOutsideCountry([{ lat: 23.81, lng: 90.41 }])).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loads the file once', async () => {
    const first = await loadCountryBoundary();
    expect(first).not.toBeNull();
    await expect(loadCountryBoundary()).resolves.toBe(first);
  });
});
