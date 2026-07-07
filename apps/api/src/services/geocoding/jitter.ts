/**
 * Deterministic geo-jitter for PRIVATE (PII) locations: offsets a coordinate by
 * a pseudo-random distance in [minMeters, maxMeters] at a pseudo-random bearing,
 * so the stored point is near — but never exactly on — the true location.
 *
 * Determinism (seed derived from the coordinate itself) is deliberate: the same
 * true location always maps to the same jittered point, so re-saving a profile
 * never drifts the pin and an observer cannot average repeated snapshots back to
 * the truth. See docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
 */

export interface JitterableCoord {
  lat: number;
  lng: number;
  label?: string;
}

/** Metres per degree of latitude (constant); longitude scales by cos(lat). */
const METERS_PER_DEGREE = 111_320;

/** FNV-1a hash of a string to an unsigned 32-bit int. */
function hashStringToUint32(input: string): number {
  let h = 2_166_136_261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic uniform [0, 1) sequence from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function jitterCoordinate(
  coord: JitterableCoord,
  minMeters: number,
  maxMeters: number,
): JitterableCoord {
  // Seed from the true point rounded to ~1 m so the same address is stable.
  const seed = hashStringToUint32(`${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`);
  const rng = mulberry32(seed);
  const u = rng();
  const v = rng();

  // Uniform over the annulus AREA (not biased toward the inner radius).
  const dist = Math.sqrt(u * (maxMeters ** 2 - minMeters ** 2) + minMeters ** 2);
  const theta = 2 * Math.PI * v;

  const dLat = (dist * Math.cos(theta)) / METERS_PER_DEGREE;
  const latRad = (coord.lat * Math.PI) / 180;
  const dLng = (dist * Math.sin(theta)) / (METERS_PER_DEGREE * Math.cos(latRad));

  const out: JitterableCoord = { lat: coord.lat + dLat, lng: coord.lng + dLng };
  if (coord.label !== undefined) out.label = coord.label;
  return out;
}
