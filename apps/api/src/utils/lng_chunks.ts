/**
 * Split a longitude range into chunks each narrower than 180°.
 *
 * Why: the bbox predicates below build `ST_MakeEnvelope(...)::geography`.
 * PostGIS geography treats polygon edges as geodesics and resolves a
 * longitude span WIDER THAN 180° as the short way round the globe — i.e. the
 * COMPLEMENT of the box the caller meant. A world-zoom viewport therefore
 * matched nothing at all: 179.9° of span returned every marker, 180.1°
 * returned zero, with no error to notice (#XXX).
 *
 * Splitting keeps every envelope unambiguous, and each chunk is still a
 * plain geography polygon, so the GiST index (`item_search_geo_gist`) still
 * serves the `&&` pre-filter on each one. Chunks are capped at 120° rather
 * than just under 180° to stay clear of the boundary.
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
