/**
 * Geo distance utilities: haversine formula and nearest-location finder.
 * Pure utility functions for proximity-based item sorting.
 */

import type { LatLng } from './types';

/** Earth's mean radius in metres (WGS84). */
const EARTH_RADIUS_METRES = 6_371_000;

/** Convert degrees to radians. */
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points using the haversine formula.
 * Both points are specified in decimal degrees (WGS84).
 *
 * @param a - First point {lat, lng} in degrees.
 * @param b - Second point {lat, lng} in degrees.
 * @returns Distance in metres.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);

  const sinDeltaLat2 = Math.sin(deltaLat / 2);
  const sinDeltaLng2 = Math.sin(deltaLng / 2);

  const haversineA =
    sinDeltaLat2 * sinDeltaLat2 +
    Math.cos(lat1) * Math.cos(lat2) * sinDeltaLng2 * sinDeltaLng2;

  const c = 2 * Math.asin(Math.sqrt(haversineA));

  return EARTH_RADIUS_METRES * c;
}

/**
 * Distance in metres from `from` to the nearest of an item's locations.
 * Returns Infinity when `locations` is empty or undefined, so items without
 * a location sort last when used as a sort key.
 *
 * @param from - User's location {lat, lng}.
 * @param locations - Array of item locations (each with lat, lng, and optional label).
 * @returns Distance in metres to the nearest location, or Infinity if no locations.
 */
export function nearestDistanceMeters(
  from: LatLng,
  locations: ReadonlyArray<{ lat: number; lng: number; label?: string }> | undefined
): number {
  if (!locations || locations.length === 0) {
    return Infinity;
  }

  let minDistance = Infinity;
  for (const location of locations) {
    const distance = haversineMeters(from, location);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
}
