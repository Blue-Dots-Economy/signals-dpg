/**
 * Splits a longitude range into chunks narrower than 180°.
 *
 * PostGIS geography resolves an envelope wider than 180° as the short way
 * round the globe, the complement of the intended box, so a world-zoom
 * viewport matched nothing. Each chunk stays a plain geography polygon the
 * GiST index can serve. 120° keeps clear of the boundary.
 */
export const MAX_ENVELOPE_LNG_SPAN_DEGREES = 120;

export function splitLngRange(
  minLng: number,
  maxLng: number,
  maxSpan: number = MAX_ENVELOPE_LNG_SPAN_DEGREES,
): Array<{ minLng: number; maxLng: number }> {
  const span = maxLng - minLng;
  if (span <= maxSpan) return [{ minLng, maxLng }];
  const parts = Math.ceil(span / maxSpan);
  const step = span / parts;
  return Array.from({ length: parts }, (_, i) => ({
    minLng: minLng + i * step,
    maxLng: i === parts - 1 ? maxLng : minLng + (i + 1) * step,
  }));
}
