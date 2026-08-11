// Pure geo-distance helpers used by the cross-instance merge (#203 §4.4).
// No DB, no Fastify, no side effects — only inputs in, numbers out.

/** Mean earth radius in meters, matching apps/api/src/services/geocoding conventions. */
const EARTH_RADIUS_METERS = 6371000;

export interface LatLng {
  lat: number;
  lng: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two points, in meters. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Minimum haversine distance from `center` to any of `locations`.
 * Returns `Infinity` when `locations` is empty, so rows with no location
 * data sort last in a nearest-first ordering.
 */
export function nearestLocationMeters(
  center: LatLng,
  locations: LatLng[]
): number {
  let min = Infinity;
  for (const loc of locations) {
    const d = haversineMeters(center, loc);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Minimum haversine distance between two items' location sets (#439 Task 7 —
 * my-actions distance sort/display). Unlike `nearestLocationMeters` above
 * (single center vs. an array, used by the cross-instance merge),
 * `item_locations` on BOTH sides of an action can carry more than one point,
 * so this checks every pairwise combination. Returns `null` — never
 * `Infinity` — when either side has no locations, so a caller can
 * distinguish "distance unknown" (render nothing) from a real, very-large
 * distance, and so it never becomes a NULLS-FIRST sort key by accident.
 */
export function nearestDistanceMeters(
  as: readonly LatLng[] | null | undefined,
  bs: readonly LatLng[] | null | undefined
): number | null {
  if (!as || as.length === 0 || !bs || bs.length === 0) return null;

  let min = Infinity;
  for (const a of as) {
    for (const b of bs) {
      const d = haversineMeters(a, b);
      if (d < min) min = d;
    }
  }
  return min;
}
