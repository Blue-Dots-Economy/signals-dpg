import type { LatLng } from './types';

/** Earth's mean radius in metres (WGS84). */
const EARTH_RADIUS_METRES = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres between two WGS84 points in degrees. */
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
 * Distance in metres from `from` to the nearest of an item's locations, or
 * Infinity when there are none so such items sort last.
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
