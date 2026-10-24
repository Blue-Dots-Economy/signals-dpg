/**
 * Deterministic geo-jitter for private (PII) locations: offsets a coordinate by
 * a pseudo-random distance in [minMeters, maxMeters] at a pseudo-random bearing.
 *
 * The seed derives from the coordinate, so the same true location always maps
 * to the same point: re-saving never drifts the pin, and repeated snapshots
 * cannot be averaged back to the truth. The seed is keyed with a server secret
 * because the jittered point is public and the algorithm is open source;
 * without it the true coordinate could be brute-forced.
 * Design: docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
 */

import { createHmac } from 'node:crypto';

export interface JitterableCoord {
  lat: number;
  lng: number;
  label?: string;
}

/** Metres per degree of latitude (constant); longitude scales by cos(lat). */
const METERS_PER_DEGREE = 111_320;

/**
 * mulberry32 PRNG: deterministic uniform [0, 1) sequence from a 32-bit seed.
 *
 * `| 0` and `>>> 0` force 32-bit wraparound and are part of the algorithm; do
 * not replace them with `Math.trunc`, which changes the output stream and so
 * moves every stored jittered pin.
 */
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
  secret: Buffer | string,
): JitterableCoord {
  // Seed = first 4 bytes of HMAC(secret, "location-jitter:<lat5>,<lng5>").
  // The prefix domain-separates this use of the key from PII-blob encryption.
  const seed = createHmac('sha256', secret)
    .update(`location-jitter:${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`)
    .digest()
    .readUInt32BE(0);
  const rng = mulberry32(seed);
  const u = rng();
  const v = rng();

  // Uniform over the annulus area, not biased toward the inner radius.
  const dist = Math.sqrt(u * (maxMeters ** 2 - minMeters ** 2) + minMeters ** 2);
  const theta = 2 * Math.PI * v;

  const dLat = (dist * Math.cos(theta)) / METERS_PER_DEGREE;
  const latRad = (coord.lat * Math.PI) / 180;
  // Equirectangular longitude scaling divides by cos(lat); undefined at the
  // poles (lat = ±90), which is out of domain for any real street address.
  const dLng = (dist * Math.sin(theta)) / (METERS_PER_DEGREE * Math.cos(latRad));

  const out: JitterableCoord = { lat: coord.lat + dLat, lng: coord.lng + dLng };
  if (coord.label !== undefined) out.label = coord.label;
  return out;
}
