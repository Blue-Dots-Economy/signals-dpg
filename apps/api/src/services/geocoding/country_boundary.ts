import { readFile } from 'node:fs/promises';
import { geocodingConfig } from '@/config';
import type { Coordinates } from './geo_resolver';

/**
 * Country-boundary check for CALLER-SUPPLIED coordinates (#789).
 *
 * Restricting the geocoders (#787/#788) does not cover a point the caller
 * resolved itself — an aggregator bulk `geo_location` cell, an autocomplete
 * pick, a partner integration — because those skip geocoding and are stored
 * as-is (#506). This holds them to the configured country instead.
 *
 * The boundary is a GeoJSON file delivered by ConfigMap
 * (`GEOCODING_BOUNDARY_PATH`), not bundled, so a deployment chooses its source
 * map (Natural Earth's India point-of-view file by default; the Survey of India
 * outline if required) without an image rebuild. A bounding box is deliberately
 * NOT used: India's contains Bangladesh, the case this exists to catch.
 */

/** `[lng, lat]`, GeoJSON order. */
type Position = [number, number];
/** A polygon: outer ring first, then holes. */
type Polygon = Position[][];
export type BoundaryPolygons = Polygon[];

/**
 * How far outside the drawn border a point may sit and still count as inside.
 * The boundary file is simplified, and a real village on the border must not be
 * rejected because the line was smoothed past it. ~2 km is far larger than the
 * simplification error and far smaller than any cross-border mix-up.
 */
export const BOUNDARY_TOLERANCE_METERS = 2000;

const METERS_PER_DEGREE_LAT = 110_540;
const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111_320;

function isRing(v: unknown): v is Position[] {
  return (
    Array.isArray(v) &&
    v.length >= 4 &&
    v.every(
      (p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
    )
  );
}

function asPolygon(v: unknown): Polygon {
  if (!Array.isArray(v) || v.length === 0 || !v.every(isRing)) {
    throw new Error('boundary: invalid polygon rings');
  }
  return v as Polygon;
}

function geometryPolygons(geometry: unknown): Polygon[] {
  const g = geometry as { type?: string; coordinates?: unknown };
  if (g?.type === 'Polygon') return [asPolygon(g.coordinates)];
  if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    return g.coordinates.map(asPolygon);
  }
  throw new Error(`boundary: unsupported geometry type ${String(g?.type)}`);
}

/**
 * Pure: GeoJSON → polygons. Accepts a FeatureCollection, a Feature, or a bare
 * Polygon/MultiPolygon. Throws on anything that yields no polygon, so a wrong
 * file is caught at load rather than silently accepting every point.
 */
export function parseBoundary(geojson: unknown): BoundaryPolygons {
  const g = geojson as { type?: string; features?: unknown[]; geometry?: unknown };
  let polygons: Polygon[];
  if (g?.type === 'FeatureCollection' && Array.isArray(g.features)) {
    polygons = g.features.flatMap((f) => geometryPolygons((f as { geometry?: unknown }).geometry));
  } else if (g?.type === 'Feature') {
    polygons = geometryPolygons(g.geometry);
  } else {
    polygons = geometryPolygons(g);
  }
  if (polygons.length === 0) throw new Error('boundary: no polygons');
  return polygons;
}

/** Ray-casting point-in-ring, in degrees. */
function inRing(lng: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Shortest distance in metres from the point to the ring's edges. Uses a local
 * equirectangular projection around the point, which is accurate to well under
 * a percent at the few-km scale the tolerance needs.
 */
function distanceToRingMeters(lng: number, lat: number, ring: Position[]): number {
  const kx = METERS_PER_DEGREE_LNG_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);
  const ky = METERS_PER_DEGREE_LAT;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j]![0] - lng) * kx;
    const ay = (ring[j]![1] - lat) * ky;
    const bx = (ring[i]![0] - lng) * kx;
    const by = (ring[i]![1] - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

/**
 * Pure: is the point inside the boundary (any polygon's outer ring, not in one
 * of its holes), or within `toleranceMeters` of an outer edge?
 */
export function isPointInBoundary(
  point: Coordinates,
  polygons: BoundaryPolygons,
  toleranceMeters: number,
): boolean {
  const { lat, lng } = point;
  for (const [outer, ...holes] of polygons) {
    if (inRing(lng, lat, outer!) && !holes.some((h) => inRing(lng, lat, h))) return true;
  }
  if (toleranceMeters <= 0) return false;
  return polygons.some(([outer]) => distanceToRingMeters(lng, lat, outer!) <= toleranceMeters);
}

let boundaryPromise: Promise<BoundaryPolygons | null> | null = null;

/**
 * The configured boundary, read once and memoised. Resolves `null` — the check
 * is skipped — when no country is set, no path is set, or the file can't be
 * read or parsed. That is fail-open on purpose: a missing ConfigMap is a config
 * gap, and blocking every location write over it would take registrations down
 * with it. It warns, and `app.ts` loads this at boot so the warning lands in
 * deploy logs rather than on the first write.
 */
export function loadCountryBoundary(): Promise<BoundaryPolygons | null> {
  if (boundaryPromise) return boundaryPromise;
  const { country, boundary_path } = geocodingConfig;
  boundaryPromise = (async () => {
    if (!country) return null;
    if (!boundary_path) {
      console.warn(
        `geocoding: GEOCODING_COUNTRY=${country} but GEOCODING_BOUNDARY_PATH is unset — supplied coordinates are not checked against the country`,
      );
      return null;
    }
    try {
      const polygons = parseBoundary(JSON.parse(await readFile(boundary_path, 'utf8')));
      console.info(
        `geocoding: loaded ${country} boundary (${polygons.length} polygons) from ${boundary_path}`,
      );
      return polygons;
    } catch (err) {
      console.warn(
        `geocoding: could not load the ${country} boundary from ${boundary_path} (${String(err)}) — supplied coordinates are not checked against the country`,
      );
      return null;
    }
  })();
  return boundaryPromise;
}

/** Test seam: forget the memoised boundary so a test can load a new config. */
export function resetCountryBoundaryForTests(): void {
  boundaryPromise = null;
}

/**
 * The first point that falls outside the configured country, or `null` when
 * every point is inside or the check is not configured.
 */
export async function findLocationOutsideCountry<T extends Coordinates>(
  points: readonly T[],
): Promise<T | null> {
  if (points.length === 0 || !geocodingConfig.country) return null;
  const polygons = await loadCountryBoundary();
  if (!polygons) return null;
  return points.find((p) => !isPointInBoundary(p, polygons, BOUNDARY_TOLERANCE_METERS)) ?? null;
}
